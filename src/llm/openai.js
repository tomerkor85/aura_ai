import { config } from '../config.js';
import { postJsonWithRetry } from '../http.js';
import { logger, snip } from '../logger.js';

// OpenAI adapter for the text engine (Chat Completions + function calling).
//
// Model tiers (see config.js):
//   textModel (Terra)  — main content: conversation, posts, hooks
//   bulkModel (Luna)   — bulk variations: content packs (structuredContent)
//   premiumModel (Sol) — automatic fallback when the primary model fails
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const log = logger.child('openai');

function headers() {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY is not set');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openai.apiKey}`,
  };
}

const toTools = (tools) =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

async function chat(body) {
  const t0 = Date.now();
  const data = await postJsonWithRetry(CHAT_URL, {
    headers: headers(),
    body,
    timeoutMs: 120_000,
    label: 'OpenAI chat',
  });
  log.info(`chat done model=${body.model} in ${Date.now() - t0}ms`, {
    usage: data.usage ? { in: data.usage.prompt_tokens, out: data.usage.completion_tokens } : undefined,
    finish: data.choices?.[0]?.finish_reason,
  });
  return data;
}

// Call with the primary model; if it fails (after the retry layer), escalate
// once to the premium fallback model so the client still gets an answer.
async function chatWithFallback(primary, body) {
  try {
    return await chat({ ...body, model: primary });
  } catch (err) {
    const fallback = config.openai.premiumModel;
    if (!fallback || fallback === primary) throw err;
    log.warn(`model ${primary} failed, falling back to ${fallback}`, err.message);
    return chat({ ...body, model: fallback });
  }
}

// Conversational loop with tool calling. `executeTool(name, input)` -> string result.
export async function runConversation({ system, history, tools, executeTool }) {
  const oaTools = toTools(tools);
  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const body = { tools: oaTools };
  if (config.openai.reasoningEffort) body.reasoning_effort = config.openai.reasoningEffort;

  const MAX_TOOL_ROUNDS = 5;
  let guard = 0;
  while (true) {
    // After the last allowed tool round, force a plain-text answer so the client
    // never ends up with an empty reply because the model kept requesting tools.
    const finalRound = guard >= MAX_TOOL_ROUNDS;
    const data = await chatWithFallback(config.openai.textModel, {
      ...body, messages, ...(finalRound ? { tool_choice: 'none' } : {}),
    });
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('OpenAI chat returned no message');

    if (msg.tool_calls?.length && !finalRound) {
      guard += 1;
      messages.push(msg); // assistant turn carrying the tool_calls
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty */ }
        log.info(`tool round ${guard}: ${tc.function.name}`, snip(tc.function.arguments, 300));
        const content = await executeTool(tc.function.name, input);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(content) });
      }
      continue;
    }
    return (msg.content || '').trim();
  }
}

// Single-shot structured JSON output against a schema. Uses the bulk tier
// (variations at volume); falls back to the premium model on failure.
export async function structuredContent({ system, prompt, schema }) {
  const data = await chatWithFallback(config.openai.bulkModel, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'content', schema, strict: false } },
  });
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Structured content returned no text');
  return JSON.parse(text);
}
