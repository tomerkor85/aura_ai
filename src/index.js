import { config, validateConfig } from './config.js';
import { getClientByPhone } from './db.js';
import { receiveNotification, deleteNotification, parseIncoming, sendText, readChat } from './greenapi.js';
import { handleChatMessage } from './agent.js';
import { startAdmin } from './admin.js';
import { sendStatusNoticeOnce, enforceExpiry, sweepExpiredSubscriptions } from './subscription.js';
import { scheduleBackups } from './backup.js';
import { logger, snip } from './logger.js';

const missing = validateConfig();
if (missing.length) {
  logger.error('boot', `Missing environment variables: ${missing.join(', ')}`);
  logger.error('boot', 'Copy .env.example to .env and fill in the keys.');
  process.exit(1);
}

logger.info('boot', 'AURA is starting...');
logger.info('boot', `text=${config.textProvider} (${config.openai.textModel} / bulk ${config.openai.bulkModel} / fallback ${config.openai.premiumModel}) | images=${config.openai.responsesModel} | conversational mode`);

// Start the admin panel (client management UI) alongside the agent.
startAdmin();

// --- Incoming message loop (Green API polling) ---
let polling = true;

// Per-client work queues: messages from the SAME client run in order, but one
// client's slow job (e.g. a 2-minute video) never blocks other clients.
const queues = new Map(); // phone -> tail promise of that client's chain

function enqueueForPhone(phone, job) {
  const tail = (queues.get(phone) || Promise.resolve()).then(job).catch((err) => {
    logger.error('queue', `job failed for ${phone}`, err);
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
      logger.debug('poll', `notification: ${body?.typeWebhook || 'unknown'}`);
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
      logger.error('poll', 'poll loop error', err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function handleIncoming({ phone, text, nonText }) {
  logger.info('in', `${phone}: ${nonText ? '[media message]' : snip(text, 120)}`);
  const client = getClientByPhone(phone);
  if (!client) {
    logger.info('in', `unknown number ${phone} - ignoring`);
    return;
  }
  // Automatic expiry: subscription end passed -> suspend now and tell them once.
  if (await enforceExpiry(client)) return;
  if (client.status !== 'active') {
    await sendStatusNoticeOnce(client);
    return;
  }

  const rate = rateLimitState(phone);
  if (rate !== 'ok') {
    logger.warn('rate', `${phone} exceeded ${RATE_LIMIT.max} msgs/min (${rate})`);
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
    logger.info('agent', `generating reply for ${phone} (provider: ${config.textProvider})`);
    const reply = await handleChatMessage(client, text);
    if (reply) {
      await sendText(phone, reply);
      logger.info('out', `${phone}: ${snip(reply, 120)}`);
    } else {
      logger.info('agent', `no text reply for ${phone} (media may have been sent via a tool)`);
    }
  } catch (err) {
    logger.error('agent', `error for ${phone}`, err);
    await sendText(phone, 'אופס, נתקלתי בתקלה רגעית. נסו לשלוח שוב בעוד רגע 🙏');
  }
}

// AURA is conversational: it responds when a client messages, and content can be
// generated on demand from the admin panel ("Generate now"). No scheduled sends
// of content — the expiry sweep below is subscription maintenance only:
// every minute, suspend clients whose subscription ended and notify them once.
const EXPIRY_SWEEP_MS = 60_000;
pollLoop();
sweepExpiredSubscriptions();
setInterval(sweepExpiredSubscriptions, EXPIRY_SWEEP_MS);

// Automatic customer-DB backups: a fresh snapshot ~30s after boot, then daily,
// written to <DATA_DIR>/backups on the persistent Volume (see src/backup.js).
scheduleBackups();

process.on('SIGINT', () => {
  polling = false;
  logger.info('boot', 'AURA stopped.');
  process.exit(0);
});

// Last-resort safety net: log crashes with full stack instead of dying silently.
process.on('uncaughtException', (err) => {
  logger.error('fatal', 'uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('fatal', 'unhandledRejection', reason instanceof Error ? reason : String(reason));
});
