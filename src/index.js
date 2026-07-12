import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { getClientByPhone } from './db.js';
import { receiveNotification, deleteNotification, parseIncoming, sendText } from './greenapi.js';
import { handleChatMessage } from './agent.js';
import { runDailyTick } from './daily.js';
import { startAdmin } from './admin.js';

const missing = validateConfig();
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the keys.');
  process.exit(1);
}

console.log('AURA is starting...');
console.log(`Model: ${config.claudeModel} | TZ: ${config.tz} | Daily images: ${config.dailyImages}`);

// Start the admin panel (client management UI) alongside the agent.
startAdmin();

// --- Incoming message loop (Green API polling) ---
let polling = true;

async function pollLoop() {
  while (polling) {
    try {
      const notification = await receiveNotification();
      if (!notification) continue; // long-poll returned empty; loop again

      const { receiptId, body } = notification;
      try {
        const incoming = parseIncoming(body);
        if (incoming) {
          await handleIncoming(incoming.phone, incoming.text);
        }
      } finally {
        await deleteNotification(receiptId);
      }
    } catch (err) {
      console.error('[poll] error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function handleIncoming(phone, text) {
  console.log(`[in] ${phone}: ${text.slice(0, 80)}`);
  const client = getClientByPhone(phone);
  if (!client) {
    console.log(`[in] Unknown number ${phone} - ignoring`);
    return;
  }
  if (client.status !== 'active') return;

  try {
    const reply = await handleChatMessage(client, text);
    if (reply) {
      await sendText(phone, reply);
      console.log(`[out] ${phone}: ${reply.slice(0, 80)}`);
    }
  } catch (err) {
    console.error(`[agent] error for ${phone}:`, err.message);
    await sendText(phone, 'אופס, נתקלתי בתקלה רגעית. נסו לשלוח שוב בעוד רגע 🙏');
  }
}

// --- Daily content scheduler: every hour on the hour ---
cron.schedule('0 * * * *', () => {
  runDailyTick().catch((err) => console.error('[daily] tick error:', err.message));
});

// Also run once at startup in case we restarted past a send hour
runDailyTick().catch((err) => console.error('[daily] startup tick error:', err.message));

pollLoop();

process.on('SIGINT', () => {
  polling = false;
  console.log('\nAURA stopped.');
  process.exit(0);
});
