import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, packageOf, CONTENT_TYPES, WEEKLY_ALLOWANCE } from './config.js';
import { db, listAllClients, getClientByPhone, upsertClient, deleteClient, getUsage } from './db.js';
import * as Q from './quota.js';
import * as D from './deliveries.js';
import { normalizePhone } from './greenapi.js';
import { clientQuotaSummary, adjustmentResult } from './quota-balance.js';
import { enforceExpiry } from './subscription.js';
import { runDailyTick } from './daily.js';
import {
  verifyPassword, createToken, verifyToken, parseCookie, sessionCookie, clearCookie,
  COOKIE_NAME, loginBlocked, recordFailure, recordSuccess,
} from './auth.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

export function createAdminApp(controls = {}) {
  const app = express();
  app.set('trust proxy', 1); // behind Railway/other proxy for req.secure + real IP
  app.use(express.json({ limit: '1mb' }));

  // Basic security headers on every response.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- Login / logout (unauthenticated) ---
  app.post('/api/login', (req, res) => {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      return res.status(429).json({ error: 'יותר מדי נסיונות כניסה. נסו שוב בעוד כמה דקות.' });
    }
    if (!verifyPassword(req.body?.password)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'סיסמה שגויה' });
    }
    recordSuccess(ip);
    res.setHeader('Set-Cookie', sessionCookie(req, createToken()));
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearCookie());
    res.json({ ok: true });
  });

  // --- Auth guard for everything else under /api ---
  app.use('/api', (req, res, next) => {
    const token = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  // Attach this month's consumption + the package quotas for the panel.
  // Also enforce subscription expiry on read: the status flip inside
  // enforceExpiry happens synchronously, so the panel never shows an expired
  // client as active (the one-time notice is sent in the background).
  function withUsage(client) {
    enforceExpiry(client).catch(() => { /* notice failures are logged inside */ });
    const pkg = packageOf(client);
    const used = getUsage(client.phone);
    return {
      ...client,
      usage: {
        images: used.images, imagesLimit: pkg.imagesPerMonth,
        videos: used.videos, videosLimit: pkg.videosPerMonth,
      },
    };
  }

  // Full scheduling view for a client: plan, cycles, quota cards (included/used/
  // additions/remaining), next delivery, and recent delivery/failure/adjustment
  // history. Reads live from SQLite so it always reflects delivered rows.
  function scheduleView(client) {
    const now = new Date();
    const tz = Q.clientTz(client);
    // Same computation the customer "יתרה" command uses -> identical numbers.
    const quota = clientQuotaSummary(db, client, now);
    return {
      plan: client.package,
      registration_date: client.registration_date,
      send_time: Q.clientSendTime(client),
      timezone: tz,
      status: client.status,
      scheduled_content_enabled: !!client.scheduled_content_enabled,
      // Resolved weekly plan + the ceiling it is checked against, so the panel can
      // render the grid and show "used / allowed" without duplicating the rules.
      week: Q.clientSchedule(client),
      allowance: WEEKLY_ALLOWANCE[client.package] || WEEKLY_ALLOWANCE.basic,
      // Every plan's ceiling, so the panel can re-cap the grid the moment the
      // package dropdown changes instead of waiting for a failed save.
      allowances: WEEKLY_ALLOWANCE,
      week_totals: Q.scheduleTotals(Q.clientSchedule(client)),
      cycles: quota.cycles,
      quota: { story: quota.story, carousel: quota.carousel, reel: quota.reel },
      next_delivery_at: Q.nextDeliveryAt(client, now),
      recent_deliveries: D.listRecentDeliveries(db, client.phone, 15),
      recent_failures: D.listRecentFailures(db, client.phone, 10),
      adjustments: D.listAdjustments(db, client.phone, 15),
    };
  }

  app.get('/api/clients', (req, res) => {
    res.json(listAllClients().map(withUsage));
  });

  app.get('/api/clients/:phone', (req, res) => {
    const c = getClientByPhone(req.params.phone);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ ...withUsage(c), schedule: scheduleView(c) });
  });

  // Manual, additive quota adjustment (audit-logged). Never overwrites usage.
  app.post('/api/clients/:phone/adjustments', (req, res) => {
    const c = getClientByPhone(req.params.phone);
    if (!c) return res.status(404).json({ error: 'not found' });
    const type = String(req.body?.content_type || '');
    if (!['story', 'carousel', 'reel'].includes(type)) {
      return res.status(400).json({ error: 'content_type must be story | carousel | reel' });
    }
    const delta = Math.trunc(Number(req.body?.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'delta חייב להיות מספר שלם שונה מאפס' });
    }
    const now = new Date();
    // Guard: a (negative) adjustment must never push the remaining balance below
    // zero. e.g. client has 2 left, admin tries −7 -> rejected, nothing recorded.
    const check = adjustmentResult(db, c, type, delta, now);
    if (!check.ok) {
      const label = { story: 'סטוריז', carousel: 'קרוסלות', reel: 'רילז' }[type];
      return res.status(400).json({ error: `לא ניתן להפחית ${-delta} ${label} — נותרו רק ${check.remaining}` });
    }
    const ci = Q.cycleInfo(c, Q.localDateStr(now, Q.clientTz(c)));
    const cycleStart = type === 'reel' ? ci.c14Start : ci.weeklyStart;
    D.addAdjustment(db, {
      phone: c.phone, content_type: type, cycle_start: cycleStart, delta,
      reason: String(req.body?.reason || '').slice(0, 300), created_by: 'admin',
    });
    res.json({ ok: true, schedule: scheduleView(getClientByPhone(c.phone)) });
  });

  // --- Global scheduler control + queue health ---
  function schedulerState() {
    const counts = D.statusCounts(db);
    return {
      global_enabled: controls.globalEnabled ? controls.globalEnabled() : false,
      paused: controls.isPaused ? controls.isPaused() : false,
      active: controls.isActive ? controls.isActive() : false,
      concurrency: controls.concurrency || {},
      daily_limits: controls.limiterSnapshot ? controls.limiterSnapshot() : {},
      workers_active: controls.active ? controls.active() : {},
      queue: {
        scheduled: counts.scheduled || 0,
        generating: counts.generating || 0,
        sending: counts.sending || 0,
        delivered: counts.delivered || 0,
        failed: counts.failed || 0,
        unknown_delivery_state: counts.unknown_delivery_state || 0,
        missed: counts.missed || 0,
        oldest_queued: D.oldestQueued(db),
      },
      avg_duration_by_type: D.avgDurationByType(db),
    };
  }

  app.get('/api/scheduler', (req, res) => res.json(schedulerState()));
  app.post('/api/scheduler/pause', (req, res) => { if (controls.pause) controls.pause(); res.json(schedulerState()); });
  app.post('/api/scheduler/resume', (req, res) => { if (controls.resume) controls.resume(); res.json(schedulerState()); });

  // Manual retry of a failed / unknown_delivery_state / missed delivery (human review).
  app.post('/api/deliveries/:id/retry', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const changed = D.retryManual(db, id);
    if (!changed) return res.status(409).json({ error: 'delivery is not in a retryable state' });
    res.json({ ok: true });
  });

  // Parse an ISO-ish datetime (e.g. from <input type="datetime-local">); null if invalid.
  function parseDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Default subscription end: exactly one month after the payment moment.
  // Month-end payments clamp to the last day of the next month (Jan 31 -> Feb 28).
  function plusOneMonth(iso) {
    const d = new Date(iso);
    const day = d.getDate();
    d.setMonth(d.getMonth() + 1);
    if (d.getDate() !== day) d.setDate(0);
    return d.toISOString();
  }

  app.post('/api/clients', (req, res) => {
    const b = req.body || {};
    // Normalised, not just stripped: a local number saved as-is looks fine in the
    // panel and only fails hours later, at send time, as "invalid phone number".
    const phone = normalizePhone(b.phone);
    if (!phone) {
      return res.status(400).json({
        error: 'מספר ווטסאפ לא תקין. הזינו מספר עם קידומת מדינה, למשל 972542889353 או 0542889353',
      });
    }
    if (!b.name || !b.business_name) {
      return res.status(400).json({ error: 'phone, name and business_name are required' });
    }
    // Date validation — format AND business sense.
    if (b.paid_at && !parseDate(b.paid_at)) {
      return res.status(400).json({ error: 'מועד התשלום אינו תאריך תקין' });
    }
    if (b.subscription_ends_at && !parseDate(b.subscription_ends_at)) {
      return res.status(400).json({ error: 'תאריך סיום המנוי אינו תקין' });
    }
    const paidAt = parseDate(b.paid_at);
    let endsAt = parseDate(b.subscription_ends_at);

    const now = Date.now();
    const GRACE_MS = 5 * 60 * 1000;             // clock-skew allowance
    const YEAR_MS = 366 * 24 * 60 * 60 * 1000;  // sanity cap for a monthly product
    if (paidAt && new Date(paidAt).getTime() > now + GRACE_MS) {
      return res.status(400).json({ error: 'מועד התשלום לא יכול להיות בעתיד' });
    }
    if (paidAt && now - new Date(paidAt).getTime() > YEAR_MS) {
      return res.status(400).json({ error: 'מועד התשלום ישן מדי (מעל שנה אחורה) — ודאי שהתאריך נכון' });
    }
    if (paidAt && !endsAt) endsAt = plusOneMonth(paidAt); // default: one month forward
    if (paidAt && endsAt && endsAt <= paidAt) {
      return res.status(400).json({ error: 'תאריך סיום המנוי חייב להיות אחרי מועד התשלום' });
    }
    if (paidAt && endsAt && new Date(endsAt).getTime() - new Date(paidAt).getTime() > YEAR_MS) {
      return res.status(400).json({ error: 'תאריך סיום המנוי רחוק מדי (מעל שנה מהתשלום) — ודאי שהתאריך נכון' });
    }
    if (!paidAt && endsAt) {
      return res.status(400).json({ error: 'נקבע תאריך סיום מנוי בלי מועד תשלום — מלאי קודם את מועד התשלום' });
    }

    let status = ['active', 'suspended', 'canceled'].includes(b.status) ? b.status : 'active';
    // Renewal closes the loop: recording a NEW payment with a future end date
    // reactivates a suspended client automatically (canceled stays canceled).
    const existing = getClientByPhone(phone);
    const newPayment = paidAt && paidAt !== existing?.paid_at;
    const reactivated =
      status === 'suspended' && existing?.status === 'suspended' &&
      newPayment && endsAt && new Date(endsAt).getTime() > Date.now();
    if (reactivated) status = 'active';

    // --- Scheduling fields (optional; DB applies 07:30 / Asia/Jerusalem defaults) ---
    const sendTime = b.send_time ? String(b.send_time).trim() : null;
    if (sendTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(sendTime)) {
      return res.status(400).json({ error: 'שעת שליחה יומית לא תקינה (פורמט HH:MM)' });
    }
    const timezone = b.timezone ? String(b.timezone).trim() : null;
    if (timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
      catch { return res.status(400).json({ error: 'אזור זמן לא תקין' }); }
    }
    // Weekly plan: which weekdays get what. Rejected (not silently trimmed) when it
    // exceeds the package allowance, so the panel can say which type is over.
    let schedule = null;
    if (b.schedule && typeof b.schedule === 'object') {
      schedule = {};
      for (let d = 0; d <= 6; d++) {
        const day = b.schedule[d] || b.schedule[String(d)] || {};
        schedule[d] = {};
        for (const t of CONTENT_TYPES) {
          const n = Number(day[t]);
          if (day[t] != null && (!Number.isFinite(n) || n < 0)) {
            return res.status(400).json({ error: 'כמות לא תקינה בלוח השבועי' });
          }
          schedule[d][t] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        }
      }
      const newPkg = b.package || 'basic';
      const allowance = WEEKLY_ALLOWANCE[newPkg] || WEEKLY_ALLOWANCE.basic;
      const totals = Q.scheduleTotals(schedule);
      const label = { story: 'סטוריז', carousel: 'קרוסלות', reel: 'רילז' };
      // Downgrading a plan necessarily leaves the old schedule over the new budget.
      // Rejecting that would deadlock the change — the admin would have to hand-trim
      // the grid before the package could be switched at all — so a package change
      // trims instead, and only an over-budget edit WITHIN a plan is refused.
      const downgraded = existing && existing.package !== newPkg;
      const over = CONTENT_TYPES.filter((t) => totals[t] > allowance[t]);
      if (over.length && !downgraded) {
        const t = over[0];
        return res.status(400).json({
          error: `הלוח השבועי חורג מהמכסה: ${label[t]} ${totals[t]} מתוך ${allowance[t]} המותרים בחבילה`,
        });
      }
      if (over.length) {
        schedule = Q.clientSchedule({ ...existing, package: newPkg, schedule });
        logger.info('admin', `${phone} moved to ${newPkg} — schedule trimmed to fit (${over.join(', ')})`);
      }
    }

    const registrationDate = b.registration_date ? parseDate(b.registration_date) : null;
    if (b.registration_date && !registrationDate) {
      return res.status(400).json({ error: 'תאריך רישום לא תקין' });
    }

    upsertClient({
      phone,
      name: b.name,
      business_name: b.business_name,
      package: b.package || 'basic',
      status,
      profile: b.profile || {},
      paid_at: paidAt,
      subscription_ends_at: endsAt,
      registration_date: registrationDate,
      send_time: sendTime,
      timezone,
      scheduled_content_enabled: typeof b.scheduled_content_enabled === 'boolean' ? b.scheduled_content_enabled : undefined,
      schedule,
    });
    if (reactivated) logger.info('admin', `new payment recorded for ${phone} — auto-reactivated`);

    // A client that becomes eligible partway through the day must NOT receive that
    // day's batch — creating a client at 14:00 should start delivery tomorrow, not
    // fire immediately. Seal today off by writing its items as 'skipped'; the next
    // tick's INSERT OR IGNORE then finds the keys taken and enqueues nothing.
    const saved = getClientByPhone(phone);
    const wasEligible = !!(existing && existing.scheduled_content_enabled && existing.status === 'active');
    const nowEligible = !!(saved.scheduled_content_enabled && saved.status === 'active');
    if (nowEligible && !wasEligible) {
      const now = new Date();
      if (Q.isPastSendTime(saved, now)) {
        const todayStr = Q.localDateStr(now, Q.clientTz(saved));
        const sealed = D.seedSkippedItems(db, Q.dueItems(saved, todayStr));
        if (sealed) logger.info('admin', `${phone} enabled after today's send time — sealed ${sealed} item(s) as skipped`);
      }
    }
    res.json({ ...saved, reactivated });
  });

  app.delete('/api/clients/:phone', (req, res) => {
    deleteClient(req.params.phone);
    res.json({ ok: true });
  });

  // Generate + send content now (does not wait — returns immediately).
  app.post('/api/clients/:phone/generate', (req, res) => {
    const phone = req.params.phone;
    const c = getClientByPhone(phone);
    if (!c) return res.status(404).json({ error: 'not found' });
    runDailyTick({ onlyPhone: phone }).catch((err) =>
      logger.error('admin', 'generate error', err)
    );
    res.json({ ok: true, message: 'Generation started; content will arrive on WhatsApp shortly.' });
  });

  return app;
}

export function startAdmin(controls = {}) {
  const app = createAdminApp(controls);
  app.listen(config.adminPort, () => {
    logger.info('admin', `panel on http://localhost:${config.adminPort}`);
    if (!config.adminPasswordHash) {
      logger.warn('admin', 'using plaintext ADMIN_PASSWORD. Run `npm run hash-password` and set ADMIN_PASSWORD_HASH for production.');
    }
    if (!process.env.SESSION_SECRET) {
      logger.warn('admin', 'SESSION_SECRET not set — sessions reset on restart. Set it in production.');
    }
  });
}

// Allow running the admin panel standalone: `npm run admin`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('admin.js')) {
  startAdmin();
}
