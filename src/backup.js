// Safe, automatic SQLite backups for the customer database.
//
// - Uses SQLite's `VACUUM INTO`, which writes a fully consistent, self-contained
//   snapshot even while the DB is live and in WAL mode (NOT a raw file copy).
// - Writes timestamped files to <DATA_DIR>/backups — i.e. onto the persistent
//   Railway Volume, OUTSIDE the ephemeral /app container filesystem, so backups
//   survive deploys/restarts/crashes.
// - Keeps the newest BACKUP_KEEP snapshots (default 30). Files are never
//   overwritten (timestamps are unique) and pruning only ever removes entries
//   *beyond* the newest BACKUP_KEEP — so the only/most-recent copy is never
//   deleted.
//
// Restore steps are documented in BACKUP.md.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same resolution as src/db.js so backups live next to the live DB, on the Volume.
const dataDir = config.dataDir || path.join(__dirname, '..');
const backupDir = path.join(dataDir, 'backups');
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '30', 10));

// Write one timestamped snapshot of the live DB. Returns the backup file path.
export function runBackup() {
  fs.mkdirSync(backupDir, { recursive: true });
  // e.g. aura-2026-07-23_19-28-41-000.db — lexicographically sortable by time.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const target = path.join(backupDir, `aura-${ts}.db`);
  // VACUUM INTO refuses to overwrite an existing file; unique timestamps prevent collisions.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  // Validate: open the snapshot and run PRAGMA integrity_check before trusting it.
  // A corrupt snapshot must never be treated as a good backup.
  const check = new Database(target, { readonly: true });
  let result = 'unknown';
  try { result = check.pragma('integrity_check', { simple: true }); } finally { check.close(); }
  if (result !== 'ok') {
    throw new Error(`backup integrity_check failed for ${target}: ${result}`);
  }

  pruneOldBackups();
  logger.info('backup', `wrote + verified ${target}`);
  return target;
}

// Retain only the newest KEEP snapshots. Only deletes entries older than the
// newest KEEP, so at least KEEP copies always remain — the last copy is safe.
function pruneOldBackups() {
  let files;
  try {
    files = fs.readdirSync(backupDir).filter((f) => /^aura-.*\.db$/.test(f)).sort(); // oldest first
  } catch { return; }
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    try { fs.rmSync(path.join(backupDir, f)); logger.info('backup', `pruned old ${f}`); }
    catch (err) { logger.warn('backup', `could not prune ${f}: ${err.message}`); }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Run a backup ~30s after boot (a fresh snapshot every deploy), then every 24h.
// Failures are logged, never fatal — a backup problem must not take down the app.
export function scheduleBackups() {
  const first = setTimeout(() => {
    try { runBackup(); } catch (err) { logger.error('backup', 'startup backup failed', err); }
  }, 30_000);
  const daily = setInterval(() => {
    try { runBackup(); } catch (err) { logger.error('backup', 'scheduled backup failed', err); }
  }, DAY_MS);
  first.unref?.();
  daily.unref?.();
  logger.info('backup', `scheduled: startup + every 24h -> ${backupDir} (keep ${KEEP})`);
}
