import { config, packageOf } from './config.js';
import { buildSystemPrompt, buildDailyPrompt, DAILY_OUTPUT_SCHEMA } from './prompts.js';
import {
  appendHistory, getRecentHistory, getImageState, startImageState, recordImageEdit,
  getUsage, incrementUsage,
} from './db.js';
import { generateVideo } from './visual.js';
import { createImage, editImage } from './openai_images.js';
import { sendText, sendVisual, sendFileByUrl } from './greenapi.js';
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
      'For story/carousel visuals: the Hebrew copy (hook/message/CTA) must be rendered INSIDE the image — ' +
      'include the exact Hebrew text in the prompt as text to display, with brand-appropriate typography. ' +
      'Do not send that copy as a separate message afterwards; the image with the embedded text is the deliverable. ' +
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

// Builds the shared tool executor for a client. Handles monthly quotas,
// image/video generation, edit limits, and sending to WhatsApp.
// Returns a plain string result for the LLM. `sent` (optional) is mutated so the
// caller knows media was delivered even when the model adds no closing text.
function makeExecuteTool(client, sent = {}) {
  const pkg = packageOf(client);
  return async (name, input) => {
    try {
      if (name === 'generate_image') {
        const state = getImageState(client.phone);
        const isEdit = input.mode === 'edit' && state?.last_response_id;

        if (isEdit && state.edit_count >= config.maxImageEdits) {
          return `Edit limit reached: this image has already been edited ${config.maxImageEdits} times, which is the maximum. Do NOT keep editing. Tell the client (in Hebrew, warmly) that this image reached its edit limit, and they can ask for a NEW image to keep going.`;
        }

        // Monthly quota: only NEW images count (edits are capped separately above).
        if (!isEdit) {
          const usage = getUsage(client.phone);
          if (usage.images >= pkg.imagesPerMonth) {
            return `Monthly image quota reached: the client used all ${pkg.imagesPerMonth} images in their "${pkg.label}" package this month. Do NOT generate. Tell the client (in Hebrew, warmly) that their monthly image quota is used up and it renews at the start of next month, or they can upgrade their package.`;
          }
        }

        // Progress feedback: image generation takes ~20-60s, so tell the client
        // we're on it before starting (best-effort; a failure must not block generation).
        await sendText(
          client.phone,
          isEdit ? 'רגע, מעדכנת את התמונה… ✏️' : 'מכינה לך את התמונה… 🎨 (בערך חצי דקה)'
        ).catch(() => {});

        let result, note;
        if (isEdit) {
          result = await editImage(state.last_response_id, input.prompt);
          recordImageEdit(client.phone, result.responseId);
          const used = state.edit_count + 1;
          note = `Edited the previous image (edit ${used} of ${config.maxImageEdits}) and sent it. ${config.maxImageEdits - used} edits left on this image.`;
        } else {
          result = await createImage(input.prompt);
          startImageState(client.phone, result.responseId, client.profile);
          incrementUsage(client.phone, 'image');
          note = input.mode === 'edit'
            ? 'No previous image to edit, so created a new one and sent it to the client.'
            : 'Image generated and sent to the client on WhatsApp successfully.';
        }
        await sendVisual(client.phone, { type: 'base64', data: result.b64 }, { caption: input.caption || '' });
        sent.media = true;
        return note;
      }

      if (name === 'generate_video') {
        if (pkg.videosPerMonth <= 0) {
          return `Videos are not included in the client's "${pkg.label}" package. Do NOT generate. Tell the client (in Hebrew, warmly) that video is available in the premium package and they can upgrade.`;
        }
        const usage = getUsage(client.phone);
        if (usage.videos >= pkg.videosPerMonth) {
          return `Monthly video quota reached: the client used all ${pkg.videosPerMonth} videos this month. Do NOT generate. Tell the client (in Hebrew, warmly) that their monthly video quota is used up and it renews at the start of next month.`;
        }

        await sendText(
          client.phone,
          'מפיקה את הסרטון… 🎬 זה לוקח דקה-שתיים, שולחת ברגע שהוא מוכן'
        ).catch(() => {});
        const videoUrl = await generateVideo(input.prompt);
        await sendFileByUrl(client.phone, videoUrl, { fileName: 'aura.mp4', caption: input.caption || '' });
        incrementUsage(client.phone, 'video');
        sent.media = true;
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

  const sent = { media: false };
  const reply = await runConversation({
    system: buildSystemPrompt(client),
    history: getRecentHistory(client.phone).map((m) => ({ role: m.role, content: m.content })),
    tools: TOOLS,
    executeTool: makeExecuteTool(client, sent),
  });

  if (reply) {
    appendHistory(client.phone, 'assistant', reply);
  } else if (sent.media) {
    // Keep the media delivery in history so the next turn knows an image/video
    // was already sent (important for the create-vs-edit decision).
    appendHistory(client.phone, 'assistant', '[נשלחה מדיה ללקוח, בלי טקסט נוסף]');
  }
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
