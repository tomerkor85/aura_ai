// Turns a queue job into generated + delivered WhatsApp content.
//
// Contract: processItem(item, { markSending, setProgress, setPayload }) generates
// the asset(s), calls markSending() immediately before the FIRST WhatsApp send,
// sends, and returns { wa_message_id }. It throws:
//   - a normal/retryable Error  -> nothing new was delivered; safe to retry
//   - err.throttled = true      -> a daily cap was hit mid-flight; keep queued
//   - err.terminal = true       -> permanent (bad client/type); do not retry
// A crash/timeout while in `sending` is handled by the queue reaper as
// `unknown_delivery_state` (manual review) — never here.
//
// Carousels are resumable: the plan (prompts/text, small) is persisted, and
// `progress` records how many send-steps already succeeded. A retry re-renders and
// re-sends ONLY the missing slides — delivered slides are never re-sent.
//
// Dependencies are injected so tests drive the whole pipeline with fakes + a fake
// clock (no OpenAI/Seedance/Green API).

import * as realMedia from './media-cache.js';

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`generation timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([Promise.resolve().then(() => promise), timeout]).finally(() => clearTimeout(t));
}

// deps: { getClient, generators:{story, carouselPlan, reel}, renderImage,
//         senders:{sendText,sendVisual,sendFileByUrl}, sendGate, clock, logger, genTimeoutMs }
export function makeProcessItem(deps) {
  const { getClient, generators, renderImage, senders, clock, logger, genTimeoutMs = 300_000 } = deps;
  // Injected like every other dependency here so tests exercise the reuse path
  // in memory, without writing generated assets to disk.
  const media = deps.media || realMedia;
  const sendGate = deps.sendGate || ((fn) => fn());
  const gen = (p, label) => withTimeout(p, genTimeoutMs, label);

  // The image is a paid generation; the send is what fails. Persist the artifact the
  // moment it exists so a retry re-sends it instead of buying another one.
  async function processStory(client, item, markSending, setPayload) {
    const saved = item.payload ? JSON.parse(item.payload) : null;
    let image = null;
    let caption = (saved && saved.caption) || '';

    if (saved && saved.url) image = { type: 'url', url: saved.url };
    else if (saved && saved.file) {
      const data = media.loadImage(saved.file);
      if (data) image = { type: 'base64', data };
    }

    if (image) {
      logger.info('deliver', `story #${item.id} reusing cached asset (no regeneration)`);
    } else {
      const a = await gen(generators.story(client, item), `story ${client.phone}`);
      image = a.image;
      caption = a.caption || '';
      if (image.type === 'base64') {
        const file = media.saveImage(item.id, 'story', image.data);
        if (file) setPayload(JSON.stringify({ file, caption }));
      } else {
        setPayload(JSON.stringify({ url: image.url, caption }));
      }
    }

    markSending();
    const res = await sendGate(() => senders.sendVisual(client.phone, image, { caption }));
    return { wa_message_id: res && res.idMessage };
  }

  async function processReel(client, item, markSending) {
    const a = await gen(generators.reel(client, item), `reel ${client.phone}`);
    markSending();
    const res = await sendGate(() => senders.sendFileByUrl(client.phone, a.videoUrl, { fileName: 'reel.mp4', caption: a.caption || '' }));
    return { wa_message_id: res && res.idMessage };
  }

  async function processCarousel(client, item, markSending, setProgress, setPayload) {
    // Plan (LLM, small) AND the rendered slides are persisted: the plan so retries
    // resume at slide level, the images because each is a paid generation that a
    // failed send would otherwise buy again.
    const stored = item.payload ? JSON.parse(item.payload) : null;
    // Legacy rows stored the bare plan; anything with `.plan` is the current shape.
    let plan = stored && (stored.plan || (stored.slides ? stored : null));
    const files = (stored && stored.files) || {};
    const persist = () => setPayload(JSON.stringify({ plan, files }));

    if (!plan) {
      plan = await gen(generators.carouselPlan(client), `carousel-plan ${client.phone}`);
      persist();
    }
    const slides = plan.slides || [];
    const total = slides.length + (plan.postText ? 1 : 0);
    const start = Math.min(item.progress || 0, total);

    // Generation phase (retryable): render the not-yet-sent slides, reusing any
    // that a previous attempt already paid for.
    const slideStart = Math.min(start, slides.length);
    const rendered = [];
    for (let i = slideStart; i < slides.length; i++) {
      const cached = files[i] && media.loadImage(files[i]);
      if (cached) {
        rendered.push({ image: { type: 'base64', data: cached } });
        continue;
      }
      const r = await gen(renderImage(slides[i].image_prompt), `carousel-slide ${client.phone}#${i + 1}`);
      if (r.image && r.image.type === 'base64') {
        const file = media.saveImage(item.id, `slide${i}`, r.image.data);
        if (file) { files[i] = file; persist(); }
      }
      rendered.push(r);
    }

    // Send phase: resume from `start`; a caught error here leaves `progress` at the
    // last DELIVERED step so the next attempt re-sends only what's missing.
    markSending();
    let step = start;
    let lastId;
    for (let i = slideStart; i < slides.length; i++) {
      const r = await sendGate(() => senders.sendVisual(client.phone, rendered[i - slideStart].image, { caption: '' }));
      lastId = (r && r.idMessage) || lastId;
      step = i + 1;
      setProgress(step);
    }
    if (plan.postText && step < total) {
      const r = await sendGate(() => senders.sendText(client.phone, plan.postText));
      lastId = (r && r.idMessage) || lastId;
      step = total;
      setProgress(step);
    }
    return { wa_message_id: lastId };
  }

  return async function processItem(item, { markSending, setProgress, setPayload }) {
    const client = getClient(item.phone);
    if (!client) { const e = new Error(`client ${item.phone} not found`); e.terminal = true; throw e; }
    if (client.status !== 'active') { const e = new Error(`client ${item.phone} not active (${client.status})`); e.terminal = true; throw e; }
    logger.info('deliver', `${item.status === 'scheduled' ? 'processing' : 'resuming'} ${item.content_type} #${item.id} for ${client.business_name} (${client.phone})`);
    switch (item.content_type) {
      case 'story': return processStory(client, item, markSending, setPayload);
      case 'reel': return processReel(client, item, markSending);
      case 'carousel': return processCarousel(client, item, markSending, setProgress, setPayload);
      default: { const e = new Error(`unknown content_type ${item.content_type}`); e.terminal = true; throw e; }
    }
  };
}
