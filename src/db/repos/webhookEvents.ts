import type { DB } from '../database.js';

export function insertWebhookEvent(db: DB, payloadJson: string, now: number): void {
  db.prepare('INSERT INTO webhook_events (received_at, payload_json) VALUES (?, ?)').run(now, payloadJson);
}

export function purgeWebhookEventsBefore(db: DB, before: number): number {
  return db.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(before).changes;
}
