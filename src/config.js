import 'dotenv/config';
import { randomBytes } from 'node:crypto';

export const config = {
  greenApi: {
    idInstance: process.env.GREEN_API_ID_INSTANCE || '',
    token: process.env.GREEN_API_TOKEN || '',
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-4-8',

  // BytePlus powers video only (Seedance); images moved to the OpenAI Responses API.
  byteplus: {
    apiKey: process.env.BYTEPLUS_API_KEY || '',
    baseUrl: (process.env.BYTEPLUS_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/$/, ''),
    seedanceModel: process.env.SEEDANCE_MODEL || 'seedance-1-0-lite-t2v-250428',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    // Model for the Responses API (conversational, editable images).
    responsesModel: process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6-terra',
    // Model tiers (use EXPLICIT ids from /v1/models — bare aliases like 'gpt-5.6'
    // are unlisted and showed flaky routing/401s):
    //   textModel    — main content: chat, posts, hooks (quality tier)
    //   bulkModel    — bulk variations: content packs, captions, CTAs (cheap tier)
    //   premiumModel — fallback when the main model fails (top tier)
    textModel: process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-terra',
    bulkModel: process.env.OPENAI_BULK_MODEL || 'gpt-5.6-luna',
    premiumModel: process.env.OPENAI_PREMIUM_MODEL || 'gpt-5.6-sol',
    // Reasoning models (e.g. gpt-5.x) require reasoning_effort:'none' when using
    // function tools in Chat Completions. Set '' to omit for non-reasoning models.
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? 'none',
  },

  // Which provider powers the text/chat engine: 'openai' or 'anthropic'.
  // Switch by setting TEXT_PROVIDER and restarting.
  textProvider: (process.env.TEXT_PROVIDER || 'openai').toLowerCase(),

  tz: process.env.TZ_NAME || 'Asia/Jerusalem',

  // Max edits per single generated image / video before the client must create a new one.
  maxImageEdits: parseInt(process.env.MAX_IMAGE_EDITS || '3', 10),
  maxVideoEdits: parseInt(process.env.MAX_VIDEO_EDITS || '1', 10),

  // Railway (and most hosts) inject PORT and route the public domain to it.
  adminPort: parseInt(process.env.PORT || process.env.ADMIN_PORT || '3000', 10),
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  // Secret used to sign session tokens. If unset, a random one is generated at
  // boot (sessions reset on restart) — set it in production for stable sessions.
  sessionSecret: process.env.SESSION_SECRET || randomHex(),
  // Force the Secure flag on the session cookie even if the proxy header is absent.
  forceSecureCookie: (process.env.FORCE_SECURE_COOKIE || 'false').toLowerCase() === 'true',

  dataDir: process.env.DATA_DIR || '',

  // Contact address shown to clients whose subscription is suspended/canceled.
  supportEmail: process.env.SUPPORT_EMAIL || '',
};

function randomHex() {
  return randomBytes(32).toString('hex');
}

export function validateConfig() {
  const missing = [];
  if (!config.greenApi.idInstance) missing.push('GREEN_API_ID_INSTANCE');
  if (!config.greenApi.token) missing.push('GREEN_API_TOKEN');
  // Images always use OpenAI (Responses API); the text engine uses the selected provider.
  if (!config.openai.apiKey) missing.push('OPENAI_API_KEY');
  if (config.textProvider === 'anthropic' && !config.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  return missing;
}

// Packages: monthly quotas for on-demand generation (conversational, no schedule).
// - imagesPerMonth: how many NEW images the client may create per calendar month
// - videosPerMonth: how many videos per month (video is one-shot, no editing)
// - editsPerImage: how many times a single image may be edited before it locks
// Adjust these numbers to your actual pricing.
export const PACKAGES = {
  basic: {
    label: 'חבילה בסיסית',
    imagesPerMonth: 20,
    videosPerMonth: 0,
    editsPerImage: 3,
  },
  premium: {
    label: 'חבילה מורחבת',
    imagesPerMonth: 40,
    videosPerMonth: 4,
    editsPerImage: 3,
  },
};

export function packageOf(client) {
  return PACKAGES[client.package] || PACKAGES.basic;
}
