import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { config } from './config.js';

// ============================================================================
// Auth for the admin panel: hashed password + signed, expiring session cookie.
// Single operator model (no user accounts) — but hardened for the public web.
// ============================================================================

const COOKIE = 'aura_session';
const TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// --- Password hashing (scrypt) ---

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const dk = scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${dk}`;
}

function verifyAgainstHash(pw, stored) {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, key] = parts;
  const keyBuf = Buffer.from(key, 'hex');
  let dk;
  try {
    dk = scryptSync(pw, salt, keyBuf.length);
  } catch {
    return false;
  }
  return keyBuf.length === dk.length && timingSafeEqual(keyBuf, dk);
}

// Verify a login attempt against the configured credential (hash preferred,
// plaintext fallback for local dev). Always timing-safe.
export function verifyPassword(input) {
  const pw = String(input ?? '');
  if (config.adminPasswordHash) return verifyAgainstHash(pw, config.adminPasswordHash);
  // Fallback: constant-time compare against plaintext ADMIN_PASSWORD
  const a = Buffer.from(pw);
  const b = Buffer.from(String(config.adminPassword));
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Signed session tokens (HMAC) ---

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function createToken() {
  const payload = { exp: Date.now() + TTL_MS, n: randomBytes(8).toString('hex') };
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [body, mac] = token.split('.');
  const expected = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

// --- Cookie helpers ---

export function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function sessionCookie(req, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || config.forceSecureCookie;
  const attrs = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export const COOKIE_NAME = COOKIE;

// --- Login rate limiting (in-memory, per IP) ---

const attempts = new Map(); // ip -> { count, first }
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export function loginBlocked(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

export function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

export function recordSuccess(ip) {
  attempts.delete(ip);
}
