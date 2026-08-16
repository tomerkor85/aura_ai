import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

// Anthropic (Claude) adapter for the text engine.
const client = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 120_000 });

const sys = (system) => [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
const toTools = (tools) =>
  tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

// Conversational loop with tool calling. `executeTool(name, input)` -> string result.
export async function runConversation({ system, history, tools, executeTool }) {
  const anthTools = toTools(tools);
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  const call = (opts = {}) =>
    client.messages.create({
      model: config.claudeModel,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: sys(system),
      tools: anthTools,
      messages,
      ...opts,
    });

  const MAX_TOOL_ROUNDS = 5;
  let response = await call();
  let guard = 0;
  while (response.stop_reason === 'tool_use' && guard < MAX_TOOL_ROUNDS) {
    guard += 1;
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const tu of toolUses) {
      const content = await executeTool(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content });
    }
    messages.push({ role: 'user', content: results });
    // Last allowed round: force a text answer so the reply is never empty.
    response = await call(guard >= MAX_TOOL_ROUNDS ? { tool_choice: { type: 'none' } } : {});
  }

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Single-shot structured JSON output against a schema.
export async function structuredContent({ system, prompt, schema }) {
  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 8000,
    system: sys(system),
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Structured content returned no text');
  return JSON.parse(text);
}
