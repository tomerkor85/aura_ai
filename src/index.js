import { config, validateConfig } from './config.js';
import { getClientByPhone } from './db.js';
import { receiveNotification, deleteNotification, parseIncoming, sendText } from './greenapi.js';
import { handleChatMessage } from './agent.js';
import { startAdmin } from './admin.js';

const missing = validateConfig();
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the keys.');
  process.exit(1);
}

console.log('AURA is starting...');
console.log(`Model: ${config.claudeModel} | conversational mode (no scheduled sends)`);

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
      console.log(`[poll] notification: ${body?.typeWebhook || 'unknown'}`);
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
    console.log(`[agent] generating reply for ${phone} (provider: ${config.textProvider})...`);
    const reply = await handleChatMessage(client, text);
    if (reply) {
      await sendText(phone, reply);
      console.log(`[out] ${phone}: ${reply.slice(0, 80)}`);
    } else {
      console.log(`[agent] no text reply (media may have been sent via a tool).`);
    }
  } catch (err) {
    console.error(`[agent] error for ${phone}:`, err.stack || err.message);
    await sendText(phone, 'אופס, נתקלתי בתקלה רגעית. נסו לשלוח שוב בעוד רגע 🙏');
  }
}

// AURA is conversational: it responds when a client messages, and content can be
// generated on demand from the admin panel ("Generate now"). No scheduled sends.
pollLoop();

process.on('SIGINT', () => {
  polling = false;
  console.log('\nAURA stopped.');
  process.exit(0);
});
