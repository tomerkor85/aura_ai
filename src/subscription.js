import { config } from './config.js';
import { markStatusNotified, expireSubscriptionIfDue, listExpiredActiveClients, listExpiredPendingNotice } from './db.js';
import { sendText } from './greenapi.js';
import { logger } from './logger.js';

// ============================================================================
// Subscription lifecycle: one-time status notices + automatic expiry.
// Shared by the message loop (index.js), the admin panel (admin.js) and
// content packs (daily.js) so status is enforced consistently everywhere.
// ============================================================================

// One-time notice for suspended/canceled subscriptions: sent once per status
// change, then silence until the status changes again.
// opts.expired = the suspension came from automatic subscription expiry.
export async function sendStatusNoticeOnce(client, { expired = false } = {}) {
  if (client.notified_status === client.status) return; // already told them
  const contact = config.supportEmail
    ? `במייל: ${config.supportEmail}`
    : 'במייל של מנהלת השירות';

  let notice;
  if (client.status === 'suspended' && expired) {
    notice = `היי ${client.name}, המנוי שלך הסתיים ולכן השירות מושהה כרגע. לחידוש המנוי צרו איתנו קשר ${contact}`;
  } else if (client.status === 'suspended') {
    notice = `היי ${client.name}, המנוי שלך מושהה כרגע, כנראה בגלל רכישה או חידוש שלא הושלמו. כדי להפעיל את השירות מחדש צרו איתנו קשר ${contact}`;
  } else if (client.status === 'canceled') {
    notice = `היי ${client.name}, החשבון הזה נסגר לצמיתות. ליצירת חשבון חדש פנו אלינו ${contact}`;
  } else {
    return; // unknown non-active status — stay silent
  }

  try {
    await sendText(client.phone, notice);
    markStatusNotified(client.phone, client.status);
    logger.info('status', `one-time ${client.status} notice sent to ${client.phone}`);
  } catch (err) {
    // Don't mark as notified if the send failed — retried on the next trigger.
    logger.error('status', `notice failed for ${client.phone}`, err);
  }
}

// Enforce expiry on a single client: if the subscription end has passed, flip
// to suspended (the status change is applied SYNCHRONOUSLY, before any await —
// callers see client.status updated immediately) and send the one-time notice.
// Returns true when expiry fired.
export async function enforceExpiry(client) {
  if (!expireSubscriptionIfDue(client)) return false;
  logger.warn('status', `subscription expired for ${client.phone} — auto-suspended`);
  await sendStatusNoticeOnce(client, { expired: true });
  return true;
}

// Periodic sweep: suspend + notify every expired client, without waiting for
// them to message us. Also retries expired clients whose notice previously
// failed to send (suspended, notice still pending).
export async function sweepExpiredSubscriptions() {
  try {
    for (const client of listExpiredActiveClients()) {
      await enforceExpiry(client);
    }
    for (const client of listExpiredPendingNotice()) {
      await sendStatusNoticeOnce(client, { expired: true });
    }
  } catch (err) {
    logger.error('status', 'expiry sweep failed', err);
  }
}
