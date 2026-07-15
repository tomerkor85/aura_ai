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

-- Monthly consumption per client, checked against the package quotas
-- (PACKAGES in config.js) before every image/video generation.
CREATE TABLE IF NOT EXISTS usage (
  phone  TEXT NOT NULL,
  month  TEXT NOT NULL,                       -- YYYY-MM (in the configured timezone)
  images INTEGER NOT NULL DEFAULT 0,
  videos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phone, month)
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

// Subscription statuses: active | suspended | canceled.
// notified_status = the non-active status the client was already notified about,
// so the suspension/cancellation notice is sent exactly once per status change.
try { db.exec('ALTER TABLE clients ADD COLUMN notified_status TEXT'); } catch { /* already exists */ }
// Legacy value from the old two-state model.
db.prepare("UPDATE clients SET status = 'suspended' WHERE status = 'paused'").run();

// Leftovers from the scheduled-sends era: the daily log and per-client send hour.
db.exec('DROP TABLE IF EXISTS daily_log');
try { db.exec('ALTER TABLE clients DROP COLUMN send_hour'); } catch { /* already dropped */ }

// Payment tracking: when the client paid, and when the subscription ends
// (ISO datetimes; end defaults to exactly one month after payment).
try { db.exec('ALTER TABLE clients ADD COLUMN paid_at TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE clients ADD COLUMN subscription_ends_at TEXT'); } catch { /* already exists */ }

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
  db.prepare('DELETE FROM image_state WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM usage WHERE phone = ?').run(phone);
}

export function upsertClient({ phone, name, business_name, package: pkg, status, profile, paid_at, subscription_ends_at }) {
  db.prepare(`
    INSERT INTO clients (phone, name, business_name, package, status, profile, paid_at, subscription_ends_at)
    VALUES (@phone, @name, @business_name, @pkg, @status, @profile, @paid_at, @ends_at)
    ON CONFLICT(phone) DO UPDATE SET
      name = @name, business_name = @business_name, package = @pkg,
      status = @status, profile = @profile,
      paid_at = @paid_at, subscription_ends_at = @ends_at,
      -- On a status change, clear the "already notified" marker so the client
      -- gets the one-time notice for the NEW status (e.g. suspended -> canceled,
      -- or a second suspension after reactivation).
      notified_status = CASE WHEN clients.status = @status THEN clients.notified_status ELSE NULL END
  `).run({
    phone, name, business_name, pkg,
    status: status || 'active',
    profile: JSON.stringify(profile),
    paid_at: paid_at || null,
    ends_at: subscription_ends_at || null,
  });
}

// Mark that the one-time notice for this non-active status was sent.
export function markStatusNotified(phone, status) {
  db.prepare('UPDATE clients SET notified_status = ? WHERE phone = ?').run(status, phone);
}

// Active clients whose subscription end has already passed (for the periodic
// expiry sweep). ISO-8601 UTC strings compare correctly as plain text.
export function listExpiredActiveClients() {
  return db
    .prepare("SELECT * FROM clients WHERE status = 'active' AND subscription_ends_at IS NOT NULL AND subscription_ends_at < ?")
    .all(new Date().toISOString())
    .map((r) => ({ ...r, profile: JSON.parse(r.profile) }));
}

// Expired clients that were already suspended but whose one-time notice never
// went out (e.g. the send failed) — the sweep retries these.
export function listExpiredPendingNotice() {
  return db
    .prepare("SELECT * FROM clients WHERE status = 'suspended' AND notified_status IS NULL AND subscription_ends_at IS NOT NULL AND subscription_ends_at < ?")
    .all(new Date().toISOString())
    .map((r) => ({ ...r, profile: JSON.parse(r.profile) }));
}

// Automatic expiry: an active client whose subscription end has passed becomes
// suspended. Mutates the passed client object too, and returns true when it fired.
// (notified_status is left as-is: it was cleared when the client last became
// active, so the one-time suspension notice will go out.)
export function expireSubscriptionIfDue(client) {
  if (!client || client.status !== 'active' || !client.subscription_ends_at) return false;
  const ends = new Date(client.subscription_ends_at).getTime();
  if (Number.isNaN(ends) || ends >= Date.now()) return false;
  db.prepare("UPDATE clients SET status = 'suspended' WHERE phone = ?").run(client.phone);
  client.status = 'suspended';
  return true;
}

const HISTORY_KEEP = 200; // per client; only the last ~30 are sent to the LLM anyway

export function appendHistory(phone, role, content) {
  db.prepare('INSERT INTO history (phone, role, content) VALUES (?, ?, ?)').run(phone, role, content);
  db.prepare(`
    DELETE FROM history WHERE phone = @phone AND id NOT IN (
      SELECT id FROM history WHERE phone = @phone ORDER BY id DESC LIMIT @keep
    )
  `).run({ phone, keep: HISTORY_KEEP });
}

export function getRecentHistory(phone, limit = 30) {
  const rows = db
    .prepare('SELECT role, content FROM history WHERE phone = ? ORDER BY id DESC LIMIT ?')
    .all(phone, limit);
  return rows.reverse();
}

// --- Monthly usage (quota enforcement + admin visibility) ---

// YYYY-MM in the configured timezone (month boundaries follow the client's clock).
export function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz, year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}`;
}

export function getUsage(phone, month = currentMonth()) {
  return (
    db.prepare('SELECT images, videos FROM usage WHERE phone = ? AND month = ?').get(phone, month) ||
    { images: 0, videos: 0 }
  );
}

export function incrementUsage(phone, kind, month = currentMonth()) {
  const col = kind === 'video' ? 'videos' : 'images';
  db.prepare(`
    INSERT INTO usage (phone, month, ${col}) VALUES (?, ?, 1)
    ON CONFLICT(phone, month) DO UPDATE SET ${col} = ${col} + 1
  `).run(phone, month);
}
