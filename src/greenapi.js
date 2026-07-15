import { config } from './config.js';

const BASE = 'https://api.green-api.com';

function url(method) {
  const { idInstance, token } = config.greenApi;
  return `${BASE}/waInstance${idInstance}/${method}/${token}`;
}

async function post(method, body) {
  const res = await fetch(url(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Green API ${method} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export function phoneToChatId(phone) {
  return `${phone}@c.us`;
}

export function chatIdToPhone(chatId) {
  return (chatId || '').replace(/@c\.us$/, '');
}

export async function sendText(phone, message) {
  return post('sendMessage', { chatId: phoneToChatId(phone), message });
}

// Returns the instance auth state, e.g. { stateInstance: 'authorized' }
export async function getStateInstance() {
  const res = await fetch(url('getStateInstance'), { method: 'GET', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Green API getStateInstance failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Instance settings — the `incomingWebhook` flag must be 'yes' for incoming
// messages to be delivered to receiveNotification (our polling loop).
export async function getSettings() {
  const res = await fetch(url('getSettings'), { method: 'GET', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Green API getSettings failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function setSettings(settings) {
  return post('setSettings', settings);
}

// Mark the whole chat as read (blue ticks) — immediate "I saw your message"
// feedback for the client while the agent works on a reply.
export async function readChat(phone) {
  return post('readChat', { chatId: phoneToChatId(phone) });
}

// Send an image from a base64 payload via multipart upload
export async function sendImageBase64(phone, base64Data, { fileName = 'aura.png', caption = '' } = {}) {
  const buffer = Buffer.from(base64Data, 'base64');
  const form = new FormData();
  form.append('chatId', phoneToChatId(phone));
  form.append('caption', caption);
  form.append('file', new Blob([buffer], { type: 'image/png' }), fileName);

  const res = await fetch(url('sendFileByUpload'), { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`Green API sendFileByUpload failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Send a media file (image/video) from a public URL
export async function sendFileByUrl(phone, urlFile, { fileName = 'aura', caption = '' } = {}) {
  return post('sendFileByUrl', {
    chatId: phoneToChatId(phone),
    urlFile,
    fileName,
    caption,
  });
}

// Unified helper: accepts a visual result {type:'base64'|'url'} and sends it.
export async function sendVisual(phone, visual, { fileName = 'aura.png', caption = '' } = {}) {
  if (visual.type === 'base64') {
    return sendImageBase64(phone, visual.data, { fileName, caption });
  }
  return sendFileByUrl(phone, visual.url, { fileName, caption });
}

// --- Incoming messages via polling (works locally, no public URL needed) ---

export async function receiveNotification() {
  const res = await fetch(url('receiveNotification'), { method: 'GET', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`Green API receiveNotification failed: ${res.status}`);
  }
  const text = await res.text();
  if (!text || text === 'null') return null;
  return JSON.parse(text);
}

export async function deleteNotification(receiptId) {
  const res = await fetch(`${url('deleteNotification')}/${receiptId}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Green API deleteNotification failed: ${res.status}`);
  }
}

// Message types the client actively sent but we can't process as text —
// they deserve a polite "text only for now" reply instead of silence.
const MEDIA_TYPES = new Set([
  'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
]);

// Extract {phone, text} from an incoming notification body.
// Returns {phone, nonText: true} for media messages (image/voice/video/document),
// or null for anything else (groups, reactions, service events).
export function parseIncoming(body) {
  if (body?.typeWebhook !== 'incomingMessageReceived') return null;
  const chatId = body?.senderData?.chatId || '';
  if (!chatId.endsWith('@c.us')) return null; // ignore groups
  const md = body.messageData || {};
  const text =
    md.textMessageData?.textMessage ??
    md.extendedTextMessageData?.text ??
    null;
  if (text) return { phone: chatIdToPhone(chatId), text };
  if (MEDIA_TYPES.has(md.typeMessage)) return { phone: chatIdToPhone(chatId), nonText: true };
  return null;
}
