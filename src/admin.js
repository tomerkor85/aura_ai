import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, packageOf } from './config.js';
import { listAllClients, getClientByPhone, upsertClient, deleteClient, getUsage } from './db.js';
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

export function createAdminApp() {
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

  app.get('/api/clients', (req, res) => {
    res.json(listAllClients().map(withUsage));
  });

  app.get('/api/clients/:phone', (req, res) => {
    const c = getClientByPhone(req.params.phone);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(withUsage(c));
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
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!phone || !b.name || !b.business_name) {
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

    upsertClient({
      phone,
      name: b.name,
      business_name: b.business_name,
      package: b.package || 'basic',
      status,
      profile: b.profile || {},
      paid_at: paidAt,
      subscription_ends_at: endsAt,
    });
    if (reactivated) logger.info('admin', `new payment recorded for ${phone} — auto-reactivated`);
    res.json({ ...getClientByPhone(phone), reactivated });
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

export function startAdmin() {
  const app = createAdminApp();
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
