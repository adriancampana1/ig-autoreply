import type { DB } from '../database.js';

export function insertDeletionRequest(db: DB, code: string, appUserId: string, now: number): void {
  db.prepare('INSERT INTO deletion_requests (code, app_user_id, created_at) VALUES (?, ?, ?)').run(code, appUserId, now);
}

export function findDeletionRequest(db: DB, code: string): { code: string; createdAt: number } | undefined {
  return db.prepare('SELECT code, created_at AS createdAt FROM deletion_requests WHERE code = ?').get(code) as
    | { code: string; createdAt: number }
    | undefined;
}
