import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// ============================================================================
// Central logger: timestamped, leveled, tagged. Writes to console AND to a
// daily file under <dataDir>/logs, so production failures can be traced after
// the fact (where, why, how). Old log files are pruned after LOG_KEEP_DAYS.
//   logger.info('agent', 'message', { extra: 'data' })
//   const log = logger.child('agent'); log.info('message')
// LOG_LEVEL env: debug | info | warn | error (default info).
// ============================================================================

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const KEEP_DAYS = parseInt(process.env.LOG_KEEP_DAYS || '14', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(config.dataDir || path.join(__dirname, '..'), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

// Prune log files older than KEEP_DAYS (best-effort, once per boot).
try {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(logsDir)) {
    const p = path.join(logsDir, f);
    if (f.endsWith('.log') && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }
} catch { /* never block boot on log cleanup */ }

function fileFor(now) {
  return path.join(logsDir, `aura-${now.toISOString().slice(0, 10)}.log`);
}

function fmtExtra(extra) {
  if (extra == null) return '';
  if (extra instanceof Error) return ` | ${extra.stack || extra.message}`;
  if (typeof extra === 'string') return ` | ${extra}`;
  try { return ` | ${JSON.stringify(extra)}`; } catch { return ` | ${String(extra)}`; }
}

function write(lvl, tag, msg, extra) {
  if (LEVELS[lvl] < level) return;
  const now = new Date();
  const line = `${now.toISOString()} ${lvl.toUpperCase().padEnd(5)} [${tag}] ${msg}${fmtExtra(extra)}`;
  // Console: keep errors on stderr for hosts that split streams.
  (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
  try { fs.appendFileSync(fileFor(now), line + '\n'); } catch { /* disk issues must not crash the app */ }
}

export const logger = {
  debug: (tag, msg, extra) => write('debug', tag, msg, extra),
  info: (tag, msg, extra) => write('info', tag, msg, extra),
  warn: (tag, msg, extra) => write('warn', tag, msg, extra),
  error: (tag, msg, extra) => write('error', tag, msg, extra),
  child: (tag) => ({
    debug: (msg, extra) => write('debug', tag, msg, extra),
    info: (msg, extra) => write('info', tag, msg, extra),
    warn: (msg, extra) => write('warn', tag, msg, extra),
    error: (msg, extra) => write('error', tag, msg, extra),
  }),
};

// Truncate long strings for log lines (prompts, replies).
export function snip(s, n = 200) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…(${t.length} chars)` : t;
}
