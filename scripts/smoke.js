// Smoke test: verifies modules load, DB schema builds, and prompts render. No API calls.
import { PACKAGES } from '../src/config.js';
import { upsertClient, getClientByPhone, getImageState, setImageState } from '../src/db.js';
import { buildSystemPrompt, buildDailyPrompt } from '../src/prompts.js';
import { parseIncoming, phoneToChatId } from '../src/greenapi.js';
// Import the heavy modules to catch load/syntax errors (no API calls made).
import '../src/agent.js';
import '../src/openai_images.js';
import '../src/visual.js';
import fs from 'node:fs';

const example = JSON.parse(fs.readFileSync(new URL('../clients/example-client.json', import.meta.url), 'utf-8'));

upsertClient({
  phone: '972500000000',
  name: example.name,
  business_name: example.business_name,
  package: 'basic',
  send_hour: 8,
  profile: example.profile,
});

const client = getClientByPhone('972500000000');
if (!client) throw new Error('DB roundtrip failed');

const sys = buildSystemPrompt(client);
if (!sys.includes(client.business_name)) throw new Error('System prompt missing business name');

const daily = buildDailyPrompt(client, { stories: 2, carousel: true });
if (!daily.includes('2 סטוריז')) throw new Error('Daily prompt missing story count');

const incoming = parseIncoming({
  typeWebhook: 'incomingMessageReceived',
  senderData: { chatId: '972500000000@c.us' },
  messageData: { textMessageData: { textMessage: 'שלום' } },
});
if (incoming?.phone !== '972500000000' || incoming?.text !== 'שלום') {
  throw new Error('parseIncoming failed');
}

if (phoneToChatId('972500000000') !== '972500000000@c.us') throw new Error('phoneToChatId failed');
if (!PACKAGES.basic || !PACKAGES.premium) throw new Error('PACKAGES missing');

// image_state round-trip: create sets snapshot, edit preserves it
setImageState('972500000000', 'resp_1', client.profile);
let st = getImageState('972500000000');
if (st.last_response_id !== 'resp_1' || !st.brand_snapshot) throw new Error('setImageState create failed');
setImageState('972500000000', 'resp_2', null); // edit: keep snapshot
st = getImageState('972500000000');
if (st.last_response_id !== 'resp_2' || !st.brand_snapshot) throw new Error('setImageState edit-preserve failed');

console.log('Smoke test passed: DB, prompts, image_state, module loads all OK.');
