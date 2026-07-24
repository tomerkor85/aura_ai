// Pure cycle + quota math for scheduled subscription content.
//
// Cycles are DERIVED from each client's persisted registration_date, so they
// survive restarts/deploys and never reset on calendar boundaries (Sun/1st/etc).
// Every function takes an explicit `now`/date string, so tests inject a fake
// clock and get deterministic results. No DB access, no side effects.
import { scheduleQuotaOf, scheduleConfig } from './config.js';

const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

// Parse a DB timestamp: ISO ('…Z'/offset) or SQLite 'YYYY-MM-DD HH:MM:SS' (UTC here).
export function parseDbTime(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  let str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) str = str.replace(' ', 'T') + 'Z';
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 'YYYY-MM-DD' for an instant in an IANA tz.
export function localDateStr(date, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// Minutes since local midnight for an instant in a tz.
export function localMinutes(date, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

export function parseHM(hm) {
  const [h, m] = String(hm || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

const ymdToUTC = (str) => { const [y, m, d] = str.split('-').map(Number); return Date.UTC(y, m - 1, d); };

// Whole calendar days between two 'YYYY-MM-DD' strings (b − a).
export function daysBetween(aStr, bStr) {
  return Math.round((ymdToUTC(bStr) - ymdToUTC(aStr)) / DAY_MS);
}

export function addDays(str, n) {
  const d = new Date(ymdToUTC(str) + n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// tz offset (ms) at a given instant: (wall-clock-as-UTC) − (actual UTC).
function tzOffsetMs(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return asUTC - date.getTime();
}

// UTC instant for a wall-clock time (dateStr + h:mi) in a tz.
export function zonedWallToUtc(dateStr, h, mi, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

export function clientTz(client) { return client.timezone || scheduleConfig.defaultTz; }
export function clientSendTime(client) { return client.send_time || scheduleConfig.defaultSendTime; }

// Registration anchor as a local date in the client's tz (falls back to created_at).
export function regLocalDate(client) {
  const tz = clientTz(client);
  const d = parseDbTime(client.registration_date) || parseDbTime(client.created_at) || new Date(0);
  return localDateStr(d, tz);
}

// Cycle windows for a given local day, anchored to registration.
export function cycleInfo(client, todayStr) {
  const regStr = regLocalDate(client);
  const days = Math.max(0, daysBetween(regStr, todayStr));
  const weeklyDay = days % 7;
  const c14Day = days % 14;
  const weeklyStart = addDays(todayStr, -weeklyDay);
  const c14Start = addDays(todayStr, -c14Day);
  return {
    regStr, days, weeklyDay, c14Day,
    weeklyStart, weeklyEnd: addDays(weeklyStart, 6),
    c14Start, c14End: addDays(c14Start, 13),
  };
}

function mkItem(client, type, seq, cycleStart, dateStr) {
  return {
    phone: client.phone, content_type: type, sequence_number: seq,
    cycle_start: cycleStart, scheduled_date: dateStr,
    idempotency_key: `${client.phone}:${type}:${dateStr}:${seq}`,
  };
}

// The content items due for a client on a given local day (pure; no DB).
export function dueItems(client, todayStr) {
  const q = scheduleQuotaOf(client);
  const ci = cycleInfo(client, todayStr);
  const items = [];
  for (let s = 1; s <= q.storiesPerDay; s++) items.push(mkItem(client, 'story', s, ci.weeklyStart, todayStr));
  q.carouselDays.forEach((day, i) => { if (ci.weeklyDay === day) items.push(mkItem(client, 'carousel', i + 1, ci.weeklyStart, todayStr)); });
  q.reelDays.forEach((day, i) => { if (ci.c14Day === day) items.push(mkItem(client, 'reel', i + 1, ci.c14Start, todayStr)); });
  return items;
}

// Included quota per cycle: stories/carousels per weekly cycle, reels per 14-day cycle.
export function includedFor(client) {
  const q = scheduleQuotaOf(client);
  return { story: q.storiesPerDay * 7, carousel: q.carouselDays.length, reel: q.reelDays.length };
}

// remaining = included + admin adjustments − successfully delivered (this cycle).
export function quotaSummary(client, todayStr, delivered = {}, adjustments = {}) {
  const inc = includedFor(client);
  const ci = cycleInfo(client, todayStr);
  const card = (type) => {
    const included = inc[type], used = delivered[type] || 0, adj = adjustments[type] || 0;
    return { included, used, adjustments: adj, remaining: included + adj - used };
  };
  return {
    cycles: { weekly: { start: ci.weeklyStart, end: ci.weeklyEnd }, biweekly: { start: ci.c14Start, end: ci.c14End } },
    story: card('story'), carousel: card('carousel'), reel: card('reel'),
  };
}

// Is it at/after the client's send time on their local clock?
export function isSendDue(client, now) {
  return localMinutes(now, clientTz(client)) >= parseHM(clientSendTime(client));
}

// Next delivery instant (ISO): today's send time if still ahead, else tomorrow's.
export function nextDeliveryAt(client, now) {
  const tz = clientTz(client);
  const sendMin = parseHM(clientSendTime(client));
  const todayStr = localDateStr(now, tz);
  const dateStr = localMinutes(now, tz) < sendMin ? todayStr : addDays(todayStr, 1);
  return zonedWallToUtc(dateStr, Math.floor(sendMin / 60), sendMin % 60, tz).toISOString();
}
