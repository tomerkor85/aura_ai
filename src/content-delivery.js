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
  const sendGate = deps.sendGate || ((fn) => fn());
  const gen = (p, label) => withTimeout(p, genTimeoutMs, label);

  async function processStory(client, item, markSending) {
    const a = await gen(generators.story(client, item), `story ${client.phone}`);
    markSending();
    const res = await sendGate(() => senders.sendVisual(client.phone, a.image, { caption: a.caption || '' }));
    return { wa_message_id: res && res.idMessage };
  }

  async function processReel(client, item, markSending) {
    const a = await gen(generators.reel(client, item), `reel ${client.phone}`);
    markSending();
    const res = await sendGate(() => senders.sendFileByUrl(client.phone, a.videoUrl, { fileName: 'reel.mp4', caption: a.caption || '' }));
    return { wa_message_id: res && res.idMessage };
  }

  async function processCarousel(client, item, markSending, setProgress, setPayload) {
    // Plan (LLM, small): persisted so retries resume at slide level. Regenerated
    // only if we don't already have it.
    let plan = item.payload ? JSON.parse(item.payload) : null;
    if (!plan) {
      plan = await gen(generators.carouselPlan(client), `carousel-plan ${client.phone}`);
      setPayload(JSON.stringify(plan));
    }
    const slides = plan.slides || [];
    const total = slides.length + (plan.postText ? 1 : 0);
    const start = Math.min(item.progress || 0, total);

    // Generation phase (retryable): render images for the not-yet-sent slides.
    const slideStart = Math.min(start, slides.length);
    const rendered = [];
    for (let i = slideStart; i < slides.length; i++) {
      rendered.push(await gen(renderImage(slides[i].image_prompt), `carousel-slide ${client.phone}#${i + 1}`));
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
      case 'story': return processStory(client, item, markSending);
      case 'reel': return processReel(client, item, markSending);
      case 'carousel': return processCarousel(client, item, markSending, setProgress, setPayload);
      default: { const e = new Error(`unknown content_type ${item.content_type}`); e.terminal = true; throw e; }
    }
  };
}
