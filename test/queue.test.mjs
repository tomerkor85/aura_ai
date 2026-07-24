import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../src/clock.js';
import * as Q from '../src/quota.js';
import * as D from '../src/deliveries.js';
import { makeDb, addClient, makeHarness, makeFakes, drain, deferred, tick } from './helpers.mjs';

const REG = '2026-07-15T05:00:00Z'; // 08:00 local Asia/Jerusalem
const storyItem = (phone, seq) => ({
  phone, content_type: 'story', cycle_start: '2026-07-15', scheduled_date: '2026-07-15',
  sequence_number: seq, idempotency_key: `${phone}:story:2026-07-15:${seq}`,
});

// Advance the fake clock through backoff windows until every job is terminal.
async function runToCompletion(db, h, maxRounds = 30) {
  for (let i = 0; i < maxRounds; i++) {
    await drain(db, h.queue, h.clock);
    const p = db.prepare("SELECT MIN(next_attempt_at) m, COUNT(*) c FROM content_deliveries WHERE status IN ('scheduled','generating','sending')").get();
    if (!p.c) return;
    const next = p.m ? Date.parse(p.m) : h.clock.now().getTime();
    h.clock.set(Math.max(next, h.clock.now().getTime()) + 1);
  }
  throw new Error('did not reach completion');
}

test('11. Successful delivery consumes exactly one quota unit; carousel counts once regardless of slides', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', package: 'basic', registration_date: REG });
  const h = makeHarness(db);
  D.enqueueItems(db, Q.dueItems(c, '2026-07-15')); // 2 stories + 1 carousel(3 slides) + 1 reel
  await drain(db, h.queue, h.clock);
  const ci = Q.cycleInfo(c, '2026-07-15');
  assert.deepEqual(D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start), { story: 2, carousel: 1, reel: 1 });
});

test('8. Deployment/restart does not reset quota or cycles', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const h1 = makeHarness(db);
  D.enqueueItems(db, Q.dueItems(c, '2026-07-15').filter((i) => i.content_type === 'story'));
  await drain(db, h1.queue, h1.clock);
  const ci = Q.cycleInfo(c, '2026-07-15');
  const before = D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start);
  assert.equal(before.story, 2);
  // "restart": brand-new harness over the SAME persisted DB
  makeHarness(db);
  const ci2 = Q.cycleInfo(c, '2026-07-15');
  assert.deepEqual(ci2, ci, 'cycles derive from registration_date and do not shift on restart');
  assert.deepEqual(D.deliveredCounts(db, '1', ci2.weeklyStart, ci2.c14Start), before, 'used quota persists across restart');
});

test('9. Restart does not cause duplicate delivery', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const fakes = makeFakes();
  const h1 = makeHarness(db, { fakes });
  D.enqueueItems(db, Q.dueItems(c, '2026-07-15'));
  await drain(db, h1.queue, h1.clock);
  const sends1 = fakes.sendLog.length;
  assert.ok(sends1 > 0);
  // restart: re-enqueue the same day (idempotent) + drain — must not re-send anything
  const h2 = makeHarness(db, { fakes });
  D.enqueueItems(db, Q.dueItems(c, '2026-07-15'));
  await drain(db, h2.queue, h2.clock);
  assert.equal(fakes.sendLog.length, sends1, 'delivered items are never regenerated/resent');
});

test('10. Failed WhatsApp delivery does not consume quota', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const senders = {
    sendText: async () => { throw new Error('WA 500'); },
    sendVisual: async () => { throw new Error('WA 500'); },
    sendFileByUrl: async () => { throw new Error('WA 500'); },
  };
  const h = makeHarness(db, { fakes: makeFakes({ senders }), config: { maxRetries: 1, backoffBaseMs: 1 } });
  D.enqueueItems(db, [storyItem('1', 1)]);
  await runToCompletion(db, h);
  const ci = Q.cycleInfo(c, '2026-07-15');
  assert.equal(D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start).story, 0, 'no quota consumed on failure');
  assert.equal(db.prepare("SELECT status FROM content_deliveries WHERE content_type='story'").get().status, 'failed');
});

test('Generation success but delivery failure still consumes no quota', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  let generated = 0;
  const generators = { story: async () => { generated++; return { image: {}, caption: '' }; } };
  const senders = { sendText: async () => {}, sendVisual: async () => { throw new Error('WA down'); }, sendFileByUrl: async () => {} };
  const h = makeHarness(db, { fakes: makeFakes({ ...generators, senders }), config: { maxRetries: 1, backoffBaseMs: 1 } });
  D.enqueueItems(db, [storyItem('1', 1)]);
  await runToCompletion(db, h);
  const ci = Q.cycleInfo(c, '2026-07-15');
  assert.ok(generated >= 1, 'generation happened');
  assert.equal(D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start).story, 0, 'delivery failed => no quota');
});

test('12. Admin adjustment increases remaining quota', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const ci = Q.cycleInfo(c, '2026-07-15');
  const rem = () => Q.quotaSummary(c, '2026-07-15',
    D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start),
    D.adjustmentTotals(db, '1', ci.weeklyStart, ci.c14Start)).story.remaining;
  const before = rem();
  D.addAdjustment(db, { phone: '1', content_type: 'story', cycle_start: ci.weeklyStart, delta: 3, reason: 'comp' });
  assert.equal(rem(), before + 3);
});

test('13. Admin adjustment persists across restart', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const ci = Q.cycleInfo(c, '2026-07-15');
  D.addAdjustment(db, { phone: '1', content_type: 'carousel', cycle_start: ci.weeklyStart, delta: 1, reason: 'x' });
  makeHarness(db); // restart
  assert.equal(D.adjustmentTotals(db, '1', ci.weeklyStart, ci.c14Start).carousel, 1);
  assert.equal(D.listAdjustments(db, '1').length, 1);
});

test('14. Suspended (paused) clients receive nothing', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG, status: 'suspended' });
  const h = makeHarness(db, { clock: fakeClock(Date.parse('2026-07-15T06:00:00Z')) }); // 09:00 local
  h.scheduler.tick();
  await drain(db, h.queue, h.clock);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM content_deliveries').get().c, 0);
});

test('15. Changing send time affects only future scheduling; quota/usage preserved', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG, send_time: '07:30' });
  // 07:00 local — before send time — nothing enqueued
  const h1 = makeHarness(db, { clock: fakeClock(Date.parse('2026-07-15T04:00:00Z')) });
  h1.scheduler.tick();
  await drain(db, h1.queue, h1.clock);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM content_deliveries').get().c, 0);
  // deliver a story, then move send time — delivered quota must remain
  D.enqueueItems(db, [storyItem('1', 1)]);
  await drain(db, h1.queue, h1.clock);
  const ci = Q.cycleInfo(c, '2026-07-15');
  assert.equal(D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start).story, 1);
  db.prepare("UPDATE clients SET send_time='23:00' WHERE phone='1'").run();
  assert.equal(D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start).story, 1, 'usage untouched by send-time change');
  assert.equal(Q.isSendDue({ ...c, send_time: '23:00' }, new Date('2026-07-16T06:00:00Z')), false); // 09:00 local < 23:00
});

test('18. Current-day missed delivery is recovered; older days marked missed only', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  // App was down at 07:30; first tick runs 2026-07-16 09:00 local (06:00 UTC).
  const h = makeHarness(db, { clock: fakeClock(Date.parse('2026-07-16T06:00:00Z')) });
  h.scheduler.tick();
  await drain(db, h.queue, h.clock);
  const delToday = db.prepare("SELECT COUNT(*) c FROM content_deliveries WHERE scheduled_date='2026-07-16' AND status='delivered'").get().c;
  assert.ok(delToday >= 2, 'current day recovered');
  const yMissed = db.prepare("SELECT COUNT(*) c FROM content_deliveries WHERE scheduled_date='2026-07-15' AND status='missed'").get().c;
  const yDelivered = db.prepare("SELECT COUNT(*) c FROM content_deliveries WHERE scheduled_date='2026-07-15' AND status='delivered'").get().c;
  assert.ok(yMissed >= 2, 'previous day recorded as missed');
  assert.equal(yDelivered, 0, 'previous day never auto-sent');
});

test('Exactly-once: a crash during send is never resent (at-most-once)', () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  const clock = fakeClock(Date.parse('2026-07-15T06:00:00Z'));
  D.enqueueItems(db, [storyItem('1', 1)]);
  const item = D.claimNext(db, 'story', clock.now(), 10_000, 'w1');
  assert.ok(item);
  // markSending -> the WA message physically went out -> process CRASHED before markDelivered
  assert.equal(D.markSending(db, item.id, clock.now(), 10_000), true);
  const physicallySent = 1;
  clock.advance(20_000); // lease expires
  const rep = D.reapStuck(db, clock.now(), { maxRetries: 3, backoffMs: () => 1000 });
  const row = db.prepare('SELECT status FROM content_deliveries WHERE id=?').get(item.id);
  assert.equal(row.status, 'unknown_delivery_state', 'ambiguous send needs manual review, not auto-resent');
  assert.equal(rep.unknown, 1);
  assert.equal(physicallySent, 1, 'never resent — at most once');
});

test('Concurrency is bounded per type (stories never exceed the limit)', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  D.enqueueItems(db, Array.from({ length: 12 }, (_, i) => storyItem('1', i + 1)));
  let cur = 0, max = 0;
  const gate = [];
  const story = async () => { cur++; max = Math.max(max, cur); await new Promise((r) => gate.push(r)); cur--; return { image: {}, caption: '' }; };
  const h = makeHarness(db, { fakes: makeFakes({ story }), config: { concurrency: { story: 3, carousel: 2, reel: 1, whatsapp: 4 } } });
  h.queue.dispatch();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.queue.active().story, 3, 'exactly the limit are active');
  assert.equal(max, 3);
  // drain by releasing gates as workers self-feed
  for (let i = 0; i < 200 && (h.queue.active().story > 0 || gate.length); i++) {
    if (gate.length) gate.shift()();
    await tick();
  }
  await drain(db, h.queue, h.clock);
  assert.equal(max, 3, 'concurrency limit never exceeded');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM content_deliveries WHERE status='delivered'").get().c, 12);
});

test('A slow reel does not block story delivery (per-type isolation)', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  D.enqueueItems(db, [
    { phone: '1', content_type: 'reel', cycle_start: '2026-07-15', scheduled_date: '2026-07-15', sequence_number: 1, idempotency_key: '1:reel:2026-07-15:1' },
    ...Array.from({ length: 3 }, (_, i) => storyItem('1', i + 1)),
  ]);
  const reelGate = deferred();
  const reel = async () => { await reelGate.promise; return { videoUrl: 'v', caption: '' }; };
  const h = makeHarness(db, { fakes: makeFakes({ reel }) });
  h.queue.dispatch();
  for (let i = 0; i < 25; i++) await tick();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM content_deliveries WHERE content_type='story' AND status='delivered'").get().c, 3, 'stories delivered while reel is still running');
  assert.equal(db.prepare("SELECT status FROM content_deliveries WHERE content_type='reel'").get().status, 'generating');
  reelGate.resolve();
  await drain(db, h.queue, h.clock);
  assert.equal(db.prepare("SELECT status FROM content_deliveries WHERE content_type='reel'").get().status, 'delivered');
});
