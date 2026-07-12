import 'dotenv/config';
import { randomBytes } from 'node:crypto';

export const config = {
  greenApi: {
    idInstance: process.env.GREEN_API_ID_INSTANCE || '',
    token: process.env.GREEN_API_TOKEN || '',
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: 'claude-opus-4-8',

  byteplus: {
    apiKey: process.env.BYTEPLUS_API_KEY || '',
    baseUrl: (process.env.BYTEPLUS_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/$/, ''),
    seedreamModel: process.env.SEEDREAM_MODEL || 'seedream-3-0-t2i-250415',
    seedanceModel: process.env.SEEDANCE_MODEL || 'seedance-1-0-lite-t2v-250428',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    // Model for the Responses API (conversational, editable images). Confirm the
    // exact model name in your OpenAI account.
    responsesModel: process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6',
  },
  imageProvider: (process.env.IMAGE_PROVIDER || 'byteplus').toLowerCase(),

  dailyImages: (process.env.DAILY_IMAGES || 'false').toLowerCase() === 'true',
  tz: process.env.TZ_NAME || 'Asia/Jerusalem',

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
};

function randomHex() {
  return randomBytes(32).toString('hex');
}

export function validateConfig() {
  const missing = [];
  if (!config.greenApi.idInstance) missing.push('GREEN_API_ID_INSTANCE');
  if (!config.greenApi.token) missing.push('GREEN_API_TOKEN');
  if (!config.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  return missing;
}

// Packages: what each client receives per day/week
export const PACKAGES = {
  basic: {
    label: 'חבילה בסיסית',
    storiesPerDay: 2,
    carouselDays: [0], // Sunday
    video: false,
  },
  premium: {
    label: 'חבילה מורחבת',
    storiesPerDay: 4,
    carouselDays: [0, 3], // Sunday + Wednesday
    video: true, // basic product video available
  },
};
