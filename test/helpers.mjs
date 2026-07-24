// Shared test harness: an in-memory DB + the REAL queue/scheduler driven by fake
// generators/senders and a fake clock. No network, fully deterministic.
import Database from 'better-sqlite3';
import { applyScheduleSchema } from '../src/schema.js';
import { fakeClock } from '../src/clock.js';
import { createSemaphore } from '../src/semaphore.js';
import { createQueue } from '../src/queue.js';
import { createScheduler } from '../src/scheduler.js';
import { makeProcessItem } from '../src/content-delivery.js';
import { unlimitedLimiter } from '../src/limiter.js';

export const silentLogger = { info() {}, warn() {}, error() {}, child() { return silentLogger; } };

export const testConfig = {
  tickMs: 1000,
  concurrency: { story: 5, carousel: 3, reel: 2, whatsapp: 4 },
  maxRetries: 3,
  backoffBaseMs: 1000,
  backoffCapMs: 60_000,
  leaseMs: 10_000,
  itemTimeoutMs: 5_000,
};

// Fresh in-memory DB with a minimal clients table + the scheduler schema.
export function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE clients (
    phone TEXT PRIMARY KEY, name TEXT, business_name TEXT,
    package TEXT DEFAULT 'basic', status TEXT DEFAULT 'active',
    profile TEXT, created_at TEXT
  );`);
  applyScheduleSchema(db);
  return db;
}

export function addClient(db, o) {
  db.prepare(`INSERT INTO clients
    (phone, name, business_name, package, status, profile, created_at, registration_date, send_time, timezone, scheduled_content_enabled)
    VALUES (@phone,@name,@business_name,@package,@status,@profile,@created_at,@registration_date,@send_time,@timezone,@sce)`)
    .run({
      phone: o.phone, name: o.name || 'n', business_name: o.business_name || 'b',
      package: o.package || 'basic', status: o.status || 'active',
      profile: JSON.stringify(o.profile || {}),
      created_at: o.created_at || o.registration_date,
      registration_date: o.registration_date,
      send_time: o.send_time || '07:30', timezone: o.timezone || 'Asia/Jerusalem',
      // Tests default to ENABLED so existing delivery tests run; the opt-in tests set 0 explicitly.
      sce: o.scheduled_content_enabled === undefined ? 1 : (o.scheduled_content_enabled ? 1 : 0),
    });
  return getClient(db, o.phone);
}

export function getClient(db, phone) {
  const r = db.prepare('SELECT * FROM clients WHERE phone=?').get(phone);
  return r ? { ...r, profile: r.profile ? JSON.parse(r.profile) : {} } : null;
}
export function listActive(db) {
  return db.prepare("SELECT * FROM clients WHERE status='active'").all()
    .map((r) => ({ ...r, profile: r.profile ? JSON.parse(r.profile) : {} }));
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Default fakes: instant success, recording every send.
export function makeFakes(overrides = {}) {
  const sendLog = [];
  let n = 0;
  const generators = {
    story: overrides.story || (async () => ({ image: { type: 'base64', data: 's' }, caption: '' })),
    carouselPlan: overrides.carouselPlan || (async () => ({
      slides: [{ image_prompt: 'p1', text: 't1' }, { image_prompt: 'p2', text: 't2' }, { image_prompt: 'p3', text: 't3' }],
      postText: 'post',
    })),
    reel: overrides.reel || (async () => ({ videoUrl: 'http://v', caption: '' })),
  };
  const renderImage = overrides.renderImage || (async (prompt) => ({ image: { type: 'base64', data: `img:${prompt}` } }));
  const record = (kind) => (phone) => { sendLog.push({ kind, phone }); return { idMessage: `wa_${++n}` }; };
  const senders = overrides.senders || {
    sendText: async (phone) => record('text')(phone),
    sendVisual: async (phone) => record('visual')(phone),
    sendFileByUrl: async (phone) => record('file')(phone),
  };
  return { generators, renderImage, senders, sendLog };
}

export function makeHarness(db, opts = {}) {
  const clock = opts.clock || fakeClock(Date.parse('2026-07-15T05:00:00Z'));
  const config = { ...testConfig, ...(opts.config || {}) };
  const fakes = opts.fakes || makeFakes();
  const limiter = opts.limiter || unlimitedLimiter;
  const isEnabled = opts.isEnabled || (() => true);
  const isSchedulingActive = opts.isSchedulingActive || (() => true);
  const waGate = createSemaphore(config.concurrency.whatsapp);
  // Send gate mirrors production: global WhatsApp semaphore + daily send cap.
  const sendGate = (fn) => waGate.run(async () => {
    if (!limiter.canSend()) { const e = new Error('daily WhatsApp send limit reached'); e.throttled = true; throw e; }
    const r = await fn();
    limiter.recordSend();
    return r;
  });
  const processItem = makeProcessItem({
    getClient: (phone) => getClient(db, phone),
    generators: fakes.generators,
    renderImage: fakes.renderImage,
    senders: fakes.senders,
    sendGate,
    clock,
    logger: silentLogger,
    genTimeoutMs: config.itemTimeoutMs,
  });
  const queue = createQueue({ db, config, clock, logger: silentLogger, processItem, isEnabled, limiter });
  const scheduler = createScheduler({ db, queue, clock, config, logger: silentLogger, listActiveClients: () => listActive(db), isSchedulingActive });
  return { clock, config, queue, scheduler, fakes, limiter };
}

const settle = () => new Promise((r) => setImmediate(r));

// Drain the queue to quiescence: no active workers AND a fresh dispatch() claims
// nothing more. Converges whether the remaining scheduled jobs are simply absent
// or currently unclaimable (daily cap hit, paused/disabled, or backed-off).
export async function drain(db, queue, clock, { maxIters = 10000 } = {}) {
  const busy = () => { const a = queue.active(); return a.story + a.carousel + a.reel; };
  queue.dispatch();
  for (let i = 0; i < maxIters; i++) {
    await settle();
    if (busy() > 0) continue;       // wait for in-flight workers to settle
    queue.dispatch();               // try to claim more
    await settle();
    if (busy() === 0) return;       // dispatch started nothing -> quiesced
  }
  throw new Error('drain did not converge');
}

export const tick = settle;
