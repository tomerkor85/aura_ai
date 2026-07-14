// Verify the Green API instance is connected (authorized).
// Usage: npm run check-wa                 -> prints the auth state
//        npm run check-wa -- 972501234567 -> also sends a test message to that number
import { config } from '../src/config.js';
import { getStateInstance, sendText } from '../src/greenapi.js';

if (!config.greenApi.idInstance || !config.greenApi.token) {
  console.error('Missing GREEN_API_ID_INSTANCE / GREEN_API_TOKEN in .env');
  process.exit(1);
}

const state = await getStateInstance();
console.log('Green API state:', state.stateInstance);

if (state.stateInstance !== 'authorized') {
  console.error('\nNot authorized yet. In the Green API console open your instance,');
  console.error('get the QR, and scan it from WhatsApp → Linked Devices → Link a device.');
  process.exit(1);
}

const testPhone = process.argv[2] ? String(process.argv[2]).replace(/\D/g, '') : null;
if (testPhone) {
  await sendText(testPhone, 'בדיקת חיבור AURA ✅ — המערכת מחוברת לווטסאפ.');
  console.log(`Test message sent to ${testPhone}.`);
} else {
  console.log('Authorized ✅  (add a phone number to also send a test message)');
}
