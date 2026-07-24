// Idempotent, additive schema for the scheduled-content feature.
// Applied to the live singleton DB (db.js) AND to throwaway test DBs, so the
// queue/scheduler can be exercised without touching /data/aura.db.
//
// SAFETY: only CREATE TABLE IF NOT EXISTS and guarded ALTER ... ADD COLUMN.
// Nothing here drops, resets, truncates, or recreates any table. No element of
// the scheduler is ever destroyed on startup.

export function applyScheduleSchema(db) {
  db.exec(`
    -- The persistent delivery queue. One row per scheduled content item; the row
    -- IS the job. State: scheduled -> generating -> sending -> delivered
    --                                             \\-> failed | (missed, never enqueued for work)
    CREATE TABLE IF NOT EXISTS content_deliveries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      phone            TEXT NOT NULL,
      content_type     TEXT NOT NULL,                 -- story | carousel | reel
      cycle_start      TEXT NOT NULL,                 -- local date of this item's cycle start
      scheduled_date   TEXT NOT NULL,                 -- local YYYY-MM-DD the item was due
      sequence_number  INTEGER NOT NULL,              -- 1..N within (type, day)
      idempotency_key  TEXT NOT NULL UNIQUE,          -- phone:type:scheduled_date:seq
      status           TEXT NOT NULL DEFAULT 'scheduled',
      retry_count      INTEGER NOT NULL DEFAULT 0,
      progress         INTEGER NOT NULL DEFAULT 0,    -- carousel: send-steps already delivered
      payload          TEXT,                          -- carousel plan (prompts/text) for slide-level resume
      next_attempt_at  TEXT,                          -- backoff gate (ISO)
      lease_expires_at TEXT,                          -- stuck-job detection (ISO)
      worker_id        TEXT,
      failure_reason   TEXT,
      wa_message_id    TEXT,
      scheduled_at     TEXT DEFAULT (datetime('now')),
      generated_at     TEXT,
      sending_at       TEXT,
      delivered_at     TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deliv_phone_date ON content_deliveries(phone, scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_deliv_status ON content_deliveries(status, content_type);
    CREATE INDEX IF NOT EXISTS idx_deliv_cycle ON content_deliveries(phone, content_type, cycle_start, status);

    -- Additive manual quota adjustments (audit log). Never overwrites usage.
    CREATE TABLE IF NOT EXISTS quota_adjustments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone         TEXT NOT NULL,
      content_type  TEXT NOT NULL,                    -- story | carousel | reel
      cycle_start   TEXT NOT NULL,                    -- applies to this cycle
      delta         INTEGER NOT NULL,                 -- additive (+3, +1 …)
      reason        TEXT,
      created_by    TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_adj_lookup ON quota_adjustments(phone, content_type, cycle_start);

    -- Global runtime settings (e.g. the admin scheduler pause flag). Persisted so
    -- a pause survives restarts/deploys.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Provider-specific daily counters for the safety caps. Keyed by UTC day.
    CREATE TABLE IF NOT EXISTS provider_usage (
      day   TEXT NOT NULL,   -- UTC YYYY-MM-DD
      kind  TEXT NOT NULL,   -- story_gen | carousel_gen | reel_gen | wa_send
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, kind)
    );
  `);

  // Guarded ALTER for DBs that created content_deliveries before `payload` existed.
  try { db.exec('ALTER TABLE content_deliveries ADD COLUMN payload TEXT'); } catch { /* already exists */ }

  // Per-client opt-in for scheduled content. DEFAULT 0 backfills every existing
  // row to disabled, so enabling the feature never surprises an existing client.
  try { db.exec('ALTER TABLE clients ADD COLUMN scheduled_content_enabled INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }

  // Per-client scheduler scalars. Guarded ALTERs (idempotent). Deliberately NOT
  // named `send_hour` (a legacy column the old code dropped on boot).
  for (const ddl of [
    'ALTER TABLE clients ADD COLUMN registration_date TEXT',
    "ALTER TABLE clients ADD COLUMN send_time TEXT",
    'ALTER TABLE clients ADD COLUMN timezone TEXT',
  ]) {
    try { db.exec(ddl); } catch { /* column already exists */ }
  }

  // Backfill existing clients without dropping/modifying any data:
  //   registration_date <- created_at (or now, documented fallback)
  //   send_time <- 07:30, timezone <- Asia/Jerusalem
  // Plan (package) and status keep their existing values.
  db.prepare(`
    UPDATE clients SET
      registration_date = COALESCE(registration_date, created_at, datetime('now')),
      send_time         = COALESCE(send_time, '07:30'),
      timezone          = COALESCE(timezone, 'Asia/Jerusalem')
    WHERE registration_date IS NULL OR send_time IS NULL OR timezone IS NULL
  `).run();
}
