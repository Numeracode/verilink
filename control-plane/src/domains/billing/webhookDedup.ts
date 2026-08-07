// control-plane/src/domains/billing/webhookDedup.ts
import { pool } from '../../db/client.js';

/**
 * Idempotent webhook ingestion: insert the event id, returning whether this
 * call is the first to see it. Subsequent replays of the same event id are
 * no-ops. PK on stripe_webhook_events.id guarantees exactly-once processing
 * per event across concurrent deliveries. The payload is stored for audit.
 */
export async function claimWebhookEvent(
  eventId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO stripe_webhook_events (id, payload) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [eventId, JSON.stringify(payload)]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function markWebhookProcessed(eventId: string): Promise<void> {
  await pool.query(
    `UPDATE stripe_webhook_events SET processed_at = now() WHERE id = $1`,
    [eventId]
  );
}
