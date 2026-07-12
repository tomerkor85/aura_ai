import { config, PACKAGES } from './config.js';
import { listActiveClients, wasSentToday, markSentToday, appendHistory } from './db.js';
import { generateDailyContent } from './agent.js';
import { sendText, sendVisual } from './greenapi.js';
import { generateImage } from './visual.js';

function nowInTz() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24,
    weekday: weekdayMap[parts.weekday],
  };
}

async function sendDailyToClient(client, { weekday, date }) {
  const pkg = PACKAGES[client.package] || PACKAGES.basic;
  const withCarousel = pkg.carouselDays.includes(weekday);

  console.log(`[daily] Generating for ${client.business_name} (${client.phone})...`);
  const content = await generateDailyContent(client, {
    stories: pkg.storiesPerDay,
    carousel: withCarousel,
  });

  await sendText(client.phone, `בוקר טוב ${client.name}! ☀️ הנה התוכן היומי של ${client.business_name}:`);

  for (let i = 0; i < content.stories.length; i++) {
    const s = content.stories[i];
    const msg = `*סטורי ${i + 1}:*\n${s.text}\n\n_קונספט ויזואלי:_ ${s.visual_concept}`;
    await sendText(client.phone, msg);

    if (config.dailyImages && s.image_prompt) {
      try {
        const visual = await generateImage(s.image_prompt);
        await sendVisual(client.phone, visual, { caption: `ויזואל לסטורי ${i + 1}` });
      } catch (err) {
        console.error(`[daily] image failed for ${client.phone}:`, err.message);
      }
    }
  }

  if (withCarousel && content.carousel) {
    const slides = content.carousel.slides
      .map((sl, i) => `*שקף ${i + 1}:* ${sl.text}\n_ויזואל:_ ${sl.visual}`)
      .join('\n\n');
    await sendText(client.phone, `*קרוסלה לאינסטגרם — ${content.carousel.title}*\n\n${slides}`);
  }

  await sendText(client.phone, 'רוצה שינוי, גרסה נוספת או ויזואל? פשוט תכתבו לי כאן 💬');

  appendHistory(client.phone, 'assistant', `[תוכן יומי נשלח: ${content.stories.length} סטוריז${withCarousel ? ' + קרוסלה' : ''}]`);
  markSentToday(client.phone, date);
  console.log(`[daily] Sent to ${client.business_name}`);
}

// Called every hour by the scheduler; sends to clients whose send_hour matches now.
export async function runDailyTick({ force = false, onlyPhone = null } = {}) {
  const { date, hour, weekday } = nowInTz();
  const clients = listActiveClients();

  for (const client of clients) {
    if (onlyPhone && client.phone !== onlyPhone) continue;
    if (!force && client.send_hour !== hour) continue;
    if (!force && wasSentToday(client.phone, date)) continue;
    try {
      await sendDailyToClient(client, { weekday, date });
    } catch (err) {
      console.error(`[daily] Failed for ${client.phone}:`, err.message);
    }
  }
}
