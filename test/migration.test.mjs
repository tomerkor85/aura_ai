import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScheduleSchema } from '../src/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('16. Existing clients migrate safely without data loss', () => {
  const db = new Database(':memory:');
  // OLD pre-feature schema: no registration_date/send_time/timezone.
  db.exec(`CREATE TABLE clients (
    phone TEXT PRIMARY KEY, name TEXT, business_name TEXT,
    package TEXT DEFAULT 'basic', status TEXT DEFAULT 'active', profile TEXT, created_at TEXT
  );`);
  db.prepare("INSERT INTO clients (phone,name,business_name,package,status,profile,created_at) VALUES ('9725','דנה','עסק','premium','active',?,?)")
    .run(JSON.stringify({ about: 'x' }), '2026-07-10 09:00:00');

  applyScheduleSchema(db);

  const row = db.prepare("SELECT * FROM clients WHERE phone='9725'").get();
  // Original data untouched
  assert.equal(row.name, 'דנה');
  assert.equal(row.business_name, 'עסק');
  assert.equal(row.package, 'premium');
  assert.equal(row.status, 'active');
  assert.equal(JSON.parse(row.profile).about, 'x');
  // Backfilled defaults
  assert.equal(row.registration_date, '2026-07-10 09:00:00', 'registration_date <- created_at');
  assert.equal(row.send_time, '07:30');
  assert.equal(row.timezone, 'Asia/Jerusalem');
});

test('Existing clients default scheduled_content_enabled = 0 (opt-in off)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE clients (phone TEXT PRIMARY KEY, name TEXT, business_name TEXT, package TEXT DEFAULT 'basic', status TEXT DEFAULT 'active', profile TEXT, created_at TEXT);");
  db.prepare("INSERT INTO clients (phone,name,business_name,package,status,profile,created_at) VALUES ('1','a','b','basic','active','{}','2026-07-10 09:00:00')").run();
  applyScheduleSchema(db);
  assert.equal(db.prepare("SELECT scheduled_content_enabled FROM clients WHERE phone='1'").get().scheduled_content_enabled, 0);
});

test('applyScheduleSchema is idempotent (safe to run repeatedly)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE clients (phone TEXT PRIMARY KEY, name TEXT, business_name TEXT, package TEXT, status TEXT, profile TEXT, created_at TEXT);");
  applyScheduleSchema(db);
  applyScheduleSchema(db); // must not throw or lose data
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_deliveries'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quota_adjustments'").get());
});

test('Backfill does not overwrite an already-set registration/send/timezone', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE clients (phone TEXT PRIMARY KEY, name TEXT, business_name TEXT, package TEXT, status TEXT, profile TEXT, created_at TEXT);");
  applyScheduleSchema(db);
  db.prepare("INSERT INTO clients (phone,name,business_name,package,status,profile,created_at,registration_date,send_time,timezone) VALUES ('1','a','b','basic','active','{}','2026-01-01','2026-06-01T00:00:00Z','09:15','America/New_York')").run();
  applyScheduleSchema(db); // re-run
  const r = db.prepare("SELECT * FROM clients WHERE phone='1'").get();
  assert.equal(r.send_time, '09:15');
  assert.equal(r.timezone, 'America/New_York');
  assert.equal(r.registration_date, '2026-06-01T00:00:00Z');
});

test('db.js no longer runs destructive daily_log / send_hour startup drops', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'db.js'), 'utf8');
  assert.doesNotMatch(src, /DROP TABLE IF EXISTS daily_log/, 'daily_log drop must be removed');
  assert.doesNotMatch(src, /DROP COLUMN send_hour/, 'send_hour drop must be removed');
});
