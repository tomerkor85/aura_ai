import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/quota.js';

// Wednesday 2026-07-15, 08:00 local in Asia/Jerusalem (UTC+3 in summer).
const REG = '2026-07-15T05:00:00Z';
const basic = { phone: 'b', package: 'basic', timezone: 'Asia/Jerusalem', registration_date: REG, send_time: '07:30' };
const premium = { ...basic, phone: 'p', package: 'premium' };

const storiesOf = (c, day) => Q.dueItems(c, day).filter((i) => i.content_type === 'story');
const carouselsOverWeek = (c) => {
  let total = 0;
  for (let d = 0; d < 7; d++) total += Q.dueItems(c, Q.addDays('2026-07-15', d)).filter((i) => i.content_type === 'carousel').length;
  return total;
};
const reelsOver14 = (c) => {
  let total = 0;
  for (let d = 0; d < 14; d++) total += Q.dueItems(c, Q.addDays('2026-07-15', d)).filter((i) => i.content_type === 'reel').length;
  return total;
};

test('1. Basic plan yields 2 stories per day', () => {
  assert.equal(storiesOf(basic, '2026-07-15').length, 2);
  assert.equal(storiesOf(basic, '2026-07-19').length, 2);
});

test('2. Premium plan yields 4 stories per day', () => {
  assert.equal(storiesOf(premium, '2026-07-15').length, 4);
  assert.equal(storiesOf(premium, '2026-07-19').length, 4);
});

test('3. Basic: 1 carousel per weekly cycle, on cycle day 0', () => {
  assert.equal(carouselsOverWeek(basic), 1);
  assert.equal(Q.dueItems(basic, '2026-07-15').filter((i) => i.content_type === 'carousel').length, 1); // day 0
  assert.equal(Q.dueItems(basic, '2026-07-18').filter((i) => i.content_type === 'carousel').length, 0); // day 3
});

test('4. Premium: 2 carousels per weekly cycle, on cycle days 0 and 3', () => {
  assert.equal(carouselsOverWeek(premium), 2);
  assert.equal(Q.dueItems(premium, '2026-07-15').filter((i) => i.content_type === 'carousel').length, 1); // day 0
  assert.equal(Q.dueItems(premium, '2026-07-18').filter((i) => i.content_type === 'carousel').length, 1); // day 3
});

test('5. Basic: 1 reel per 14-day cycle, on cycle day 0', () => {
  assert.equal(reelsOver14(basic), 1);
});

test('6. Premium: 2 reels per 14-day cycle, on cycle days 0 and 8', () => {
  assert.equal(reelsOver14(premium), 2);
  assert.equal(Q.dueItems(premium, '2026-07-22').filter((i) => i.content_type === 'reel').length, 1); // day 7 (0-indexed)
});

test('7. Cycles are anchored to the registration date, not the calendar week', () => {
  assert.equal(Q.cycleInfo(basic, '2026-07-15').weeklyDay, 0);
  assert.equal(Q.cycleInfo(basic, '2026-07-15').weeklyStart, '2026-07-15');
  assert.equal(Q.cycleInfo(basic, '2026-07-18').weeklyDay, 3);
  assert.equal(Q.cycleInfo(basic, '2026-07-18').weeklyStart, '2026-07-15');
  // day 7 rolls into a new weekly cycle anchored to registration
  assert.equal(Q.cycleInfo(basic, '2026-07-22').weeklyDay, 0);
  assert.equal(Q.cycleInfo(basic, '2026-07-22').weeklyStart, '2026-07-22');
  // 14-day reel cycle also anchored to registration: day 13 then a fresh cycle at day 14
  assert.equal(Q.cycleInfo(basic, '2026-07-28').c14Day, 13);
  assert.equal(Q.cycleInfo(basic, '2026-07-29').c14Day, 0);
  assert.equal(Q.cycleInfo(basic, '2026-07-29').c14Start, '2026-07-29');
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
