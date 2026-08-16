import { config } from './config.js';

// ============================================================================
// Visual engine — BytePlus Seedance video. (Images live in openai_images.js
// via the Responses API, which supports conversational editing.)
// BytePlus ModelArk (Ark) API shape:
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!createRes.ok) throw new Error(`Seedance create failed: ${createRes.status} ${await createRes.text()}`);
  const { id } = await createRes.json();
  if (!id) throw new Error('Seedance returned no task id');

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const pollRes = await fetch(`${config.byteplus.baseUrl}/contents/generations/tasks/${id}`, {
      headers: byteplusHeaders(),
      signal: AbortSignal.timeout(30_000),
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
