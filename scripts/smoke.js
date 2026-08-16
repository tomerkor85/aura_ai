// Smoke test: verifies modules load, DB schema builds, and prompts render. No API calls.
import { PACKAGES } from '../src/config.js';
import {
  upsertClient, getClientByPhone, getImageState, startImageState, recordImageEdit,
  getUsage, incrementUsage, currentMonth,
} from '../src/db.js';
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

// image_state: create resets counter, edits increment and preserve snapshot
startImageState('972500000000', 'resp_1', client.profile);
let st = getImageState('972500000000');
if (st.last_response_id !== 'resp_1' || st.edit_count !== 0 || !st.brand_snapshot) throw new Error('startImageState failed');
recordImageEdit('972500000000', 'resp_2');
recordImageEdit('972500000000', 'resp_3');
st = getImageState('972500000000');
if (st.last_response_id !== 'resp_3' || st.edit_count !== 2 || !st.brand_snapshot) throw new Error('recordImageEdit failed');
startImageState('972500000000', 'resp_4', client.profile); // new image resets counter
st = getImageState('972500000000');
if (st.edit_count !== 0) throw new Error('edit_count reset on new image failed');

// usage: month key renders, counters increment per kind
if (!/^\d{4}-\d{2}$/.test(currentMonth())) throw new Error('currentMonth format wrong');
const before = getUsage('972500000000');
incrementUsage('972500000000', 'image');
incrementUsage('972500000000', 'video');
const after = getUsage('972500000000');
if (after.images !== before.images + 1 || after.videos !== before.videos + 1) {
  throw new Error('incrementUsage failed');
}

console.log('Smoke test passed: DB, prompts, usage counters, image_state + edit limits, module loads all OK.');
