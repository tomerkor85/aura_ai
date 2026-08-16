// Bounded, persistent delivery queue engine.
//
// - Per-type worker pools (story/carousel/reel) with independent concurrency, so
//   slow reels never starve fast stories. WhatsApp sends are additionally bounded
//   by a global semaphore + daily cap inside the processor's send gate.
// - dispatch() claims due jobs and runs them; each worker re-dispatches on finish,
//   so the pool self-feeds without any Promise.all over clients/assets.
// - Gated by isEnabled() (global master switch + admin pause) and by per-type/
//   WhatsApp DAILY caps; when off/capped, nothing is claimed and jobs stay queued.
// - Exactly-once: the processor flips the row to `sending` right before each Green
//   API call. A caught error means nothing was delivered -> safe retry (carousels
//   resume from the last delivered slide). A crash/timeout in `sending` is left for
//   reap() to mark `unknown_delivery_state` (never silently delivered/resent).
import * as D from './deliveries.js';
import * as realMedia from './media-cache.js';

const TYPES = ['story', 'carousel', 'reel'];

function nextUtcMidnight(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 5));
}

export function createQueue({
  media = realMedia, db, config, clock, logger, processItem, isEnabled = () => true, limiter }) {
  const active = { story: 0, carousel: 0, reel: 0 };
  let workerSeq = 0;
  const cap = limiter || { canClaim: () => true, recordGeneration() {}, canSend: () => true, recordSend() {} };

  const backoff = (retry) => Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** retry);

  function dispatch() {
    if (!isEnabled()) return;          // global master switch / admin pause
    if (!cap.canSend()) return;        // no WhatsApp budget today -> keep everything queued
    for (const type of TYPES) {
      const limit = config.concurrency[type] || 1;
      while (active[type] < limit && cap.canClaim(type, active[type])) {
        const item = D.claimNext(db, type, clock.now(), config.leaseMs, `w${++workerSeq}`);
        if (!item) break;
        active[type]++;
        runItem(item).finally(() => { active[type]--; dispatch(); });
      }
    }
  }

  async function runItem(item) {
    const startedMs = clock.now().getTime();
    const markSending = () => {
      if (!D.markSending(db, item.id, clock.now(), config.leaseMs)) {
        const e = new Error('lost claim before send'); e.retryable = true; throw e;
      }
      // Generation completed and we're entering the send phase — count it once.
      cap.recordGeneration(item.content_type);
    };
    try {
      const res = await processItem(item, {
        markSending,
        setProgress: (n) => D.setProgress(db, item.id, n),
        setPayload: (json) => D.setPayload(db, item.id, json),
      });
      D.markDelivered(db, item.id, clock.now(), res && res.wa_message_id);
      media.dropItemMedia(item.id); // delivered: the cached asset has done its job
      const secs = Math.round((clock.now().getTime() - startedMs) / 1000);
      logger.info('queue', `delivered ${item.content_type} #${item.id} ${item.phone} in ${secs}s`);
    } catch (err) {
      handleError(item, err);
    }
  }

  function handleError(item, err) {
    const msg = err && err.message ? err.message : String(err);
    // Throttled (daily cap hit mid-flight): keep queued for tomorrow WITHOUT
    // burning a retry and without consuming quota.
    if (err && err.throttled) {
      D.deferUntil(db, item.id, nextUtcMidnight(clock.now()), msg);
      logger.info('queue', `throttled ${item.content_type} #${item.id} ${item.phone}: ${msg}`);
      return;
    }
    if (err && err.terminal) {
      D.markFailed(db, item.id, msg);
      media.dropItemMedia(item.id);
      logger.warn('queue', `terminal ${item.content_type} #${item.id} ${item.phone}: ${msg}`);
      return;
    }
    if (item.retry_count < config.maxRetries) {
      const next = new Date(clock.now().getTime() + backoff(item.retry_count));
      D.retryLater(db, item.id, next, msg);
      logger.warn('queue', `retry ${item.content_type} #${item.id} ${item.phone} (attempt ${item.retry_count + 1}/${config.maxRetries}) after: ${msg}`);
    } else {
      D.markFailed(db, item.id, `max retries reached: ${msg}`);
      media.dropItemMedia(item.id);
      logger.error('queue', `gave up ${item.content_type} #${item.id} ${item.phone}: ${msg}`);
    }
  }

  return {
    dispatch,
    reap: () => D.reapStuck(db, clock.now(), { maxRetries: config.maxRetries, backoffMs: backoff }),
    active: () => ({ ...active }),
    stats: () => D.queueStats(db),
    concurrency: config.concurrency,
    backoff,
  };
}
