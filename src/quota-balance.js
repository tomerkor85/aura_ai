// Customer-facing "יתרה" (balance) command for WhatsApp.
//
// A pure read: it composes the message from the SAME quota functions the admin
// panel uses (Q.quotaSummary over D.deliveredCounts/adjustmentTotals), so the
// customer and admin always see identical numbers. It never generates content,
// never touches quota/usage, and never calls a paid AI API.
import * as Q from './quota.js';
import * as D from './deliveries.js';

// --- command recognition (exact word, tolerant of spacing/punctuation) -------

// Matches the exact word יתרה, allowing surrounding whitespace, collapsed inner
// spaces, and trailing punctuation (יתרה / יתרה? / יתרה! / "  יתרה  ").
export function isBalanceCommand(text) {
  if (typeof text !== 'string') return false;
  const stripped = text.trim().replace(/\s+/g, ' ').replace(/[\s?!.,־–—…]+$/u, '');
  return stripped === 'יתרה';
}

// --- Hebrew pluralization (natural agreement) --------------------------------

const storyPhrase = (n) => (n === 1 ? 'סטורי אחד נותר' : `${n} סטוריז נותרו`);
const carouselPhrase = (n) => (n === 1 ? 'קרוסלה אחת נותרה' : `${n} קרוסלות נותרו`);
const reelPhrase = (n) => (n === 1 ? 'ריל אחד נותר' : `${n} רילז נותרו`);
const planLabel = (pkg) => (pkg === 'premium' ? 'חבילת פרימיום' : 'בסיסית');

// 'YYYY-MM-DD' -> 'DD/MM/YYYY'
function fmtDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = String(ymd).split('-');
  return `${d}/${m}/${y}`;
}

// Active client whose subscription end has already passed (not yet swept).
function isExpired(client, now) {
  if (client.status !== 'active' || !client.subscription_ends_at) return false;
  const ends = new Date(client.subscription_ends_at).getTime();
  return !Number.isNaN(ends) && ends < now.getTime();
}

// Status/opt-in caveat lines appended under the balance.
function statusLines(client, now) {
  const out = [];
  if (client.status === 'suspended') out.push('החשבון שלך מושהה כרגע ולא יישלח תוכן חדש.');
  else if (client.status === 'canceled') out.push('המנוי שלך מבוטל כרגע.');
  else if (isExpired(client, now)) out.push('המנוי הסתיים, ושליחת התוכן האוטומטית לא פעילה עד לחידוש המנוי.');
  if (!client.scheduled_content_enabled) out.push('שליחת התוכן האוטומטית אינה פעילה כרגע.');
  return out;
}

// --- message + shared quota computation --------------------------------------

// Build the customer balance message from a client + a quotaSummary (as returned
// by clientQuotaSummary / Q.quotaSummary). Pure — no DB, no side effects.
// "2 סטוריז ו-קרוסלה אחת" — used to tell a client what a lost day credited back.
const creditPhrase = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
export function buildMissedDayMessage(client, credited) {
  const parts = [];
  if (credited.story) parts.push(creditPhrase(credited.story, 'סטורי אחד', 'סטוריז'));
  if (credited.carousel) parts.push(creditPhrase(credited.carousel, 'קרוסלה אחת', 'קרוסלות'));
  if (credited.reel) parts.push(creditPhrase(credited.reel, 'ריל אחד', 'רילז'));
  if (!parts.length) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} ו${parts.at(-1)}`;
  // 'ב-' takes a hyphen only before a numeral ('ב-2 סטוריז'); before a word it is
  // prefixed directly ('בסטורי אחד'). Agreement follows the total, not the list.
  const prefix = /^\d/.test(list) ? 'ב-' : 'ב';
  const total = (credited.story || 0) + (credited.carousel || 0) + (credited.reel || 0);
  // A lone carousel is feminine (קרוסלה אחת שנוספה); story and reel are masculine.
  const loneFeminine = total === 1 && credited.carousel === 1;
  const added = total > 1 ? 'שנוספו' : (loneFeminine ? 'שנוספה' : 'שנוסף');
  const ask = total > 1 ? 'אותם' : (loneFeminine ? 'אותה' : 'אותו');
  return [
    `היי ${client.name}, בגלל תקלה טכנית אצלנו התוכן שלך מאתמול לא נשלח.`,
    '',
    `זיכינו אותך ${prefix}${list} ${added} ליתרה שלך — אפשר לבקש ${ask} בכל רגע.`,
    '',
    'מצטערים על אי הנוחות.',
  ].join('\n');
}

export function buildQuotaBalanceMessage(client, quota, now = new Date()) {
  const lines = [
    'יתרת התוכן שלך:',
    '',
    storyPhrase(quota.story.remaining),
    carouselPhrase(quota.carousel.remaining),
    reelPhrase(quota.reel.remaining),
    '',
    `חבילה: ${planLabel(client.package)}`,
    `מחזור שבועי מסתיים: ${fmtDate(quota.cycles.weekly.end)}`,
    `מחזור הרילז מסתיים: ${fmtDate(quota.cycles.biweekly.end)}`,
  ];
  const extra = statusLines(client, now);
  if (extra.length) lines.push('', ...extra);
  return lines.join('\n');
}

// Compute the exact quota summary the admin panel shows (single source of truth).
// remaining = included + admin adjustments − DELIVERED (only status='delivered'
// counts; failed/missed/queued/generating/sending/unknown never reduce it).
export function clientQuotaSummary(db, client, now = new Date()) {
  const tz = Q.clientTz(client);
  const todayStr = Q.localDateStr(now, tz);
  const ci = Q.cycleInfo(client, todayStr);
  const delivered = D.deliveredCounts(db, client.phone, ci.weeklyStart, ci.c14Start);
  const adjustments = D.adjustmentTotals(db, client.phone, ci.weeklyStart, ci.c14Start);
  return Q.quotaSummary(client, todayStr, delivered, adjustments);
}

// Admin guard: what `remaining` would become after applying `delta` to a type.
// Used to REJECT adjustments that would drive the balance below zero (e.g. the
// client has 2 left and an admin tries −7). ok=false means "don't apply".
export function adjustmentResult(db, client, type, delta, now = new Date()) {
  const remaining = clientQuotaSummary(db, client, now)[type].remaining;
  const resulting = remaining + delta;
  return { remaining, resulting, ok: resulting >= 0 };
}

// Command handler (runs before the regular AI chat). Returns the balance message
// for a RESOLVED customer when `text` is the balance command, else null (caller
// then proceeds to the normal AI flow). Never sends; never mutates anything.
// A null client (unknown phone) always yields null — no customer info is exposed.
export function balanceReplyFor(db, client, text, now = new Date()) {
  if (!client || !isBalanceCommand(text)) return null;
  return buildQuotaBalanceMessage(client, clientQuotaSummary(db, client, now), now);
}
