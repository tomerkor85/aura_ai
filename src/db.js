import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On Railway, set DATA_DIR to a mounted Volume (e.g. /data) so the DB survives redeploys.
const dataDir = config.dataDir || path.join(__dirname, '..');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'aura.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  phone         TEXT PRIMARY KEY,             -- digits only, e.g. 972501234567
  name          TEXT NOT NULL,                -- contact person name
  business_name TEXT NOT NULL,
  package       TEXT NOT NULL DEFAULT 'basic',-- basic | premium
  status        TEXT NOT NULL DEFAULT 'active',
  send_hour     INTEGER NOT NULL DEFAULT 8,   -- local hour for daily content
  profile       TEXT NOT NULL,                -- full brand profile as JSON
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  role       TEXT NOT NULL,                   -- user | assistant
  content    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_phone ON history(phone, id);

CREATE TABLE IF NOT EXISTS daily_log (
  phone     TEXT NOT NULL,
  sent_date TEXT NOT NULL,                    -- YYYY-MM-DD
  PRIMARY KEY (phone, sent_date)
);

-- Tracks the last editable image generated per client (OpenAI Responses API).
-- brand_snapshot = the brand profile captured at creation time, so later edits
-- ("make it bigger") stay consistent even if the profile changes afterward.
-- edit_count = how many edits have been applied to the current image (cap enforced in agent).
CREATE TABLE IF NOT EXISTS image_state (
  phone            TEXT PRIMARY KEY,
  last_response_id TEXT,
  brand_snapshot   TEXT,
  edit_count       INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT DEFAULT (datetime('now'))
);
`);

// Migration for DBs created before edit_count existed.
try { db.exec('ALTER TABLE image_state ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }

export function getImageState(phone) {
  return db.prepare('SELECT * FROM image_state WHERE phone = ?').get(phone) || null;
}

// A brand-new image: store response id + brand snapshot, reset the edit counter.
export function startImageState(phone, responseId, snapshot) {
  db.prepare(`
    INSERT INTO image_state (phone, last_response_id, brand_snapshot, edit_count, updated_at)
    VALUES (@phone, @rid, @snap, 0, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      last_response_id = @rid,
      brand_snapshot = @snap,
      edit_count = 0,
      updated_at = datetime('now')
  `).run({ phone, rid: responseId, snap: JSON.stringify(snapshot) });
}

// An edit of the current image: advance the response id, increment the counter,
// keep the original brand snapshot.
export function recordImageEdit(phone, responseId) {
  db.prepare(`
    UPDATE image_state
    SET last_response_id = @rid, edit_count = edit_count + 1, updated_at = datetime('now')
    WHERE phone = @phone
  `).run({ phone, rid: responseId });
}

export function getClientByPhone(phone) {
  const row = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
  if (!row) return null;
  return { ...row, profile: JSON.parse(row.profile) };
}

export function listActiveClients() {
  return db
    .prepare("SELECT * FROM clients WHERE status = 'active'")
    .all()
    .map((r) => ({ ...r, profile: JSON.parse(r.profile) }));
}

export function listAllClients() {
  return db
    .prepare('SELECT * FROM clients ORDER BY created_at DESC')
    .all()
    .map((r) => ({ ...r, profile: JSON.parse(r.profile) }));
}

export function deleteClient(phone) {
  db.prepare('DELETE FROM clients WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM history WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM daily_log WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM image_state WHERE phone = ?').run(phone);
}

export function upsertClient({ phone, name, business_name, package: pkg, status, send_hour, profile }) {
  db.prepare(`
    INSERT INTO clients (phone, name, business_name, package, status, send_hour, profile)
    VALUES (@phone, @name, @business_name, @pkg, @status, @send_hour, @profile)
    ON CONFLICT(phone) DO UPDATE SET
      name = @name, business_name = @business_name, package = @pkg,
      status = @status, send_hour = @send_hour, profile = @profile
  `).run({
    phone, name, business_name, pkg,
    status: status || 'active',
    send_hour,
    profile: JSON.stringify(profile),
  });
}

export function appendHistory(phone, role, content) {
  db.prepare('INSERT INTO history (phone, role, content) VALUES (?, ?, ?)').run(phone, role, content);
}

export function getRecentHistory(phone, limit = 30) {
  const rows = db
    .prepare('SELECT role, content FROM history WHERE phone = ? ORDER BY id DESC LIMIT ?')
    .all(phone, limit);
  return rows.reverse();
}

export function wasSentToday(phone, dateStr) {
  return !!db.prepare('SELECT 1 FROM daily_log WHERE phone = ? AND sent_date = ?').get(phone, dateStr);
}

export function markSentToday(phone, dateStr) {
  db.prepare('INSERT OR IGNORE INTO daily_log (phone, sent_date) VALUES (?, ?)').run(phone, dateStr);
}
