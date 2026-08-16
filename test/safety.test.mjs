import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../src/clock.js';
import { createProviderLimiter } from '../src/limiter.js';
import * as Q from '../src/quota.js';
import * as D from '../src/deliveries.js';
import { makeDb, addClient, makeHarness, makeFakes, drain, deferred, tick } from './helpers.mjs';

const REG = '2026-07-19T05:00:00Z';
const MORNING = ' 2026-07-19T06:00:00Z'.trim(); // 09:00 local, past 07:30
const storyItem = (phone, seq) => ({
  phone, content_type: 'story', cycle_start: '2026-07-19', scheduled_date: '2026-07-19',
  sequence_number: seq, idempotency_key: `${phone}:story:2026-07-19:${seq}`,
});
const carouselItem = (phone) => ({
  phone, content_type: 'carousel', cycle_start: '2026-07-19', scheduled_date: '2026-07-19',
  sequence_number: 1, idempotency_key: `${phone}:carousel:2026-07-19:1`,
});
const count = (db, sql) => db.prepare(`SELECT COUNT(*) c FROM content_deliveries ${sql}`).get().c;

test('Global feature flag disabled: the scheduler enqueues nothing', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG }); // per-client enabled
  const h = makeHarness(db, { clock: fakeClock(Date.parse(MORNING)), isSchedulingActive: () => false, isEnabled: () => false });
  h.scheduler.tick();
  await drain(db, h.queue, h.clock);
  assert.equal(count(db, ''), 0);
});

test('Per-client scheduled_content_enabled=false: nothing enqueued for that client', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG, scheduled_content_enabled: false });
  const h = makeHarness(db, { clock: fakeClock(Date.parse(MORNING)) }); // global active
  h.scheduler.tick();
  assert.equal(count(db, ''), 0);
});

test('An enabled client alongside a disabled one: only the enabled one is enqueued', async () => {
  const db = makeDb();
  addClient(db, { phone: 'on', registration_date: REG, scheduled_content_enabled: true });
  addClient(db, { phone: 'off', registration_date: REG, scheduled_content_enabled: false });
  const h = makeHarness(db, { clock: fakeClock(Date.parse(MORNING)) });
  h.scheduler.tick();
  assert.ok(count(db, "WHERE phone='on'") >= 2);
  assert.equal(count(db, "WHERE phone='off'"), 0);
});

test('Recovery is bounded by the local day, not by a fixed grace', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG, send_time: '09:00' });
  const at = (utc) => Q.isSendDue(c, new Date(Date.parse(utc)));
  assert.equal(at('2026-07-19T05:30:00Z'), false, '08:30 local — before the send time');
  assert.equal(at('2026-07-19T06:05:00Z'), true, '09:05 local — on time');
  // The case that matters: an outage from 09:00 to 13:00. The client paid for this
  // day, so it must still go out rather than being dropped for being late.
  assert.equal(at('2026-07-19T10:00:00Z'), true, '13:00 local — recovered after a 4h outage');
  assert.equal(at('2026-07-19T20:45:00Z'), true, '23:45 local — still the same local day');
});

test('Client enabled after today\'s send time: the day is sealed and nothing is sent', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const now = new Date(Date.parse(MORNING)); // 09:00 local — window open
  assert.equal(Q.isSendDue(c, now), true, 'precondition: without sealing this day would deliver');

  const sealed = D.seedSkippedItems(db, Q.dueItems(c, '2026-07-19'));
  assert.ok(sealed > 0, 'signup seals the current day');

  const h = makeHarness(db, { clock: fakeClock(Date.parse(MORNING)) });
  h.scheduler.tick();
  await drain(db, h.queue, h.clock);

  assert.equal(count(db, "WHERE status='scheduled'"), 0, 'the tick enqueues nothing for the sealed day');
  assert.equal(count(db, "WHERE status='delivered'"), 0, 'nothing is delivered on the signup day');
  assert.equal(count(db, "WHERE status='skipped'"), sealed, 'the sealed rows are left untouched');
});

test('Sealing one day does not block the next one', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  D.seedSkippedItems(db, Q.dueItems(c, '2026-07-19'));
  // Next local day, inside its window: delivery starts normally.
  const h = makeHarness(db, { clock: fakeClock(Date.parse('2026-07-20T06:00:00Z')) });
  h.scheduler.tick(); // the tick dispatches, so rows may already have left 'scheduled'
  assert.ok(count(db, "WHERE scheduled_date='2026-07-20'") > 0, 'the next day enqueues normally');
  assert.equal(count(db, "WHERE scheduled_date='2026-07-20' AND status='skipped'"), 0, 'and is not sealed');
});

test('A day lost to an outage is credited back and the client is told', () => {
  const db = makeDb();
  // Registered Sunday; the service is down all of Sunday and returns Monday morning.
  const c = addClient(db, { phone: '1', registration_date: REG });
  const h = makeHarness(db, { clock: fakeClock(Date.parse('2026-07-20T06:00:00Z')) });
  h.scheduler.tick();

  // Sunday's items can no longer be sent — the slot is gone.
  assert.equal(count(db, "WHERE scheduled_date='2026-07-19' AND status='missed'"), 4);

  // …but the entitlement comes back as an additive, audited credit.
  const adj = db.prepare(
    "SELECT content_type, SUM(delta) d FROM quota_adjustments WHERE phone='1' AND created_by='system' GROUP BY content_type",
  ).all();
  const credited = Object.fromEntries(adj.map((r) => [r.content_type, r.d]));
  assert.deepEqual(credited, { story: 2, carousel: 1, reel: 1 });

  assert.equal(h.missedNotices.length, 1, 'the client is notified once');
  assert.deepEqual(h.missedNotices[0].credited, { story: 2, carousel: 1, reel: 1 });
});

test('Repeated ticks never credit the same lost day twice', () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  const h = makeHarness(db, { clock: fakeClock(Date.parse('2026-07-20T06:00:00Z')) });
  h.scheduler.tick();
  h.scheduler.tick();
  h.scheduler.tick();
  const total = db.prepare("SELECT COALESCE(SUM(delta),0) d FROM quota_adjustments WHERE phone='1'").get().d;
  assert.equal(total, 4, 'one credit per lost item, regardless of tick count');
  assert.equal(h.missedNotices.length, 1, 'and exactly one notice');
});

test('A day sealed at signup is never credited — it was never owed', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  D.seedSkippedItems(db, Q.dueItems(c, '2026-07-19')); // signed up mid-day Sunday
  const h = makeHarness(db, { clock: fakeClock(Date.parse('2026-07-20T06:00:00Z')) });
  h.scheduler.tick();
  assert.equal(count(db, "WHERE scheduled_date='2026-07-19' AND status='missed'"), 0);
  assert.equal(db.prepare("SELECT COALESCE(SUM(delta),0) d FROM quota_adjustments WHERE phone='1'").get().d, 0);
  assert.equal(h.missedNotices.length, 0, 'and no apology for content that was never due');
});

test('Partial carousel retries ONLY the missing slides (delivered slides never resent)', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  let visualCalls = 0;
  let failedOnce = false;
  const senders = {
    sendText: async () => ({ idMessage: 't' }),
    sendVisual: async () => {
      visualCalls++;
      if (visualCalls === 3 && !failedOnce) { failedOnce = true; throw new Error('WA drop on slide 3'); }
      return { idMessage: 'v' };
    },
    sendFileByUrl: async () => ({ idMessage: 'f' }),
  };
  const h = makeHarness(db, { fakes: makeFakes({ senders }), config: { maxRetries: 3, backoffBaseMs: 1 } });
  D.enqueueItems(db, [carouselItem('1')]);
  // First attempt sends slides 1,2 then fails on 3 -> retry resumes at slide 3.
  await drain(db, h.queue, h.clock);
  h.clock.advance(5); // pass the 1ms backoff
  await drain(db, h.queue, h.clock);

  const row = db.prepare("SELECT status FROM content_deliveries WHERE content_type='carousel'").get();
  assert.equal(row.status, 'delivered');
  // slides 1,2 sent once each; slide 3 attempted twice (1 fail + 1 ok) = 4 total.
  // If slides 1,2 had been resent, this would be 6.
  assert.equal(visualCalls, 4, 'only the missing slide was retried');
  const ci = Q.cycleInfo({ phone: '1', package: 'basic', registration_date: REG, timezone: 'Asia/Jerusalem' }, '2026-07-19');
  assert.equal(D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start).carousel, 1, 'carousel = one unit');
});

test('Crash during sending becomes unknown_delivery_state (manual review, never auto-resent)', () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  const clock = fakeClock(Date.parse('2026-07-19T06:00:00Z'));
  D.enqueueItems(db, [storyItem('1', 1)]);
  const item = D.claimNext(db, 'story', clock.now(), 10_000, 'w1');
  assert.equal(D.markSending(db, item.id, clock.now(), 10_000), true); // message physically sent, then crash
  clock.advance(20_000);
  const rep = D.reapStuck(db, clock.now(), { maxRetries: 3, backoffMs: () => 1000 });
  assert.equal(rep.unknown, 1);
  assert.equal(db.prepare('SELECT status FROM content_deliveries WHERE id=?').get(item.id).status, 'unknown_delivery_state');
  // Manual retry moves it back to scheduled for a fresh attempt.
  assert.equal(D.retryManual(db, item.id), 1);
  assert.equal(db.prepare('SELECT status FROM content_deliveries WHERE id=?').get(item.id).status, 'scheduled');
});

test('Daily provider cap delays extra jobs without deleting them or consuming quota', async () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const clock = fakeClock(Date.parse('2026-07-19T06:00:00Z'));
  const limiter = createProviderLimiter({ db, limits: { story: 1, carousel: 50, reel: 20, whatsapp: 1000 }, clock });
  const h = makeHarness(db, { clock, limiter });
  D.enqueueItems(db, [storyItem('1', 1), storyItem('1', 2), storyItem('1', 3)]);

  await drain(db, h.queue, h.clock);
  assert.equal(count(db, "WHERE status='delivered'"), 1, 'cap allows only 1 today');
  assert.equal(count(db, "WHERE status='scheduled'"), 2, 'the rest stay queued');
  assert.equal(count(db, ''), 3, 'nothing deleted');
  const ci = Q.cycleInfo(c, '2026-07-19');
  assert.equal(D.deliveredCounts(db, '1', ci.weeklyStart, ci.c14Start).story, 1, 'quota only for the delivered one');

  // Next UTC day: cap resets, one more flows through (still capped at 1/day).
  clock.set(Date.parse('2026-07-20T06:00:00Z'));
  await drain(db, h.queue, h.clock);
  assert.equal(count(db, "WHERE status='delivered'"), 2);
  assert.equal(count(db, "WHERE status='scheduled'"), 1);
});

test('Global pause stops new processing; the active job finishes and queued jobs stay intact', async () => {
  const db = makeDb();
  addClient(db, { phone: '1', registration_date: REG });
  const gate = deferred();
  let paused = false;
  const story = async () => { await gate.promise; return { image: {}, caption: '' }; };
  const h = makeHarness(db, {
    fakes: makeFakes({ story }),
    isEnabled: () => !paused,
    isSchedulingActive: () => !paused,
    config: { concurrency: { story: 1, carousel: 1, reel: 1, whatsapp: 4 } },
  });
  D.enqueueItems(db, [storyItem('1', 1), storyItem('1', 2), storyItem('1', 3)]);
  h.queue.dispatch();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.queue.active().story, 1, 'one job actively generating');
  assert.equal(count(db, "WHERE status='scheduled'"), 2);

  paused = true; // PAUSE
  h.queue.dispatch();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(count(db, "WHERE status='scheduled'"), 2, 'no new jobs claimed while paused');

  gate.resolve(); // the already-active job finishes cleanly
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(count(db, "WHERE status='delivered'"), 1, 'active job completed, not corrupted');
  assert.equal(count(db, "WHERE status='scheduled'"), 2, 'queued jobs intact');

  paused = false; // RESUME
  await drain(db, h.queue, h.clock);
  assert.equal(count(db, "WHERE status='delivered'"), 3);
});
