import { config } from '../config.js';
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';

// Text-engine provider selector. Switch with TEXT_PROVIDER=openai|anthropic.
const PROVIDERS = { anthropic, openai };

function provider() {
  return PROVIDERS[config.textProvider] || openai;
}

export function runConversation(args) {
  return provider().runConversation(args);
}

export function structuredContent(args) {
  return provider().structuredContent(args);
}
