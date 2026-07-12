// Manually trigger the daily content for testing.
// Usage: npm run send-daily            -> sends to ALL active clients now (ignores send_hour)
//        npm run send-daily -- 9725... -> sends only to that phone
import { validateConfig } from '../src/config.js';
import { runDailyTick } from '../src/daily.js';

const missing = validateConfig();
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const onlyPhone = process.argv[2] ? String(process.argv[2]).replace(/\D/g, '') : null;
await runDailyTick({ force: true, onlyPhone });
console.log('Done.');
