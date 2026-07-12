import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt, buildDailyPrompt, DAILY_OUTPUT_SCHEMA } from './prompts.js';
import { appendHistory, getRecentHistory, getImageState, setImageState } from './db.js';
import { generateVideo } from './visual.js';
import { createImage, editImage } from './openai_images.js';
import { sendVisual, sendFileByUrl } from './greenapi.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate OR edit a branded marketing image for the client. ' +
      'Use mode="create" for a NEW image (story visual, product shot, carousel slide). ' +
      'Use mode="edit" when the client wants to change the LAST image they received ' +
      '(e.g. "make it bigger", "blue brand background", "make it happier", "add a hat") — ' +
      'this edits the previous image while keeping the same subject and brand look. ' +
      'The prompt must be in English. For create: a full scene including brand dominant colors and visual style. ' +
      'For edit: a precise English instruction that PRESERVES the same subject, style and brand colors and changes only what was asked. ' +
      'If it is unclear whether the client wants a new image or an edit, do NOT call this tool — ask them first.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['create', 'edit'],
          description: 'create = brand-new image; edit = modify the last generated image',
        },
        prompt: {
          type: 'string',
          description: 'English prompt. create: full branded scene. edit: instruction preserving subject/style/colors.',
        },
        caption: {
          type: 'string',
          description: 'Short Hebrew caption to send with the image on WhatsApp',
        },
      },
      required: ['mode', 'prompt', 'caption'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'generate_video',
    description:
      'Generate a short branded product/marketing video for the client (Seedance). ' +
      'Call this when the client asks for a video, a reel, or animated product content. ' +
      'The prompt must be in English and MUST reflect the brand dominant colors, style and mood from the profile. ' +
      'Video generation takes ~1-2 minutes.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'English video-generation prompt: scene, motion, brand colors, style, mood',
        },
        caption: {
          type: 'string',
          description: 'Short Hebrew caption to send with the video on WhatsApp',
        },
      },
      required: ['prompt', 'caption'],
      additionalProperties: false,
    },
    strict: true,
  },
];

function textOf(response) {
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Handle a free-form chat message from a client. Runs a manual tool loop:
// when Claude calls generate_image we create the image and send it immediately.
export async function handleChatMessage(client, userText) {
  appendHistory(client.phone, 'user', userText);

  const system = [
    { type: 'text', text: buildSystemPrompt(client), cache_control: { type: 'ephemeral' } },
  ];
  const messages = getRecentHistory(client.phone).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system,
    tools: TOOLS,
    messages,
  });

  // Manual agentic loop for image generation
  let guard = 0;
  while (response.stop_reason === 'tool_use' && guard < 5) {
    guard += 1;
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const tu of toolUses) {
      try {
        if (tu.name === 'generate_image') {
          const state = getImageState(client.phone);
          let result, note;
          if (tu.input.mode === 'edit' && state?.last_response_id) {
            // Follow-up edit of the last image, keeping OpenAI conversation context.
            result = await editImage(state.last_response_id, tu.input.prompt);
            setImageState(client.phone, result.responseId, null); // preserve original brand snapshot
            note = 'Edited the previous image and sent it to the client on WhatsApp.';
          } else {
            // New image. Snapshot the brand profile so future edits stay consistent.
            result = await createImage(tu.input.prompt);
            setImageState(client.phone, result.responseId, client.profile);
            note = tu.input.mode === 'edit'
              ? 'No previous image to edit, so created a new one and sent it to the client.'
              : 'Image generated and sent to the client on WhatsApp successfully.';
          }
          await sendVisual(client.phone, { type: 'base64', data: result.b64 }, { caption: tu.input.caption || '' });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: note });
        } else if (tu.name === 'generate_video') {
          const videoUrl = await generateVideo(tu.input.prompt);
          await sendFileByUrl(client.phone, videoUrl, {
            fileName: 'aura.mp4',
            caption: tu.input.caption || '',
          });
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'Video generated and sent to the client on WhatsApp successfully.',
          });
        } else {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Unknown tool: ${tu.name}`,
            is_error: true,
          });
        }
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `${tu.name} failed: ${err.message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: results });

    response = await anthropic.messages.create({
      model: config.claudeModel,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system,
      tools: TOOLS,
      messages,
    });
  }

  const reply = textOf(response);
  if (reply) appendHistory(client.phone, 'assistant', reply);
  return reply;
}

// Generate the structured daily content package for a client.
export async function generateDailyContent(client, { stories, carousel }) {
  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: 8000,
    system: [
      { type: 'text', text: buildSystemPrompt(client), cache_control: { type: 'ephemeral' } },
    ],
    output_config: {
      format: { type: 'json_schema', schema: DAILY_OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: buildDailyPrompt(client, { stories, carousel }) }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Daily content generation returned no text');
  return JSON.parse(text);
}
