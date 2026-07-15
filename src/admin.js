import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, packageOf } from './config.js';
import { listAllClients, getClientByPhone, upsertClient, deleteClient, getUsage } from './db.js';
import { runDailyTick } from './daily.js';
import {
  verifyPassword, createToken, verifyToken, parseCookie, sessionCookie, clearCookie,
  COOKIE_NAME, loginBlocked, recordFailure, recordSuccess,
} from './auth.js';

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
  function withUsage(client) {
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

  app.post('/api/clients', (req, res) => {
    const b = req.body || {};
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!phone || !b.name || !b.business_name) {
      return res.status(400).json({ error: 'phone, name and business_name are required' });
    }
    upsertClient({
      phone,
      name: b.name,
      business_name: b.business_name,
      package: b.package || 'basic',
      status: ['active', 'suspended', 'canceled'].includes(b.status) ? b.status : 'active',
      profile: b.profile || {},
    });
    res.json(getClientByPhone(phone));
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
      console.error('[admin] generate error:', err.message)
    );
    res.json({ ok: true, message: 'Generation started; content will arrive on WhatsApp shortly.' });
  });

  return app;
}

export function startAdmin() {
  const app = createAdminApp();
  app.listen(config.adminPort, () => {
    console.log(`[admin] panel on http://localhost:${config.adminPort}`);
    if (!config.adminPasswordHash) {
      console.warn('[admin] WARNING: using plaintext ADMIN_PASSWORD. Run `npm run hash-password` and set ADMIN_PASSWORD_HASH for production.');
    }
    if (!process.env.SESSION_SECRET) {
      console.warn('[admin] WARNING: SESSION_SECRET not set — sessions reset on restart. Set it in production.');
    }
  });
}

// Allow running the admin panel standalone: `npm run admin`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('admin.js')) {
  startAdmin();
}
