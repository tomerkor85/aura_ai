import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/deliveries.js';
import { isBalanceCommand, buildQuotaBalanceMessage, clientQuotaSummary, balanceReplyFor, adjustmentResult } from '../src/quota-balance.js';
import { makeDb, addClient, getClient } from './helpers.mjs';

// Registered local 2026-07-24 (08:00 Asia/Jerusalem); "now" the same morning.
const REG = '2026-07-24T05:00:00Z';
const NOW = new Date('2026-07-24T06:00:00Z');
const CYCLE = '2026-07-19'; // calendar week (Sun) containing NOW

// Insert past successful deliveries directly (status='delivered').
function deliver(db, phone, type, n, cycleStart = CYCLE) {
  for (let i = 1; i <= n; i++) {
    db.prepare(`INSERT INTO content_deliveries
      (phone,content_type,cycle_start,scheduled_date,sequence_number,idempotency_key,status,delivered_at)
      VALUES (?,?,?,?,?,?, 'delivered', datetime('now'))`)
      .run(phone, type, cycleStart, cycleStart, i, `${phone}:${type}:seed:${cycleStart}:${i}`);
  }
}
// Insert a non-delivered row of a given status.
function insertStatus(db, phone, status, seq) {
  db.prepare(`INSERT INTO content_deliveries
    (phone,content_type,cycle_start,scheduled_date,sequence_number,idempotency_key,status)
    VALUES (?, 'story', ?, ?, ?, ?, ?)`)
    .run(phone, CYCLE, CYCLE, seq, `${phone}:story:${status}:${seq}`, status);
}

test('Basic customer balance (8 stories / 1 carousel / 1 reel)', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', package: 'basic', registration_date: REG });
  deliver(db, '1', 'story', 6); // 14 - 6 = 8
  const q = clientQuotaSummary(db, c, NOW);
  assert.deepEqual([q.story.remaining, q.carousel.remaining, q.reel.remaining], [8, 1, 1]);
  const msg = buildQuotaBalanceMessage(c, q, NOW);
  assert.match(msg, /^יתרת התוכן שלך:/);
  assert.match(msg, /\n8 סטוריז נותרו\n/);
  assert.match(msg, /\nקרוסלה אחת נותרה\n/);
  assert.match(msg, /\nריל אחד נותר\n/);
  assert.match(msg, /\nחבילה: בסיסית\n/);
  assert.match(msg, /מחזור שבועי מסתיים: 25\/07\/2026/);
  assert.match(msg, /מחזור הרילז מסתיים: 25\/07\/2026/);
});

test('Premium customer balance (חבילת פרימיום, doubled quotas)', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '2', package: 'premium', registration_date: REG });
  const q = clientQuotaSummary(db, c, NOW);
  assert.deepEqual([q.story.remaining, q.carousel.remaining, q.reel.remaining], [28, 2, 2]);
  const msg = buildQuotaBalanceMessage(c, q, NOW);
  assert.match(msg, /חבילת פרימיום/);
  assert.match(msg, /28 סטוריז נותרו/);
  assert.match(msg, /2 קרוסלות נותרו/);
  assert.match(msg, /2 רילז נותרו/);
});

test('Admin adjustment cannot push the remaining balance below zero', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', package: 'basic', registration_date: REG });
  deliver(db, '1', 'story', 12); // basic story included 14 -> remaining 2
  assert.equal(clientQuotaSummary(db, c, NOW).story.remaining, 2);

  // −7 would make it −5 -> rejected
  const bad = adjustmentResult(db, c, 'story', -7, NOW);
  assert.equal(bad.ok, false);
  assert.deepEqual([bad.remaining, bad.resulting], [2, -5]);

  // −2 (lands on 0), −1, and +5 are all allowed
  assert.equal(adjustmentResult(db, c, 'story', -2, NOW).ok, true);
  assert.equal(adjustmentResult(db, c, 'story', -1, NOW).ok, true);
  assert.equal(adjustmentResult(db, c, 'story', 5, NOW).ok, true);

  // Guarded flow (as the admin endpoint runs it): a rejected adjustment records
  // NOTHING and leaves the balance intact; an allowed one applies.
  const apply = (delta) => {
    const r = adjustmentResult(db, c, 'story', delta, NOW);
    if (r.ok) D.addAdjustment(db, { phone: '1', content_type: 'story', cycle_start: CYCLE, delta });
    return r.ok;
  };
  assert.equal(apply(-7), false);
  assert.equal(clientQuotaSummary(db, c, NOW).story.remaining, 2, 'rejected adjustment did not change the balance');
  assert.equal(apply(-2), true);
  assert.equal(clientQuotaSummary(db, c, NOW).story.remaining, 0, 'balance can reach 0 but never goes negative');
});

test('Admin adjustments are reflected in the balance', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', package: 'basic', registration_date: REG });
  D.addAdjustment(db, { phone: '1', content_type: 'story', cycle_start: CYCLE, delta: 3, reason: 'comp' });
  const q = clientQuotaSummary(db, c, NOW);
  assert.equal(q.story.remaining, 17); // 14 + 3 − 0
  assert.match(buildQuotaBalanceMessage(c, q, NOW), /17 סטוריז נותרו/);
});

test('Delivered content reduces the balance', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  const before = clientQuotaSummary(db, c, NOW).story.remaining;
  deliver(db, '1', 'story', 2);
  assert.equal(clientQuotaSummary(db, c, NOW).story.remaining, before - 2);
});

test('Failed / missed / unknown deliveries do NOT reduce the balance', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  ['failed', 'missed', 'unknown_delivery_state'].forEach((st, i) => insertStatus(db, '1', st, i + 1));
  assert.equal(clientQuotaSummary(db, c, NOW).story.remaining, 14);
});

test('Queued / generating / sending content does NOT reduce the balance', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  ['scheduled', 'generating', 'sending'].forEach((st, i) => insertStatus(db, '1', st, i + 1));
  assert.equal(clientQuotaSummary(db, c, NOW).story.remaining, 14);
});

test('Suspended customer: balance + suspended notice', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG, status: 'suspended' });
  assert.match(buildQuotaBalanceMessage(c, clientQuotaSummary(db, c, NOW), NOW), /החשבון שלך מושהה כרגע ולא יישלח תוכן חדש\./);
});

test('Canceled customer: balance + canceled notice', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG, status: 'canceled' });
  assert.match(buildQuotaBalanceMessage(c, clientQuotaSummary(db, c, NOW), NOW), /המנוי שלך מבוטל כרגע\./);
});

test('Expired active subscription: states automatic delivery inactive until renewal', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG, status: 'active' });
  db.prepare("UPDATE clients SET subscription_ends_at=? WHERE phone='1'").run('2026-07-20T00:00:00Z');
  const c2 = getClient(db, '1');
  assert.match(buildQuotaBalanceMessage(c2, clientQuotaSummary(db, c2, NOW), NOW), /המנוי הסתיים, ושליחת התוכן האוטומטית לא פעילה עד לחידוש/);
});

test('Scheduled content disabled: adds the disabled notice', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG, scheduled_content_enabled: false });
  assert.match(buildQuotaBalanceMessage(c, clientQuotaSummary(db, c, NOW), NOW), /שליחת התוכן האוטומטית אינה פעילה כרגע\./);
});

test('Unknown phone cannot access balance (no client -> null, no info leaked)', () => {
  const db = makeDb();
  assert.equal(balanceReplyFor(db, null, 'יתרה'), null);
  assert.equal(balanceReplyFor(db, getClient(db, 'nope'), 'יתרה'), null);
});

test('Command recognition: יתרה + whitespace/punctuation; rejects everything else', () => {
  for (const t of ['יתרה', 'יתרה?', 'יתרה!', '  יתרה  ', 'יתרה .', 'יתרה  ?']) assert.equal(isBalanceCommand(t), true, `should match: "${t}"`);
  for (const t of ['יתרות', 'מה היתרה', 'יתרה שלי', 'balance', '', '   ', 'יתר']) assert.equal(isBalanceCommand(t), false, `should reject: "${t}"`);
});

test('Never accepts a phone number inside the message (resolves only by sender)', () => {
  const db = makeDb();
  const a = addClient(db, { phone: '111', package: 'basic', registration_date: REG });
  addClient(db, { phone: '222', package: 'premium', registration_date: REG });
  // Even if customer A types another number, the reply is built ONLY from A's client object.
  const msg = balanceReplyFor(db, a, 'יתרה 222', NOW);
  assert.equal(msg, null, 'text with an embedded number is not the exact command -> no balance');
  const own = balanceReplyFor(db, a, 'יתרה', NOW);
  assert.match(own, /חבילה: בסיסית/); // A sees A's own (basic) plan, never B's premium
});

test('Hebrew message is stored in correct LOGICAL order (verified by exact code points)', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', package: 'basic', registration_date: REG });
  deliver(db, '1', 'story', 6); // 8 remaining
  const msg = buildQuotaBalanceMessage(c, clientQuotaSummary(db, c, NOW), NOW);
  const L = msg.split('\n');
  // Compared against independently-written \u code points (immune to RTL display).
  assert.equal(L[0], 'יתרת התוכן שלך:');      // יתרת התוכן שלך:
  assert.equal(L[2], '8 סטוריז נותרו');            // 8 סטוריז נותרו
  assert.equal(L[3], 'קרוסלה אחת נותרה'); // קרוסלה אחת נותרה
  assert.equal(L[4], 'ריל אחד נותר');                   // ריל אחד נותר
  assert.equal(L[6], 'חבילה: בסיסית');            // חבילה: בסיסית
  // First logical character is yod (U+05D9), i.e. the string is NOT reversed.
  assert.equal(msg.codePointAt(0), 0x05D9);
});

test('Premium plan label logical order (חבילת פרימיום) + doubled quota lines', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '2', package: 'premium', registration_date: REG });
  const msg = buildQuotaBalanceMessage(c, clientQuotaSummary(db, c, NOW), NOW);
  assert.match(msg, /\nחבילה: חבילת פרימיום\n/); // חבילה: חבילת פרימיום
  assert.match(msg, /\n28 סטוריז נותרו\n/);      // 28 סטוריז נותרו
  assert.match(msg, /\n2 קרוסלות נותרו\n/);   // 2 קרוסלות נותרו
  assert.match(msg, /\n2 רילז נותרו/);                       // 2 רילז נותרו
});

test('Message is plain UTF-8: no bidi controls, no HTML escaping, JSON-safe', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', package: 'basic', registration_date: REG });
  const msg = buildQuotaBalanceMessage(c, clientQuotaSummary(db, c, NOW), NOW);
  // No bidi control characters (LRM/RLM/LRE..RLO/isolates/ALM).
  assert.ok(!/[‎‏‪-‮⁦-⁩؜]/.test(msg), 'no bidi control characters');
  // No HTML entity escaping.
  assert.ok(!/&(?:amp|lt|gt|quot|#x?[0-9a-f]+);/i.test(msg), 'no HTML entity escaping');
  // Valid, lossless UTF-8 and JSON round-trips (this is exactly how Green API encodes it).
  assert.equal(Buffer.from(msg, 'utf8').toString('utf8'), msg, 'lossless UTF-8');
  const payload = { chatId: '972500000001@c.us', message: msg };
  assert.equal(JSON.parse(JSON.stringify(payload)).message, msg, 'JSON round-trip preserves the exact string');
});

test('Balance command is a pure read: mutates no quota/usage/provider tables', () => {
  const db = makeDb();
  const c = addClient(db, { phone: '1', registration_date: REG });
  deliver(db, '1', 'story', 2);
  const snap = () => ({
    deliveries: db.prepare('SELECT COUNT(*) c FROM content_deliveries').get().c,
    delivered: db.prepare("SELECT COUNT(*) c FROM content_deliveries WHERE status='delivered'").get().c,
    adjustments: db.prepare('SELECT COUNT(*) c FROM quota_adjustments').get().c,
    usage: db.prepare('SELECT COUNT(*) c FROM usage').get().c,
    providerUsage: db.prepare('SELECT COUNT(*) c FROM provider_usage').get().c,
  });
  const before = snap();
  const msg = balanceReplyFor(db, c, 'יתרה', NOW); // synchronous string — cannot have awaited any provider
  assert.ok(msg && msg.includes('יתרת התוכן שלך'));
  assert.deepEqual(snap(), before, 'balance command changed no counters');
});
