// Diagnose the OpenAI key: what can it actually do?
// Usage: npm run check-openai
import { config } from '../src/config.js';

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` };

async function tryCall(label, fn) {
  try {
    const out = await fn();
    console.log(`✅ ${label}: OK${out ? ' — ' + out : ''}`);
    return true;
  } catch (e) {
    console.log(`❌ ${label}: ${e.message.slice(0, 200)}`);
    return false;
  }
}

async function json(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text);
}

if (!config.openai.apiKey) {
  console.error('OPENAI_API_KEY is not set in .env');
  process.exit(1);
}
console.log(`Key prefix: ${config.openai.apiKey.slice(0, 10)}...`);
console.log(`Text model: ${config.openai.textModel} | Responses model: ${config.openai.responsesModel}\n`);

// 1. Can we list models? (basic read permission)
await tryCall('List models', async () => {
  const data = await json(await fetch('https://api.openai.com/v1/models', { headers: H }));
  const ids = data.data.map((m) => m.id);
  const interesting = ids.filter((id) => /gpt-5|gpt-4o|o[0-9]/.test(id)).slice(0, 12).join(', ');
  return `${ids.length} models visible. Sample: ${interesting}`;
});

// 2. Chat completion with the configured text model (no tools)
await tryCall(`Chat completion (${config.openai.textModel}, no tools)`, async () => {
  const data = await json(await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: config.openai.textModel, messages: [{ role: 'user', content: 'Say OK' }], max_completion_tokens: 400 }),
  }));
  return data.choices?.[0]?.message?.content?.trim().slice(0, 40) || '(empty content)';
});

// 3. Chat completion WITH tools + reasoning_effort none (what AURA actually sends)
await tryCall(`Chat completion (${config.openai.textModel}, with tools)`, async () => {
  const data = await json(await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: config.openai.textModel,
      reasoning_effort: config.openai.reasoningEffort || undefined,
      messages: [{ role: 'user', content: 'Say OK' }],
      tools: [{ type: 'function', function: { name: 'noop', description: 'no-op', parameters: { type: 'object', properties: {} } } }],
      max_completion_tokens: 400,
    }),
  }));
  return data.choices?.[0]?.message?.content?.trim().slice(0, 40) || '(tool call)';
});

// 4. Fallback sanity: gpt-4o-mini (widely accessible)
await tryCall('Chat completion (gpt-4o-mini)', async () => {
  const data = await json(await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 10 }),
  }));
  return data.choices?.[0]?.message?.content?.trim().slice(0, 40);
});

console.log('\nInterpretation:');
console.log('- If ALL fail with 401: the key is restricted or invalid → create a new key with full permissions.');
console.log('- If only the configured model fails: the project lacks access to that model → pick one from the visible list (OPENAI_TEXT_MODEL in .env).');
