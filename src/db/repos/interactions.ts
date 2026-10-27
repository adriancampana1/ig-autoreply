import type { DB } from '../database.js';

export type InteractionStatus = 'queued' | 'done' | 'partial' | 'failed' | 'skipped';
export type InteractionSource = 'webhook' | 'reconciler';
export type SkipReason = 'already_replied_to_person';

export interface NewInteraction {
  automationId: number;
  commentId: string;
  commenterIgsid: string;
  commenterUsername?: string;
  commentText: string;
  matchedKeyword: string | null;
  source: InteractionSource;
  status: 'queued' | 'skipped';
  skipReason?: SkipReason;
}

/** Insere a interação; retorna null se o comment_id já existe (deduplicação de webhooks/reconciliação). */
export function insertInteraction(db: DB, input: NewInteraction, now: number): number | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO interactions (automation_id, comment_id, commenter_igsid, commenter_username, comment_text,
         matched_keyword, source, status, skip_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.automationId,
      input.commentId,
      input.commenterIgsid,
      input.commenterUsername ?? null,
      input.commentText,
      input.matchedKeyword,
      input.source,
      input.status,
      input.skipReason ?? null,
      now,
    );
  return result.changes === 0 ? null : Number(result.lastInsertRowid);
}

export function commentExists(db: DB, commentId: string): boolean {
  return db.prepare('SELECT 1 FROM interactions WHERE comment_id = ?').get(commentId) !== undefined;
}

/** A pessoa já recebeu (ou está para receber) ação nesta automação? */
export function hasActedForPerson(db: DB, automationId: number, commenterIgsid: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM interactions WHERE automation_id = ? AND commenter_igsid = ? AND status <> 'skipped' LIMIT 1")
      .get(automationId, commenterIgsid) !== undefined
  );
}

/** Recalcula o status agregado a partir dos jobs: done, partial, failed ou queued. */
export function refreshInteractionStatus(db: DB, interactionId: number): InteractionStatus {
  const jobs = db.prepare('SELECT status FROM jobs WHERE interaction_id = ?').all(interactionId) as Array<{ status: string }>;
  const statuses = jobs.map((job) => job.status);
  let status: InteractionStatus;
  if (statuses.some((s) => s === 'pending' || s === 'running')) status = 'queued';
  else if (statuses.every((s) => s === 'done')) status = 'done';
  else if (statuses.some((s) => s === 'done')) status = 'partial';
  else status = 'failed';
  db.prepare('UPDATE interactions SET status = ? WHERE id = ?').run(status, interactionId);
  return status;
}

export interface ActivityFilter {
  accountId?: number;
  status?: InteractionStatus;
  limit: number;
  offset: number;
}

export interface ActivityRow {
  id: number;
  createdAt: number;
  accountUsername: string;
  mediaPermalink: string | null;
  mediaCaption: string | null;
  commenterUsername: string | null;
  commentText: string | null;
  matchedKeyword: string | null;
  status: InteractionStatus;
  skipReason: SkipReason | null;
  publicStatus: string | null;
  publicFailReason: string | null;
  dmStatus: string | null;
  dmFailReason: string | null;
}

export function listActivity(db: DB, filter: ActivityFilter): ActivityRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.accountId !== undefined) {
    where.push('a.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.status !== undefined) {
    where.push('i.status = ?');
    params.push(filter.status);
  }
  const sql = `
    SELECT i.id, i.created_at AS createdAt, acc.username AS accountUsername, a.media_permalink AS mediaPermalink,
      a.media_caption AS mediaCaption, i.commenter_username AS commenterUsername, i.comment_text AS commentText,
      i.matched_keyword AS matchedKeyword, i.status, i.skip_reason AS skipReason,
      pj.status AS publicStatus, pj.fail_reason AS publicFailReason,
      dj.status AS dmStatus, dj.fail_reason AS dmFailReason
    FROM interactions i
    JOIN automations a ON a.id = i.automation_id
    JOIN ig_accounts acc ON acc.id = a.account_id
    LEFT JOIN jobs pj ON pj.interaction_id = i.id AND pj.type = 'public_reply'
    LEFT JOIN jobs dj ON dj.interaction_id = i.id AND dj.type = 'private_reply'
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, filter.limit, filter.offset) as ActivityRow[];
}

/** Retenção (spec §12): apaga interações (e jobs, em cascata) mais antigas que `before`. */
export function purgeInteractionsBefore(db: DB, before: number): number {
  return db.prepare('DELETE FROM interactions WHERE created_at < ?').run(before).changes;
}
