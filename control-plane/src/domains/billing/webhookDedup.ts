// control-plane/src/domains/billing/webhookDedup.ts
import { pool } from '../../db/client.js';

/**
 * Idempotent webhook ingestion. Returns true when this caller should process
 * the event: either it's newly seen, or a prior attempt failed before marking
 * it processed (processed_at IS NULL) and is being retried. An event already
 * marked processed is a no-op (returns false). The payload is stored for audit.
 */
export async function claimWebhookEvent(
  eventId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const insert = await pool.query(
    `INSERT INTO stripe_webhook_events (id, payload) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [eventId, JSON.stringify(payload)]
  );
  if (insert.rowCount && insert.rowCount > 0) {
    return true; // newly claimed
  }
  // Row existed — only reclaim if a prior attempt left it unprocessed.
  const existing = await pool.query(
    `SELECT processed_at FROM stripe_webhook_events WHERE id = $1`,
    [eventId]
  );
  return existing.rows[0]?.processed_at === null;
}

export async function markWebhookProcessed(eventId: string): Promise<void> {
  await pool.query(
    `UPDATE stripe_webhook_events SET processed_at = now() WHERE id = $1`,
    [eventId]
  );
}
