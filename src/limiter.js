// Provider-specific DAILY safety caps (per UTC day), backed by provider_usage.
// When a cap is reached, the queue simply stops claiming/sending — jobs stay
// 'scheduled' (nothing deleted, no quota consumed) and resume the next day.
import { providerCount, incrProvider } from './deliveries.js';

const utcDay = (date) => date.toISOString().slice(0, 10);
const GEN_KIND = { story: 'story_gen', carousel: 'carousel_gen', reel: 'reel_gen' };

export function createProviderLimiter({ db, limits, clock }) {
  const day = () => utcDay(clock.now());
  return {
    // May we start ANOTHER generation of this type right now? Counts today's
    // completed generations PLUS the ones currently in flight, so bounded
    // concurrency can never overshoot the cap.
    canClaim(type, activeOfType) {
      const cap = limits[type];
      if (!cap) return true;
      return providerCount(db, day(), GEN_KIND[type]) + activeOfType < cap;
    },
    recordGeneration(type) { incrProvider(db, day(), GEN_KIND[type], 1); },
    // Is there any WhatsApp send budget left today?
    canSend() {
      const cap = limits.whatsapp;
      if (!cap) return true;
      return providerCount(db, day(), 'wa_send') < cap;
    },
    recordSend() { incrProvider(db, day(), 'wa_send', 1); },
    // Health snapshot for the admin dashboard.
    snapshot() {
      const d = day();
      return {
        day: d, limits,
        used: {
          story: providerCount(db, d, 'story_gen'),
          carousel: providerCount(db, d, 'carousel_gen'),
          reel: providerCount(db, d, 'reel_gen'),
          whatsapp: providerCount(db, d, 'wa_send'),
        },
      };
    },
  };
}

// Unlimited limiter (caps disabled) — handy for tests/local.
export const unlimitedLimiter = {
  canClaim: () => true, recordGeneration: () => {}, canSend: () => true, recordSend: () => {},
  snapshot: () => ({ limits: {}, used: {} }),
};
