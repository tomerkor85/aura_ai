import { config, scheduleConfig, validateConfig } from './config.js';
import { db, getClientByPhone, listActiveClients } from './db.js';
import { receiveNotification, deleteNotification, parseIncoming, sendText, sendVisual, sendFileByUrl, readChat } from './greenapi.js';
import { handleChatMessage, generateScheduledStory, generateCarouselPlan, renderBrandImage, generateScheduledReel } from './agent.js';
import { startAdmin } from './admin.js';
import { sendStatusNoticeOnce, enforceExpiry, sweepExpiredSubscriptions } from './subscription.js';
import { scheduleBackups } from './backup.js';
import { realClock } from './clock.js';
import { createSemaphore } from './semaphore.js';
import { createQueue } from './queue.js';
import { createProviderLimiter } from './limiter.js';
import { makeProcessItem } from './content-delivery.js';
import { createScheduler } from './scheduler.js';
import { getSetting, setSetting } from './deliveries.js';
import { balanceReplyFor } from './quota-balance.js';
import { logger, snip } from './logger.js';

const missing = validateConfig();
if (missing.length) {
  logger.error('boot', `Missing environment variables: ${missing.join(', ')}`);
  logger.error('boot', 'Copy .env.example to .env and fill in the keys.');
  process.exit(1);
}

logger.info('boot', 'AURA is starting...');
logger.info('boot', `text=${config.textProvider} (${config.openai.textModel} / bulk ${config.openai.bulkModel} / fallback ${config.openai.premiumModel}) | images=${config.openai.responsesModel} | conversational mode`);

// --- Scheduled subscription content: persistent queue + bounded worker pools ---
// Built here so the admin panel can expose live queue health + the pause control.
// The whole feature is OFF unless SCHEDULED_CONTENT_ENABLED=true AND not paused
// AND the individual client has scheduled_content_enabled=true.
const limiter = createProviderLimiter({ db, limits: scheduleConfig.dailyLimits, clock: realClock });
const isSchedulingActive = () => scheduleConfig.enabled && getSetting(db, 'scheduled_paused') !== 'true';

const waGate = createSemaphore(scheduleConfig.concurrency.whatsapp);
// Every WhatsApp send passes the global semaphore AND the daily send cap.
const sendGate = (fn) => waGate.run(async () => {
  if (!limiter.canSend()) { const e = new Error('daily WhatsApp send limit reached'); e.throttled = true; throw e; }
  const r = await fn();
  limiter.recordSend();
  return r;
});

const processItem = makeProcessItem({
  getClient: getClientByPhone,
  generators: { story: generateScheduledStory, carouselPlan: generateCarouselPlan, reel: generateScheduledReel },
  renderImage: renderBrandImage,
  senders: { sendText, sendVisual, sendFileByUrl },
  sendGate,
  clock: realClock,
  logger,
  genTimeoutMs: scheduleConfig.itemTimeoutMs,
});
const deliveryQueue = createQueue({ db, config: scheduleConfig, clock: realClock, logger, processItem, isEnabled: isSchedulingActive, limiter });
const scheduler = createScheduler({
  db, queue: deliveryQueue, clock: realClock, config: scheduleConfig, logger, listActiveClients, isSchedulingActive,
});

// Controls surfaced to the admin panel (global pause/resume + queue health).
const schedulerControls = {
  globalEnabled: () => scheduleConfig.enabled,
  isPaused: () => getSetting(db, 'scheduled_paused') === 'true',
  pause: () => setSetting(db, 'scheduled_paused', 'true'),
  resume: () => setSetting(db, 'scheduled_paused', 'false'),
  isActive: isSchedulingActive,
  active: () => deliveryQueue.active(),
  concurrency: scheduleConfig.concurrency,
  limiterSnapshot: () => limiter.snapshot(),
};

// Start the admin panel (client management UI) alongside the agent.
startAdmin(schedulerControls);

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
    return; // unknown-user behavior preserved — never expose any customer info
  }

  // Customer-facing "יתרה" balance command. Runs BEFORE the AI chat / expiry /
  // status early-returns so every registered customer (active/suspended/canceled/
  // expired) can read their balance. Pure read: no LLM, no generation, no quota or
  // usage change. Always resolved by the sender's own phone (no cross-customer access).
  if (!nonText) {
    const balanceMsg = balanceReplyFor(db, client, text);
    if (balanceMsg) {
      readChat(phone).catch(() => {});
      await sendText(phone, balanceMsg);
      logger.info('balance', `${phone}: sent scheduled-content balance`);
      return;
    }
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

// Start the scheduled-content loop (queue + workers were built above). It stays
// idle until SCHEDULED_CONTENT_ENABLED=true, not paused, and a client opts in.
scheduler.start();

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
