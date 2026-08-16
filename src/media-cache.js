// Cache for generated media, so a retry re-sends instead of re-generating.
//
// Every image costs a paid OpenAI call. Before this, a delivery that failed at the
// WhatsApp step threw the artifact away and the retry generated it again — up to
// maxRetries paid generations for a single item that was never delivered once.
// The generation is the expensive, idempotent half; only the send needs retrying.
//
// Files live on the persistent volume next to the DB (DATA_DIR) so they survive a
// redeploy mid-retry, and are removed as soon as the item reaches a terminal state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(config.dataDir || path.join(__dirname, '..'), 'media');

function ensureDir() {
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    return true;
  } catch (err) {
    logger.error('media', `cannot create ${mediaDir}`, err);
    return false;
  }
}

// Store a base64 image and return its file name, or null if it could not be
// written. A failure here is never fatal: the caller just loses the cache and
// behaves as it did before (regenerating on the next attempt).
export function saveImage(itemId, tag, base64) {
  if (!base64 || !ensureDir()) return null;
  const name = `${itemId}-${tag}.b64`;
  try {
    fs.writeFileSync(path.join(mediaDir, name), base64, 'utf8');
    return name;
  } catch (err) {
    logger.error('media', `save failed for ${name}`, err);
    return null;
  }
}

// Returns the base64 payload, or null when the file is missing/unreadable — in
// which case the caller regenerates, exactly as before.
export function loadImage(name) {
  if (!name) return null;
  try {
    return fs.readFileSync(path.join(mediaDir, name), 'utf8');
  } catch {
    return null;
  }
}

// Drop everything cached for an item once it is delivered or permanently failed.
export function dropItemMedia(itemId) {
  try {
    if (!fs.existsSync(mediaDir)) return;
    const prefix = `${itemId}-`;
    for (const f of fs.readdirSync(mediaDir)) {
      if (f.startsWith(prefix)) fs.unlinkSync(path.join(mediaDir, f));
    }
  } catch (err) {
    logger.error('media', `cleanup failed for item ${itemId}`, err);
  }
}

// Sweep files left behind by a crash between generation and the terminal state.
// Called at boot; keeps the volume from growing without bound.
export function sweepOrphans(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(mediaDir)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const f of fs.readdirSync(mediaDir)) {
      const p = path.join(mediaDir, f);
      if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
    }
    if (removed) logger.info('media', `swept ${removed} orphaned file(s)`);
    return removed;
  } catch (err) {
    logger.error('media', 'sweep failed', err);
    return 0;
  }
}
