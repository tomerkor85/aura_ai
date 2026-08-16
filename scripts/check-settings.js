// Check (and optionally fix) Green API instance settings that control whether
// INCOMING messages reach our polling loop.
// Usage: npm run check-settings           -> shows the relevant flags
//        npm run check-settings -- --fix  -> enables incoming notifications
import { config } from '../src/config.js';
import { getSettings, setSettings } from '../src/greenapi.js';

if (!config.greenApi.idInstance || !config.greenApi.token) {
  console.error('Missing GREEN_API_ID_INSTANCE / GREEN_API_TOKEN in .env');
  process.exit(1);
}

const s = await getSettings();
console.log('Current notification settings:');
console.log('  incomingWebhook       :', s.incomingWebhook, '(must be "yes" to receive incoming messages)');
console.log('  outgoingWebhook       :', s.outgoingWebhook);
console.log('  outgoingMessageWebhook:', s.outgoingMessageWebhook);
console.log('  stateWebhook          :', s.stateWebhook);

if (s.incomingWebhook !== 'yes') {
  console.log('\n⚠️  incomingWebhook is OFF — AURA will NOT receive client messages.');
  if (process.argv.includes('--fix')) {
    await setSettings({ incomingWebhook: 'yes' });
    console.log('✅ Enabled incomingWebhook. The instance reboots — wait ~1 minute, then restart AURA.');
  } else {
    console.log('   Run `npm run check-settings -- --fix` to enable it.');
  }
} else {
  console.log('\n✅ incomingWebhook is ON — incoming messages will be delivered.');
}
