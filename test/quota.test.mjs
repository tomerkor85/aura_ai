import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/quota.js';

// Wednesday 2026-07-15, 08:00 local in Asia/Jerusalem (UTC+3 in summer).
const REG = '2026-07-15T05:00:00Z';
const basic = { phone: 'b', package: 'basic', timezone: 'Asia/Jerusalem', registration_date: REG, send_time: '07:30' };
const premium = { ...basic, phone: 'p', package: 'premium' };

const storiesOf = (c, day) => Q.dueItems(c, day).filter((i) => i.content_type === 'story');
const onDay = (c, day, type) => Q.dueItems(c, day).filter((i) => i.content_type === type).length;
// A full calendar week starting Sunday 2026-07-19.
const overWeek = (c, type) => {
  let total = 0;
  for (let d = 0; d < 7; d++) total += onDay(c, Q.addDays('2026-07-19', d), type);
  return total;
};
const carouselsOverWeek = (c) => overWeek(c, 'carousel');
const reelsOverWeek = (c) => overWeek(c, 'reel');

test('1. Basic plan yields 2 stories per day', () => {
  assert.equal(storiesOf(basic, '2026-07-15').length, 2);
  assert.equal(storiesOf(basic, '2026-07-19').length, 2);
});

test('2. Premium plan yields 4 stories per day', () => {
  assert.equal(storiesOf(premium, '2026-07-15').length, 4);
  assert.equal(storiesOf(premium, '2026-07-19').length, 4);
});

test('3. Basic default: the weekly carousel and reel land on Sunday', () => {
  assert.equal(carouselsOverWeek(basic), 1);
  assert.equal(reelsOverWeek(basic), 1);
  assert.equal(onDay(basic, '2026-07-19', 'carousel'), 1); // Sunday
  assert.equal(onDay(basic, '2026-07-22', 'carousel'), 0); // Wednesday
});

test('4. Premium default: double the allowance, same Sunday placement', () => {
  assert.equal(carouselsOverWeek(premium), 2);
  assert.equal(reelsOverWeek(premium), 2);
  assert.equal(onDay(premium, '2026-07-19', 'carousel'), 2);
});

test('5. A custom schedule places each type on the weekdays the client chose', () => {
  // "carousel on Wednesday; 1 story Tuesday and 3 Thursday" — the panel's use case.
  const custom = {
    ...basic,
    schedule: {
      2: { story: 1 },
      3: { carousel: 1 },
      4: { story: 3 },
    },
  };
  assert.equal(onDay(custom, '2026-07-21', 'story'), 1);    // Tuesday
  assert.equal(onDay(custom, '2026-07-23', 'story'), 3);    // Thursday
  assert.equal(onDay(custom, '2026-07-22', 'carousel'), 1); // Wednesday
  assert.equal(onDay(custom, '2026-07-19', 'carousel'), 0); // Sunday: nothing now
  assert.equal(onDay(custom, '2026-07-19', 'story'), 0);
  assert.deepEqual(Q.scheduleTotals(Q.clientSchedule(custom)), { story: 4, carousel: 1, reel: 0 });
});

test('6. A schedule over the package allowance is clamped, never granted', () => {
  // 3 carousels a week on a plan that allows 1: the extras are dropped, earliest
  // weekday first, so a stale row can never hand out more than the plan pays for.
  const greedy = { ...basic, schedule: { 0: { carousel: 1 }, 3: { carousel: 1 }, 5: { carousel: 1 } } };
  assert.equal(Q.scheduleTotals(Q.clientSchedule(greedy)).carousel, 1);
  assert.equal(onDay(greedy, '2026-07-19', 'carousel'), 1); // Sunday kept
  assert.equal(onDay(greedy, '2026-07-22', 'carousel'), 0); // later ones dropped
});

test('7. Cycles are calendar weeks (Sunday-Saturday), not anchored to signup', () => {
  // basic registered on a Wednesday; its week still starts on the preceding Sunday.
  assert.equal(Q.cycleInfo(basic, '2026-07-15').weeklyStart, '2026-07-12');
  assert.equal(Q.cycleInfo(basic, '2026-07-18').weeklyStart, '2026-07-12'); // Saturday, same week
  assert.equal(Q.cycleInfo(basic, '2026-07-19').weeklyStart, '2026-07-19'); // Sunday, new week
  assert.equal(Q.cycleInfo(basic, '2026-07-19').weeklyDay, 0);
  assert.equal(Q.cycleInfo(basic, '2026-07-22').weeklyDay, 3);              // Wednesday
  // Two clients who signed up on different days share the same week boundaries.
  assert.equal(
    Q.cycleInfo({ ...basic, registration_date: '2026-07-19T05:00:00Z' }, '2026-07-22').weeklyStart,
    Q.cycleInfo(basic, '2026-07-22').weeklyStart,
  );
});

test('included quota matches plan (Premium = 2x Basic)', () => {
  assert.deepEqual(Q.includedFor(basic), { story: 14, carousel: 1, reel: 1 });
  assert.deepEqual(Q.includedFor(premium), { story: 28, carousel: 2, reel: 2 });
});

test('remaining = included + adjustments − delivered', () => {
  const s = Q.quotaSummary(basic, '2026-07-15', { story: 3, carousel: 0, reel: 0 }, { story: 2 });
  assert.equal(s.story.included, 14);
  assert.equal(s.story.used, 3);
  assert.equal(s.story.adjustments, 2);
  assert.equal(s.story.remaining, 13); // 14 + 2 − 3
});

test('17. Different client timezones resolve local date/send-time independently', () => {
  const jer = { ...basic, timezone: 'Asia/Jerusalem' };
  const ny = { ...basic, phone: 'ny', timezone: 'America/New_York' };
  const now = new Date('2026-07-15T02:00:00Z'); // 05:00 Jerusalem, 22:00 (prev day) New York
  assert.equal(Q.localDateStr(now, 'Asia/Jerusalem'), '2026-07-15');
  assert.equal(Q.localDateStr(now, 'America/New_York'), '2026-07-14');
  const morning = new Date('2026-07-15T05:00:00Z'); // 08:00 Jerusalem, 01:00 New York
  assert.equal(Q.isSendDue(jer, morning), true);   // past 07:30 local
  assert.equal(Q.isSendDue(ny, morning), false);   // 01:00 local
});

test('nextDeliveryAt is today if before send time, else tomorrow', () => {
  const before = new Date('2026-07-15T04:00:00Z'); // 07:00 local, before 07:30
  const after = new Date('2026-07-15T05:00:00Z');  // 08:00 local, after 07:30
  assert.equal(Q.localDateStr(new Date(Q.nextDeliveryAt(basic, before)), 'Asia/Jerusalem'), '2026-07-15');
  assert.equal(Q.localDateStr(new Date(Q.nextDeliveryAt(basic, after)), 'Asia/Jerusalem'), '2026-07-16');
  assert.equal(Q.localMinutes(new Date(Q.nextDeliveryAt(basic, after)), 'Asia/Jerusalem'), 7 * 60 + 30);
});
