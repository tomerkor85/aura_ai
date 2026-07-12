import { config } from './config.js';

// ============================================================================
// Visual engine — BytePlus (Seedream images + Seedance video), OpenAI fallback.
// BytePlus ModelArk (Ark) API shape:
//   Images (sync):  POST {base}/images/generations
//   Video (async):  POST {base}/contents/generations/tasks  -> task id
//                   GET  {base}/contents/generations/tasks/{id}  (poll until done)
// Model IDs come from your BytePlus console and are set via env (see .env.example).
// ============================================================================

function byteplusHeaders() {
  if (!config.byteplus.apiKey) {
    throw new Error('BYTEPLUS_API_KEY is not set - visual generation unavailable');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.byteplus.apiKey}`,
  };
}

// --- Images ---------------------------------------------------------------

async function seedreamImage(prompt, { size = '1024x1792' } = {}) {
  const res = await fetch(`${config.byteplus.baseUrl}/images/generations`, {
    method: 'POST',
    headers: byteplusHeaders(),
    body: JSON.stringify({
      model: config.byteplus.seedreamModel,
      prompt,
      size,
      response_format: 'url',
      watermark: false,
    }),
  });
  if (!res.ok) throw new Error(`Seedream failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const item = data.data?.[0];
  if (item?.b64_json) return { type: 'base64', data: item.b64_json };
  if (item?.url) return { type: 'url', url: item.url };
  throw new Error('Seedream returned no image');
}

async function openaiImage(prompt, { size = '1024x1792' } = {}) {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({ model: config.openai.imageModel, prompt, size, n: 1 }),
  });
  if (!res.ok) throw new Error(`OpenAI image failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const item = data.data?.[0];
  if (item?.b64_json) return { type: 'base64', data: item.b64_json };
  if (item?.url) return { type: 'url', url: item.url };
  throw new Error('OpenAI returned no image');
}

// Returns { type: 'base64', data } or { type: 'url', url }.
export async function generateImage(prompt, opts = {}) {
  if (config.imageProvider === 'openai') return openaiImage(prompt, opts);
  try {
    return await seedreamImage(prompt, opts);
  } catch (err) {
    if (config.openai.apiKey) {
      console.warn('[visual] Seedream failed, falling back to OpenAI:', err.message);
      return openaiImage(prompt, opts);
    }
    throw err;
  }
}

// --- Video (Seedance, async) ----------------------------------------------

// Returns a video URL. Polls the async task until it completes.
export async function generateVideo(prompt, { ratio = '9:16', pollMs = 4000, maxWaitMs = 180000 } = {}) {
  const createRes = await fetch(`${config.byteplus.baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: byteplusHeaders(),
    body: JSON.stringify({
      model: config.byteplus.seedanceModel,
      // Seedance reads ratio/params from the prompt via --params; keep it simple and explicit.
      content: [{ type: 'text', text: `${prompt} --ratio ${ratio}` }],
    }),
  });
  if (!createRes.ok) throw new Error(`Seedance create failed: ${createRes.status} ${await createRes.text()}`);
  const { id } = await createRes.json();
  if (!id) throw new Error('Seedance returned no task id');

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const pollRes = await fetch(`${config.byteplus.baseUrl}/contents/generations/tasks/${id}`, {
      headers: byteplusHeaders(),
    });
    if (!pollRes.ok) throw new Error(`Seedance poll failed: ${pollRes.status} ${await pollRes.text()}`);
    const task = await pollRes.json();
    const status = task.status;
    if (status === 'succeeded') {
      const url = task.content?.video_url || task.content?.[0]?.video_url;
      if (!url) throw new Error('Seedance succeeded but no video_url');
      return url;
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(`Seedance task ${status}: ${task.error?.message || 'unknown'}`);
    }
    // else: queued / running -> keep polling
  }
  throw new Error('Seedance timed out');
}
