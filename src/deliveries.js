// Data-access layer for the delivery queue + quota adjustments.
// Every function takes `db` as its first argument so the same code runs against
// the live singleton DB (admin/scheduler) and throwaway test DBs.
//
// All state transitions are guarded on the expected current status so overlapping
// dispatcher ticks / restarts can never double-process the same row.

const iso = (d) => d.toISOString();

// --- enqueue -----------------------------------------------------------------

// Insert due items as 'scheduled' if not already present (idempotent on key).
export function enqueueItems(db, items) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO content_deliveries
      (phone, content_type, cycle_start, scheduled_date, sequence_number, idempotency_key, status)
    VALUES (@phone, @content_type, @cycle_start, @scheduled_date, @sequence_number, @idempotency_key, 'scheduled')
  `);
  let inserted = 0;
  const tx = db.transaction((rows) => { for (const r of rows) inserted += stmt.run(r).changes; });
  tx(items);
  return inserted;
}

// Record items of a PAST day that were never delivered as 'missed' (visibility
// only — never processed, never consumes quota). INSERT OR IGNORE means an
// already-delivered/queued row for the same key is left untouched.
export function markMissedItems(db, items) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO content_deliveries
      (phone, content_type, cycle_start, scheduled_date, sequence_number, idempotency_key, status)
    VALUES (@phone, @content_type, @cycle_start, @scheduled_date, @sequence_number, @idempotency_key, 'missed')
  `);
  let n = 0;
  const tx = db.transaction((rows) => { for (const r of rows) n += stmt.run(r).changes; });
  tx(items);
  return n;
}

// Seal off a day's items for a client that only became eligible partway through it
// (just created, or just opted in). The rows are written as 'skipped', which no
// worker ever claims — claimNext() only looks at 'scheduled' — and which quota
// never counts, since only 'delivered' does. The next scheduler tick then finds
// the keys already present and its INSERT OR IGNORE enqueues nothing, so delivery
// starts cleanly at the client's NEXT send time instead of firing on signup.
export function seedSkippedItems(db, items) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO content_deliveries
      (phone, content_type, cycle_start, scheduled_date, sequence_number, idempotency_key, status)
    VALUES (@phone, @content_type, @cycle_start, @scheduled_date, @sequence_number, @idempotency_key, 'skipped')
  `);
  let n = 0;
  const tx = db.transaction((rows) => { for (const r of rows) n += stmt.run(r).changes; });
  tx(items);
  return n;
}

// --- claim / transitions -----------------------------------------------------

// Atomically claim the next due 'scheduled' item of a type. Returns the row or null.
export function claimNext(db, type, now, leaseMs, workerId) {
  const nowISO = iso(now);
  const leaseISO = iso(new Date(now.getTime() + leaseMs));
  const claim = db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM content_deliveries
      WHERE content_type = ? AND status = 'scheduled'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY id LIMIT 1
    `).get(type, nowISO);
    if (!row) return null;
    const upd = db.prepare(`
      UPDATE content_deliveries
      SET status = 'generating', worker_id = ?, lease_expires_at = ?
      WHERE id = ? AND status = 'scheduled'
    `).run(workerId, leaseISO, row.id);
    if (upd.changes !== 1) return null; // lost the race
    return db.prepare('SELECT * FROM content_deliveries WHERE id = ?').get(row.id);
  });
  return claim();
}

// generating -> sending, right before the WhatsApp call (renews lease).
export function markSending(db, id, now, leaseMs) {
  const leaseISO = iso(new Date(now.getTime() + leaseMs));
  return db.prepare(`
    UPDATE content_deliveries
    SET status = 'sending', generated_at = COALESCE(generated_at, ?), sending_at = ?, lease_expires_at = ?
    WHERE id = ? AND status = 'generating'
  `).run(iso(now), iso(now), leaseISO, id).changes === 1;
}

export function setProgress(db, id, n) {
  db.prepare('UPDATE content_deliveries SET progress = ? WHERE id = ?').run(n, id);
}

export function setPayload(db, id, json) {
  db.prepare('UPDATE content_deliveries SET payload = ? WHERE id = ?').run(json, id);
}

// sending -> delivered (records message id; clears lease). Consumes quota implicitly.
export function markDelivered(db, id, now, waMessageId) {
  db.prepare(`
    UPDATE content_deliveries
    SET status = 'delivered', delivered_at = ?, wa_message_id = ?, lease_expires_at = NULL, worker_id = NULL, failure_reason = NULL
    WHERE id = ?
  `).run(iso(now), waMessageId || null, id);
}

// Transient failure -> back to 'scheduled' with backoff (safe to retry; nothing delivered).
export function retryLater(db, id, nextAttempt, reason) {
  db.prepare(`
    UPDATE content_deliveries
    SET status = 'scheduled', retry_count = retry_count + 1, next_attempt_at = ?,
        failure_reason = ?, lease_expires_at = NULL, worker_id = NULL
    WHERE id = ?
  `).run(iso(nextAttempt), reason || null, id);
}

// Capped/throttled: keep the job queued until a later time WITHOUT incrementing
// retry_count and WITHOUT consuming quota (used when a daily provider cap is hit).
export function deferUntil(db, id, when, reason) {
  db.prepare(`
    UPDATE content_deliveries
    SET status = 'scheduled', next_attempt_at = ?, failure_reason = ?, lease_expires_at = NULL, worker_id = NULL
    WHERE id = ?
  `).run(iso(when), reason || null, id);
}

// Terminal failure (max retries, or unsafe-to-retry partial/crash-during-send).
export function markFailed(db, id, reason) {
  db.prepare(`
    UPDATE content_deliveries
    SET status = 'failed', failure_reason = ?, lease_expires_at = NULL, worker_id = NULL
    WHERE id = ?
  `).run(reason || null, id);
}

// --- stuck-job reaper --------------------------------------------------------

// Manual admin retry: move a failed / unknown / missed row back to 'scheduled'
// (fresh attempt). Used for unknown_delivery_state after human review.
export function retryManual(db, id) {
  return db.prepare(`
    UPDATE content_deliveries
    SET status = 'scheduled', retry_count = 0, next_attempt_at = NULL,
        lease_expires_at = NULL, worker_id = NULL, failure_reason = NULL
    WHERE id = ? AND status IN ('failed','unknown_delivery_state','missed','skipped')
  `).run(id).changes;
}

// Reclaim expired leases.
//   `generating` past lease  -> retryable (nothing was sent; safe to redo).
//   `sending`    past lease  -> UNKNOWN: a crash/timeout after entering send. We
//                              cannot tell if it delivered, so it becomes
//                              'unknown_delivery_state' for MANUAL review — never
//                              silently delivered or auto-resent.
export function reapStuck(db, now, { maxRetries, backoffMs }) {
  const nowISO = iso(now);
  let requeued = 0, failed = 0, unknown = 0;

  const stuckGen = db.prepare(`
    SELECT id, retry_count FROM content_deliveries
    WHERE status = 'generating' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
  `).all(nowISO);
  for (const r of stuckGen) {
    if (r.retry_count < maxRetries) {
      const next = new Date(now.getTime() + backoffMs(r.retry_count));
      retryLater(db, r.id, next, 'lease expired while generating');
      requeued++;
    } else {
      markFailed(db, r.id, 'stuck in generating, max retries reached');
      failed++;
    }
  }

  const stuckSend = db.prepare(`
    SELECT id FROM content_deliveries
    WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
  `).all(nowISO);
  for (const r of stuckSend) {
    db.prepare(`
      UPDATE content_deliveries
      SET status = 'unknown_delivery_state',
          failure_reason = 'interrupted during send — needs manual review (may or may not have delivered)',
          lease_expires_at = NULL, worker_id = NULL
      WHERE id = ?
    `).run(r.id);
    unknown++;
  }
  return { requeued, failed, unknown };
}

// --- quota reads -------------------------------------------------------------

const countDelivered = (db, phone, type, cycleStart) => db.prepare(
  "SELECT COUNT(*) c FROM content_deliveries WHERE phone=? AND content_type=? AND cycle_start=? AND status='delivered'"
).get(phone, type, cycleStart).c;

const sumAdj = (db, phone, type, cycleStart) => db.prepare(
  'SELECT COALESCE(SUM(delta),0) s FROM quota_adjustments WHERE phone=? AND content_type=? AND cycle_start=?'
).get(phone, type, cycleStart).s;

// Delivered counts for the current cycles (story/carousel weekly, reel 14-day).
export function deliveredCounts(db, phone, weeklyStart, c14Start) {
  return {
    story: countDelivered(db, phone, 'story', weeklyStart),
    carousel: countDelivered(db, phone, 'carousel', weeklyStart),
    reel: countDelivered(db, phone, 'reel', c14Start),
  };
}

export function adjustmentTotals(db, phone, weeklyStart, c14Start) {
  return {
    story: sumAdj(db, phone, 'story', weeklyStart),
    carousel: sumAdj(db, phone, 'carousel', weeklyStart),
    reel: sumAdj(db, phone, 'reel', c14Start),
  };
}

// --- adjustments + admin listings -------------------------------------------

export function addAdjustment(db, { phone, content_type, cycle_start, delta, reason, created_by }) {
  return db.prepare(`
    INSERT INTO quota_adjustments (phone, content_type, cycle_start, delta, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(phone, content_type, cycle_start, delta, reason || null, created_by || null).lastInsertRowid;
}

export const listAdjustments = (db, phone, limit = 20) =>
  db.prepare('SELECT * FROM quota_adjustments WHERE phone=? ORDER BY id DESC LIMIT ?').all(phone, limit);

export const listRecentDeliveries = (db, phone, limit = 20) =>
  db.prepare('SELECT * FROM content_deliveries WHERE phone=? ORDER BY id DESC LIMIT ?').all(phone, limit);

export const listRecentFailures = (db, phone, limit = 20) =>
  db.prepare("SELECT * FROM content_deliveries WHERE phone=? AND status IN ('failed','missed','unknown_delivery_state') ORDER BY id DESC LIMIT ?").all(phone, limit);

// Queue depth by status/type — for logging + admin visibility.
export function queueStats(db) {
  const rows = db.prepare('SELECT content_type, status, COUNT(*) c FROM content_deliveries GROUP BY content_type, status').all();
  const out = {};
  for (const r of rows) { (out[r.content_type] ||= {})[r.status] = r.c; }
  return out;
}

// --- global settings (persisted runtime flags, e.g. admin pause) -------------

export const getSetting = (db, key) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null);
export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

// --- provider daily safety counters ------------------------------------------

export function incrProvider(db, day, kind, n = 1) {
  db.prepare('INSERT INTO provider_usage (day,kind,count) VALUES (?,?,?) ON CONFLICT(day,kind) DO UPDATE SET count=count+?')
    .run(day, kind, n, n);
}
export const providerCount = (db, day, kind) =>
  (db.prepare('SELECT count FROM provider_usage WHERE day=? AND kind=?').get(day, kind)?.count || 0);

// --- queue health (admin dashboard) ------------------------------------------

export function statusCounts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM content_deliveries GROUP BY status').all();
  const out = {};
  for (const r of rows) out[r.status] = r.c;
  return out;
}

export const oldestQueued = (db) =>
  (db.prepare("SELECT scheduled_at FROM content_deliveries WHERE status='scheduled' ORDER BY id ASC LIMIT 1").get()?.scheduled_at || null);

// Average processing seconds (generated_at -> delivered_at) per content type.
export function avgDurationByType(db) {
  const rows = db.prepare(`
    SELECT content_type,
           AVG((julianday(delivered_at) - julianday(COALESCE(generated_at, sending_at, scheduled_at))) * 86400) s,
           COUNT(*) c
    FROM content_deliveries WHERE status='delivered' AND delivered_at IS NOT NULL
    GROUP BY content_type
  `).all();
  const out = {};
  for (const r of rows) out[r.content_type] = { avgSeconds: r.s != null ? Math.round(r.s) : null, count: r.c };
  return out;
}
