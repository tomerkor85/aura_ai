import { config } from '../config.js';

// OpenAI adapter for the text engine (Chat Completions + function calling).
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

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
  const res = await fetch(CHAT_URL, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI chat failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Conversational loop with tool calling. `executeTool(name, input)` -> string result.
export async function runConversation({ system, history, tools, executeTool }) {
  const oaTools = toTools(tools);
  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const body = { model: config.openai.textModel, tools: oaTools };
  if (config.openai.reasoningEffort) body.reasoning_effort = config.openai.reasoningEffort;

  let guard = 0;
  while (true) {
    const data = await chat({ ...body, messages });
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('OpenAI chat returned no message');

    if (msg.tool_calls?.length && guard < 5) {
      guard += 1;
      messages.push(msg); // assistant turn carrying the tool_calls
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty */ }
        const content = await executeTool(tc.function.name, input);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(content) });
      }
      continue;
    }
    return (msg.content || '').trim();
  }
}

// Single-shot structured JSON output against a schema.
export async function structuredContent({ system, prompt, schema }) {
  const data = await chat({
    model: config.openai.textModel,
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
