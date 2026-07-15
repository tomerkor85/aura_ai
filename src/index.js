import { config, validateConfig } from './config.js';
import { getClientByPhone, markStatusNotified } from './db.js';
import { receiveNotification, deleteNotification, parseIncoming, sendText, readChat } from './greenapi.js';
import { handleChatMessage } from './agent.js';
import { startAdmin } from './admin.js';

const missing = validateConfig();
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the keys.');
  process.exit(1);
}

console.log('AURA is starting...');
console.log(`Model: ${config.claudeModel} | conversational mode (no scheduled sends)`);

// Start the admin panel (client management UI) alongside the agent.
startAdmin();

// --- Incoming message loop (Green API polling) ---
let polling = true;

// Per-client work queues: messages from the SAME client run in order, but one
// client's slow job (e.g. a 2-minute video) never blocks other clients.
const queues = new Map(); // phone -> tail promise of that client's chain

function enqueueForPhone(phone, job) {
  const tail = (queues.get(phone) || Promise.resolve()).then(job).catch((err) => {
    console.error(`[queue] job failed for ${phone}:`, err.message);
  });
  queues.set(phone, tail);
  tail.finally(() => {
    if (queues.get(phone) === tail) queues.delete(phone); // drained
  });
}

// Per-client rate limit: cap paid LLM calls from a runaway (or hijacked) number.
const RATE_LIMIT = { max: 8, windowMs: 60_000 };
const messageTimes = new Map(); // phone -> [timestamps]

// Returns 'ok' | 'notify' (first excess message) | 'silent' (keep dropping)
function rateLimitState(phone) {
  const now = Date.now();
  const times = (messageTimes.get(phone) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  times.push(now);
  messageTimes.set(phone, times);
  if (times.length <= RATE_LIMIT.max) return 'ok';
  return times.length === RATE_LIMIT.max + 1 ? 'notify' : 'silent';
}

async function pollLoop() {
  while (polling) {
    try {
      const notification = await receiveNotification();
      if (!notification) continue; // long-poll returned empty; loop again

      const { receiptId, body } = notification;
      console.log(`[poll] notification: ${body?.typeWebhook || 'unknown'}`);
      try {
        const incoming = parseIncoming(body);
        if (incoming) {
          // Don't await: the queue keeps same-client order, the loop keeps polling.
          enqueueForPhone(incoming.phone, () => handleIncoming(incoming));
        }
      } finally {
        await deleteNotification(receiptId);
      }
    } catch (err) {
      console.error('[poll] error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function handleIncoming({ phone, text, nonText }) {
  console.log(`[in] ${phone}: ${nonText ? '[media message]' : text.slice(0, 80)}`);
  const client = getClientByPhone(phone);
  if (!client) {
    console.log(`[in] Unknown number ${phone} - ignoring`);
    return;
  }
  if (client.status !== 'active') {
    await sendStatusNoticeOnce(client);
    return;
  }

  const rate = rateLimitState(phone);
  if (rate !== 'ok') {
    console.warn(`[rate] ${phone} exceeded ${RATE_LIMIT.max} msgs/min (${rate})`);
    if (rate === 'notify') {
      await sendText(phone, 'וואו, הרבה הודעות ברצף 🙂 תנו לי דקה להתאפס ונמשיך').catch(() => {});
    }
    return;
  }

  // Blue ticks right away so the client knows the message was seen (best-effort).
  readChat(phone).catch(() => {});

  // Voice notes / images / documents: we only understand text for now — say so
  // instead of leaving the client on read.
  if (nonText) {
    await sendText(phone, 'כרגע אני יודעת לקרוא רק הודעות טקסט 🙏 כתבו לי במילים מה תרצו ואטפל בזה').catch(() => {});
    return;
  }

  try {
    console.log(`[agent] generating reply for ${phone} (provider: ${config.textProvider})...`);
    const reply = await handleChatMessage(client, text);
    if (reply) {
      await sendText(phone, reply);
      console.log(`[out] ${phone}: ${reply.slice(0, 80)}`);
    } else {
      console.log(`[agent] no text reply (media may have been sent via a tool).`);
    }
  } catch (err) {
    console.error(`[agent] error for ${phone}:`, err.stack || err.message);
    await sendText(phone, 'אופס, נתקלתי בתקלה רגעית. נסו לשלוח שוב בעוד רגע 🙏');
  }
}

// One-time notice for suspended/canceled subscriptions: sent on the first message
// after the status change, then silence until the status changes again.
async function sendStatusNoticeOnce(client) {
  if (client.notified_status === client.status) return; // already told them
  const contact = config.supportEmail
    ? `במייל: ${config.supportEmail}`
    : 'במייל של מנהלת השירות';

  let notice;
  if (client.status === 'suspended') {
    notice = `היי ${client.name}, המנוי שלך מושהה כרגע, כנראה בגלל רכישה או חידוש שלא הושלמו. כדי להפעיל את השירות מחדש צרו איתנו קשר ${contact}`;
  } else if (client.status === 'canceled') {
    notice = `היי ${client.name}, החשבון הזה נסגר לצמיתות. ליצירת חשבון חדש פנו אלינו ${contact}`;
  } else {
    return; // unknown non-active status — stay silent
  }

  try {
    await sendText(client.phone, notice);
    markStatusNotified(client.phone, client.status);
    console.log(`[status] one-time ${client.status} notice sent to ${client.phone}`);
  } catch (err) {
    // Don't mark as notified if the send failed — retry on their next message.
    console.error(`[status] notice failed for ${client.phone}:`, err.message);
  }
}

// AURA is conversational: it responds when a client messages, and content can be
// generated on demand from the admin panel ("Generate now"). No scheduled sends.
pollLoop();

process.on('SIGINT', () => {
  polling = false;
  console.log('\nAURA stopped.');
  process.exit(0);
});
