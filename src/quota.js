// Pure cycle + quota math for scheduled subscription content.
//
// Cycles are DERIVED from each client's persisted registration_date, so they
// survive restarts/deploys and never reset on calendar boundaries (Sun/1st/etc).
// Every function takes an explicit `now`/date string, so tests inject a fake
// clock and get deterministic results. No DB access, no side effects.
import {
  scheduleConfig, isValidHM, CONTENT_TYPES, weeklyAllowanceOf, defaultSchedule,
} from './config.js';

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
// A malformed stored value (hand-edited DB, pre-validation row) would misparse
// into the wrong minute-of-day, so it falls back to the default instead.
export function clientSendTime(client) {
  const t = client.send_time || scheduleConfig.defaultSendTime;
  return isValidHM(t) ? t : scheduleConfig.defaultSendTime;
}

// Registration anchor as a local date in the client's tz (falls back to created_at).
export function regLocalDate(client) {
  const tz = clientTz(client);
  const d = parseDbTime(client.registration_date) || parseDbTime(client.created_at) || new Date(0);
  return localDateStr(d, tz);
}

// Weekday of a 'YYYY-MM-DD' local date. 0 = Sunday … 6 = Saturday, matching both
// the Israeli week and the keys of a client's schedule.
export function weekdayOf(dateStr) {
  return new Date(ymdToUTC(dateStr)).getUTCDay();
}

// Cycle windows for a given local day.
//
// Cycles are CALENDAR weeks (Sunday–Saturday), not weeks counted from the signup
// date. That is what lets a schedule say "carousel on Wednesday" and mean the same
// day for every client. c14* are retained so existing callers keep working; they
// now track the same calendar week as the weekly cycle.
export function cycleInfo(client, todayStr) {
  const regStr = regLocalDate(client);
  const days = Math.max(0, daysBetween(regStr, todayStr));
  const weeklyDay = weekdayOf(todayStr);
  const weeklyStart = addDays(todayStr, -weeklyDay);
  return {
    regStr, days, weeklyDay, c14Day: weeklyDay,
    weeklyStart, weeklyEnd: addDays(weeklyStart, 6),
    c14Start: weeklyStart, c14End: addDays(weeklyStart, 6),
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
// The client's weekly plan: { 0..6: { story, carousel, reel } }. Falls back to the
// package default when unset, and is always clamped to the package allowance so a
// stale row can never grant more than the plan pays for.
export function clientSchedule(client) {
  let raw = client.schedule;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  const base = raw && typeof raw === 'object' ? raw : defaultSchedule(client);
  const week = {};
  for (let d = 0; d <= 6; d++) {
    const day = base[d] || base[String(d)] || {};
    week[d] = {};
    for (const t of CONTENT_TYPES) {
      const n = Number(day[t]);
      week[d][t] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
  }
  return clampToAllowance(week, weeklyAllowanceOf(client));
}

// Trim a week down to the allowance, earliest weekday first, so an over-budget
// schedule degrades predictably instead of being rejected at delivery time.
function clampToAllowance(week, allowance) {
  for (const t of CONTENT_TYPES) {
    let left = allowance[t] ?? 0;
    for (let d = 0; d <= 6; d++) {
      const take = Math.min(week[d][t], Math.max(0, left));
      week[d][t] = take;
      left -= take;
    }
  }
  return week;
}

// Totals per content type for a week plan — used by the panel and by validation.
export function scheduleTotals(week) {
  const out = {};
  for (const t of CONTENT_TYPES) {
    out[t] = 0;
    for (let d = 0; d <= 6; d++) out[t] += (week[d] && week[d][t]) || 0;
  }
  return out;
}

export function dueItems(client, todayStr) {
  const ci = cycleInfo(client, todayStr);
  const today = clientSchedule(client)[ci.weeklyDay];
  const items = [];
  for (const t of CONTENT_TYPES) {
    for (let s = 1; s <= today[t]; s++) items.push(mkItem(client, t, s, ci.weeklyStart, todayStr));
  }
  return items;
}

// Included quota per calendar week — the package ALLOWANCE, i.e. what the client
// paid for, not what their schedule happens to spend. A client who spreads only 4
// of 14 stories across the week is still entitled to 14, so the balance stays
// honest and any credit for a missed day has room to land.
export function includedFor(client) {
  return { ...weeklyAllowanceOf(client) };
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

// Is NOW inside the client's send window on their local clock?
//
// The window opens at send_time and closes `sendGraceMinutes` later, so a service
// that was down at 07:30 still delivers when it recovers at 09:00 — but enabling a
// client (or redeploying) late at night no longer fires that morning's batch.
//
// The window never wraps past local midnight: with send_time 23:00 and a 3h grace,
// recovery stops at 23:59, because the following minute belongs to the next local
// date and is scheduled as its own day.
// Bounded by the local day, not by a fixed grace: an outage ending at 13:00 must
// still deliver a 09:00 client's content. Sending on a day the client was not yet
// eligible for is prevented by sealing that day at signup, not by this check.
export function isSendDue(client, now) {
  return localMinutes(now, clientTz(client)) >= parseHM(clientSendTime(client));
}

// Has today's send moment already passed on the client's local clock? Used when a
// client becomes eligible mid-day, to decide whether today's batch must be sealed
// off. Deliberately NOT windowed — 'already happened today', not 'due now'.
export function isPastSendTime(client, now) {
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
