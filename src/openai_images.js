import { config } from './config.js';
import { postJsonWithRetry } from './http.js';
import { logger, snip } from './logger.js';

const log = logger.child('images');

// ============================================================================
// Conversational, editable images via the OpenAI Responses API.
//   - createImage(prompt)                 -> first generation
//   - editImage(previousResponseId, txt)  -> follow-up edit that keeps context
// Returns { b64, responseId }. Store responseId per client to chain edits
// ("make it bigger", "blue brand background") onto the last generated image.
// ============================================================================

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

function headers() {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set - image generation unavailable');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openai.apiKey}`,
  };
}

function extractImage(data) {
  const call = (data.output || []).find((o) => o.type === 'image_generation_call');
  if (!call?.result) throw new Error('OpenAI Responses returned no image');
  return call.result; // base64 PNG
}

async function call(kind, body) {
  const t0 = Date.now();
  log.info(`${kind} start model=${body.model}`, snip(body.input, 200));
  const data = await postJsonWithRetry(RESPONSES_URL, {
    headers: headers(),
    body,
    // Image generation can legitimately take a minute or two.
    timeoutMs: 180_000,
    label: 'OpenAI Responses',
  });
  const result = { b64: extractImage(data), responseId: data.id };
  log.info(`${kind} done in ${Math.round((Date.now() - t0) / 1000)}s`, { responseId: data.id, bytes: result.b64.length });
  return result;
}

export async function createImage(prompt) {
  return call('create', {
    model: config.openai.responsesModel,
    input: prompt,
    tools: [{ type: 'image_generation' }],
    store: true,
  });
}

export async function editImage(previousResponseId, editPrompt) {
  return call('edit', {
    model: config.openai.responsesModel,
    previous_response_id: previousResponseId,
    input: editPrompt,
    tools: [{ type: 'image_generation' }],
    store: true,
  });
}
