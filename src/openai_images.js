import { config } from './config.js';

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

async function call(body) {
  const res = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI Responses failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { b64: extractImage(data), responseId: data.id };
}

export async function createImage(prompt) {
  return call({
    model: config.openai.responsesModel,
    input: prompt,
    tools: [{ type: 'image_generation' }],
    store: true,
  });
}

export async function editImage(previousResponseId, editPrompt) {
  return call({
    model: config.openai.responsesModel,
    previous_response_id: previousResponseId,
    input: editPrompt,
    tools: [{ type: 'image_generation' }],
    store: true,
  });
}
