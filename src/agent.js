import { config } from './config.js';
import { buildSystemPrompt, buildDailyPrompt, DAILY_OUTPUT_SCHEMA } from './prompts.js';
import { appendHistory, getRecentHistory, getImageState, startImageState, recordImageEdit } from './db.js';
import { generateVideo } from './visual.js';
import { createImage, editImage } from './openai_images.js';
import { sendVisual, sendFileByUrl } from './greenapi.js';
import { runConversation, structuredContent } from './llm/index.js';

// Provider-neutral tool definitions (`parameters` = JSON schema). Each adapter
// converts these to its own tool format.
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
    parameters: {
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
  },
  {
    name: 'generate_video',
    description:
      'Generate a short branded product/marketing video for the client (Seedance). ' +
      'Call this when the client asks for a video, a reel, or animated product content. ' +
      'The prompt must be in English and MUST reflect the brand dominant colors, style and mood from the profile. ' +
      'Video generation takes ~1-2 minutes.',
    parameters: {
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
  },
];

// Builds the shared tool executor for a client. Handles image/video generation,
// edit limits, and sending to WhatsApp. Returns a plain string result for the LLM.
function makeExecuteTool(client) {
  return async (name, input) => {
    try {
      if (name === 'generate_image') {
        const state = getImageState(client.phone);
        const isEdit = input.mode === 'edit' && state?.last_response_id;

        if (isEdit && state.edit_count >= config.maxImageEdits) {
          return `Edit limit reached: this image has already been edited ${config.maxImageEdits} times, which is the maximum. Do NOT keep editing. Tell the client (in Hebrew, warmly) that this image reached its edit limit, and they can ask for a NEW image to keep going.`;
        }

        let result, note;
        if (isEdit) {
          result = await editImage(state.last_response_id, input.prompt);
          recordImageEdit(client.phone, result.responseId);
          const used = state.edit_count + 1;
          note = `Edited the previous image (edit ${used} of ${config.maxImageEdits}) and sent it. ${config.maxImageEdits - used} edits left on this image.`;
        } else {
          result = await createImage(input.prompt);
          startImageState(client.phone, result.responseId, client.profile);
          note = input.mode === 'edit'
            ? 'No previous image to edit, so created a new one and sent it to the client.'
            : 'Image generated and sent to the client on WhatsApp successfully.';
        }
        await sendVisual(client.phone, { type: 'base64', data: result.b64 }, { caption: input.caption || '' });
        return note;
      }

      if (name === 'generate_video') {
        const videoUrl = await generateVideo(input.prompt);
        await sendFileByUrl(client.phone, videoUrl, { fileName: 'aura.mp4', caption: input.caption || '' });
        return 'Video generated and sent to the client on WhatsApp successfully.';
      }

      return `Unknown tool: ${name}`;
    } catch (err) {
      return `${name} failed: ${err.message}`;
    }
  };
}

// Handle a free-form chat message from a client via the selected text provider.
export async function handleChatMessage(client, userText) {
  appendHistory(client.phone, 'user', userText);

  const reply = await runConversation({
    system: buildSystemPrompt(client),
    history: getRecentHistory(client.phone).map((m) => ({ role: m.role, content: m.content })),
    tools: TOOLS,
    executeTool: makeExecuteTool(client),
  });

  if (reply) appendHistory(client.phone, 'assistant', reply);
  return reply;
}

// Generate the structured content package for a client (used by "Generate now").
export async function generateDailyContent(client, { stories, carousel }) {
  return structuredContent({
    system: buildSystemPrompt(client),
    prompt: buildDailyPrompt(client, { stories, carousel }),
    schema: DAILY_OUTPUT_SCHEMA,
  });
}
