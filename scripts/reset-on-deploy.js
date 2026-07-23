// Wipes the customer database once per Railway deploy.
//
// Runs automatically as the `prestart` step (before `npm start`), so it fires
// on every Railway deploy right before the app boots. To make it fire exactly
// ONCE per deploy — and never locally or on a crash-restart — it is gated on
// RAILWAY_DEPLOYMENT_ID (unique per deploy) against a marker file stored on the
// persistent Volume:
//
//   - No RAILWAY_DEPLOYMENT_ID (i.e. running locally)  -> do nothing.
//   - Marker already equals the current deployment id  -> already wiped this
//     deploy (this is a restart), so do nothing.
//   - Otherwise                                        -> delete aura.db and its
//     WAL/SHM sidecars, then record the deployment id. The app recreates the
//     schema empty on the next boot (see src/db.js), so all admin-panel
//     customers and their history/usage/images start fresh.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same resolution as src/db.js: DATA_DIR (the mounted Volume on Railway) or the project root.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');

const deployId = process.env.RAILWAY_DEPLOYMENT_ID || '';
if (!deployId) {
  // Not a Railway deploy (local dev / other host) — never auto-wipe here.
  console.log('[reset-on-deploy] no RAILWAY_DEPLOYMENT_ID — skipping DB wipe.');
  process.exit(0);
}

const markerPath = path.join(dataDir, '.last-deploy-id');
let lastDeployId = '';
try { lastDeployId = fs.readFileSync(markerPath, 'utf8').trim(); } catch { /* first deploy */ }

if (lastDeployId === deployId) {
  // Same deploy already wiped once — this is a restart, leave the DB alone.
  console.log('[reset-on-deploy] already wiped for this deploy — skipping.');
  process.exit(0);
}

const dbFiles = ['aura.db', 'aura.db-wal', 'aura.db-shm'];
for (const f of dbFiles) {
  const p = path.join(dataDir, f);
  try {
    fs.rmSync(p, { force: true });
    console.log(`[reset-on-deploy] deleted ${p}`);
  } catch (err) {
    console.error(`[reset-on-deploy] failed to delete ${p}: ${err.message}`);
  }
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(markerPath, deployId);
console.log(`[reset-on-deploy] customer DB wiped for deploy ${deployId}.`);
