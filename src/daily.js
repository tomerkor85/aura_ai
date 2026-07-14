import { getClientByPhone, listActiveClients, appendHistory } from './db.js';
import { generateDailyContent } from './agent.js';
import { sendText, sendVisual } from './greenapi.js';
import { createImage } from './openai_images.js';

// How many stories the manual "Generate now" button produces.
const STORIES_PER_PACK = 3;

async function sendContentPack(client) {
  console.log(`[content] Generating for ${client.business_name} (${client.phone})...`);
  const content = await generateDailyContent(client, { stories: STORIES_PER_PACK, carousel: false });

  await sendText(client.phone, `${client.name}, הכנתי לך תוכן חדש ל${client.business_name} ✨`);

  for (let i = 0; i < content.stories.length; i++) {
    const s = content.stories[i];
    // Send the matching branded image first, then its copy, so each story arrives as a pair.
    if (s.image_prompt) {
      try {
        const { b64 } = await createImage(s.image_prompt);
        await sendVisual(client.phone, { type: 'base64', data: b64 }, { caption: `סטורי ${i + 1}` });
      } catch (err) {
        console.error(`[content] image failed for ${client.phone}:`, err.message);
      }
    }
    await sendText(client.phone, `*סטורי ${i + 1}:*\n${s.text}\n\n_קונספט ויזואלי:_ ${s.visual_concept}`);
  }

  await sendText(client.phone, 'רוצה שינוי, גרסה נוספת או ויזואל? פשוט תכתבו לי כאן 💬');
  appendHistory(client.phone, 'assistant', `[תוכן יזום נשלח: ${content.stories.length} סטוריז + תמונות]`);
  console.log(`[content] Sent to ${client.business_name}`);
}

// Manual "Generate content now" — triggered from the admin panel (not scheduled).
// onlyPhone: generate for one client; otherwise all active clients.
export async function runDailyTick({ onlyPhone = null } = {}) {
  const clients = onlyPhone
    ? [getClientByPhone(onlyPhone)].filter(Boolean)
    : listActiveClients();

  for (const client of clients) {
    if (client.status !== 'active') continue;
    try {
      await sendContentPack(client);
    } catch (err) {
      console.error(`[content] Failed for ${client.phone}:`, err.message);
    }
  }
}
