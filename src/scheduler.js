// The daily scheduler. Runs at least once per minute and does ONLY cheap work:
// for each ACTIVE client whose local send time has passed, enqueue today's due
// items (fast INSERT OR IGNORE), reap stuck jobs, then kick the worker pools.
// Generation/sending happens asynchronously in the queue — the tick never blocks.
//
// Missed-delivery policy: today's items are enqueued whenever the tick runs after
// the send time (so a service that was down at 07:30 recovers the CURRENT day on
// the next tick). Yesterday's never-delivered items are recorded as 'missed' for
// visibility only — never processed, never consume quota. Older days are ignored.
import * as Q from './quota.js';
import { enqueueItems, markMissedItems, creditMissedItems } from './deliveries.js';

export function createScheduler({
  db, queue, clock, config, logger, listActiveClients,
  isSchedulingActive = () => true,
  // Called with (client, credited) after a lost day is credited back. Injected so
  // tests can assert on it without touching WhatsApp; a failure here must never
  // roll back the credit, which is already committed.
  onMissedDay = null,
}) {
  let timer = null;

  function runTick() {
    const now = clock.now();
    const reaped = queue.reap(); // always safe: reclaims stuck leases, never sends

    // Global master switch OR admin pause: enqueue nothing new. In-flight/queued
    // jobs are untouched; the queue's own gate stops it from claiming more.
    if (!isSchedulingActive()) {
      queue.dispatch();
      if (reaped.requeued || reaped.failed || reaped.unknown) {
        logger.info('sched', `paused/disabled — reap requeued=${reaped.requeued} failed=${reaped.failed} unknown=${reaped.unknown}`);
      }
      return { enqueued: 0, missed: 0, reaped, active: false };
    }

    let enqueued = 0;
    let missed = 0;

    for (const client of listActiveClients()) {
      if (client.status !== 'active') continue;        // suspended/canceled never receive content
      if (!client.scheduled_content_enabled) continue;  // per-client opt-in (default off)
      const tz = Q.clientTz(client);
      const todayStr = Q.localDateStr(now, tz);
      const regStr = Q.regLocalDate(client);

      // Today: enqueue once the local send time has passed (also recovers a missed 07:30).
      if (Q.daysBetween(regStr, todayStr) >= 0 && Q.isSendDue(client, now)) {
        enqueued += enqueueItems(db, Q.dueItems(client, todayStr));
      }
      // Yesterday: whatever was never delivered can no longer be sent — the slot is
      // gone. Record it, credit the entitlement back, and tell the client why.
      const yStr = Q.addDays(todayStr, -1);
      if (Q.daysBetween(regStr, yStr) >= 0) {
        const lost = markMissedItems(db, Q.dueItems(client, yStr));
        if (lost.length) {
          missed += lost.length;
          const credited = creditMissedItems(db, client.phone, lost);
          logger.info('sched', `${client.phone} lost ${yStr} — credited ${JSON.stringify(credited)}`);
          if (onMissedDay) {
            Promise.resolve(onMissedDay(client, credited))
              .catch((err) => logger.error('sched', `missed-day notice failed for ${client.phone}`, err));
          }
        }
      }
    }

    if (enqueued || missed || reaped.requeued || reaped.failed || reaped.unknown) {
      const a = queue.active();
      logger.info('sched', `enqueued=${enqueued} missed=${missed} requeued=${reaped.requeued} reapFailed=${reaped.failed} unknown=${reaped.unknown} active=${a.story}/${a.carousel}/${a.reel} (story/carousel/reel)`);
    }
    queue.dispatch();
    return { enqueued, missed, reaped, active: true };
  }

  function tick() {
    try { return runTick(); }
    catch (err) { logger.error('sched', 'tick failed', err); return null; }
  }

  return {
    tick, // exposed for tests
    start() {
      tick();
      timer = setInterval(tick, config.tickMs);
      timer.unref && timer.unref();
      logger.info('sched', `scheduler started — tick ${config.tickMs}ms; concurrency story=${config.concurrency.story} carousel=${config.concurrency.carousel} reel=${config.concurrency.reel} whatsapp=${config.concurrency.whatsapp}`);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
