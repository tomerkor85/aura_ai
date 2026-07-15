// Shared JSON POST with retry for provider APIs (OpenAI chat + Responses).
// Retries transient failures: 429, 5xx, timeouts/network drops, and the
// intermittent OpenAI 401 "insufficient permissions" — with gpt-5.x the SAME
// request fails once and then succeeds (verified empirically), so it's treated
// as flaky routing rather than a real auth error.

import { logger } from './logger.js';

function isTransient(status, text) {
  if (status === 429 || status >= 500) return true;
  return status === 401 && text.includes('insufficient permissions');
}

export async function postJsonWithRetry(url, { headers, body, timeoutMs = 120_000, label = 'HTTP', attempts = 3 }) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res = null;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err; // timeout / network drop — transient
      logger.warn(label, `${err.name || 'network error'} (attempt ${attempt}/${attempts}), retrying...`);
    }
    if (res) {
      if (res.ok) return res.json();
      const text = await res.text();
      lastErr = new Error(`${label} failed: ${res.status} ${text}`);
      if (!isTransient(res.status, text)) {
        logger.error(label, `non-transient ${res.status}`, text.slice(0, 500));
        throw lastErr; // real error — fail fast
      }
      logger.warn(label, `transient ${res.status} (attempt ${attempt}/${attempts}), retrying...`);
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw lastErr;
}
