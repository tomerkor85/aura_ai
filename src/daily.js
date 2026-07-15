import { packageOf } from './config.js';
import {
  getClientByPhone, listActiveClients, appendHistory,
  startImageState, getUsage, incrementUsage,
} from './db.js';
import { enforceExpiry } from './subscription.js';
import { generateDailyContent } from './agent.js';
import { sendText, sendVisual } from './greenapi.js';
import { createImage } from './openai_images.js';
import { logger } from './logger.js';

// How many stories the manual "Generate now" button produces.
const STORIES_PER_PACK = 3;

async function sendContentPack(client) {
  logger.info('content', `generating for ${client.business_name} (${client.phone})`);
  const content = await generateDailyContent(client, { stories: STORIES_PER_PACK, carousel: false });

  await sendText(client.phone, `${client.name}, הכנתי לך תוכן חדש ל${client.business_name} ✨`);

  const pkg = packageOf(client);
  for (let i = 0; i < content.stories.length; i++) {
    const s = content.stories[i];
    // Pack images count against the same monthly quota as chat images.
    if (getUsage(client.phone).images >= pkg.imagesPerMonth) {
      logger.warn('content', `${client.phone} hit the monthly image quota — sending remaining stories as text`);
      await sendText(client.phone, `*סטורי ${i + 1}:*\n${s.text}`);
      continue;
    }
    // The story copy is embedded inside the image itself — the image is the
    // finished deliverable, so no separate text message per story.
    try {
      const { b64, responseId } = await createImage(s.image_prompt);
      incrementUsage(client.phone, 'image');
      // Register as the client's last editable image so "תגדילי", "רקע אחר"
      // in chat edits THIS image (the newest one they received).
      startImageState(client.phone, responseId, client.profile);
      await sendVisual(client.phone, { type: 'base64', data: b64 }, { caption: `סטורי ${i + 1}` });
    } catch (err) {
      logger.error('content', `image failed for ${client.phone}`, err);
      // Fallback: if the image failed, at least deliver the copy as text.
      await sendText(client.phone, `*סטורי ${i + 1}:*\n${s.text}`);
    }
  }

  await sendText(client.phone, 'רוצה שינוי, גרסה נוספת או ויזואל? פשוט תכתבו לי כאן 💬');
  appendHistory(client.phone, 'assistant', `[תוכן יזום נשלח: ${content.stories.length} סטוריז + תמונות]`);
  logger.info('content', `sent to ${client.business_name}`);
}

// Manual "Generate content now" — triggered from the admin panel (not scheduled).
// onlyPhone: generate for one client; otherwise all active clients.
export async function runDailyTick({ onlyPhone = null } = {}) {
  const clients = onlyPhone
    ? [getClientByPhone(onlyPhone)].filter(Boolean)
    : listActiveClients();

  for (const client of clients) {
    if (await enforceExpiry(client)) {
      logger.warn('content', `subscription expired for ${client.phone} — skipping pack`);
      continue;
    }
    if (client.status !== 'active') continue;
    try {
      await sendContentPack(client);
    } catch (err) {
      logger.error('content', `failed for ${client.phone}`, err);
    }
  }
}
