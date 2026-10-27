import type { DB } from '../database.js';

export interface AutomationContent {
  keywords: string[];
  publicVariations: string[];
  dmText: string;
}

export interface NewAutomation extends AutomationContent {
  accountId: number;
  mediaId: string;
  mediaType?: string;
  mediaPermalink?: string;
  mediaCaption?: string;
}

export interface Automation extends NewAutomation {
  id: number;
  isActive: boolean;
  lastVariationIndex: number | null;
  lastReconciledAt: number | null;
  /** Último momento em que a automação foi ligada (criação ou reativação): nada comentado antes disso é respondido. */
  activatedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationSummary extends Automation {
  accountUsername: string;
  repliesToday: number;
  repliesTotal: number;
}

interface Row {
  id: number;
  account_id: number;
  media_id: string;
  media_type: string | null;
  media_permalink: string | null;
  media_caption: string | null;
  keywords_json: string;
  public_variations_json: string;
  dm_text: string;
  is_active: number;
  last_variation_index: number | null;
  last_reconciled_at: number | null;
  activated_at: number;
  created_at: number;
  updated_at: number;
}

const toAutomation = (r: Row): Automation => ({
  id: r.id,
  accountId: r.account_id,
  mediaId: r.media_id,
  mediaType: r.media_type ?? undefined,
  mediaPermalink: r.media_permalink ?? undefined,
  mediaCaption: r.media_caption ?? undefined,
  keywords: JSON.parse(r.keywords_json) as string[],
  publicVariations: JSON.parse(r.public_variations_json) as string[],
  dmText: r.dm_text,
  isActive: r.is_active === 1,
  lastVariationIndex: r.last_variation_index,
  lastReconciledAt: r.last_reconciled_at,
  activatedAt: r.activated_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class DuplicateAutomationError extends Error {
  constructor() {
    super('Este post já tem uma automação');
  }
}

export function createAutomation(db: DB, input: NewAutomation, now: number): Automation {
  try {
    const result = db
      .prepare(
        `INSERT INTO automations (account_id, media_id, media_type, media_permalink, media_caption, keywords_json,
           public_variations_json, dm_text, is_active, activated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.accountId,
        input.mediaId,
        input.mediaType ?? null,
        input.mediaPermalink ?? null,
        input.mediaCaption ?? null,
        JSON.stringify(input.keywords),
        JSON.stringify(input.publicVariations),
        input.dmText,
        now,
        now,
        now,
      );
    return getAutomation(db, Number(result.lastInsertRowid))!;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new DuplicateAutomationError();
    throw error;
  }
}

export function updateAutomationContent(db: DB, id: number, content: AutomationContent, now: number): void {
  db.prepare(
    'UPDATE automations SET keywords_json = ?, public_variations_json = ?, dm_text = ?, last_variation_index = NULL, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(content.keywords), JSON.stringify(content.publicVariations), content.dmText, now, id);
}

/**
 * Liga/desliga a automação. Ao ligar uma automação pausada, `activated_at` passa a ser `now`: comentários feitos
 * durante a pausa não são respondidos depois (spec §6.2). Ligar uma automação já ativa não move o marco.
 */
export function setAutomationActive(db: DB, id: number, active: boolean, now: number): void {
  db.prepare(
    'UPDATE automations SET activated_at = CASE WHEN ? = 1 AND is_active = 0 THEN ? ELSE activated_at END, is_active = ?, updated_at = ? WHERE id = ?',
  ).run(active ? 1 : 0, now, active ? 1 : 0, now, id);
}

export function deleteAutomation(db: DB, id: number): void {
  db.prepare('DELETE FROM automations WHERE id = ?').run(id);
}

export function getAutomation(db: DB, id: number): Automation | undefined {
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as Row | undefined;
  return row && toAutomation(row);
}

export function findActiveAutomation(db: DB, accountId: number, mediaId: string): Automation | undefined {
  const row = db
    .prepare('SELECT * FROM automations WHERE account_id = ? AND media_id = ? AND is_active = 1')
    .get(accountId, mediaId) as Row | undefined;
  return row && toAutomation(row);
}

export function listActiveAutomations(db: DB): Automation[] {
  return (db.prepare('SELECT * FROM automations WHERE is_active = 1 ORDER BY id').all() as Row[]).map(toAutomation);
}

export function listAutomationSummaries(db: DB, startOfToday: number): AutomationSummary[] {
  const rows = db
    .prepare(
      `SELECT a.*, acc.username AS account_username,
         (SELECT COUNT(*) FROM interactions i WHERE i.automation_id = a.id AND i.status IN ('done','partial') AND i.created_at >= ?) AS replies_today,
         (SELECT COUNT(*) FROM interactions i WHERE i.automation_id = a.id AND i.status IN ('done','partial')) AS replies_total
       FROM automations a JOIN ig_accounts acc ON acc.id = a.account_id
       ORDER BY a.is_active DESC, a.created_at DESC`,
    )
    .all(startOfToday) as Array<Row & { account_username: string; replies_today: number; replies_total: number }>;
  return rows.map((r) => ({
    ...toAutomation(r),
    accountUsername: r.account_username,
    repliesToday: r.replies_today,
    repliesTotal: r.replies_total,
  }));
}

export function setLastVariationIndex(db: DB, id: number, index: number): void {
  db.prepare('UPDATE automations SET last_variation_index = ? WHERE id = ?').run(index, id);
}

export function setLastReconciledAt(db: DB, id: number, at: number): void {
  db.prepare('UPDATE automations SET last_reconciled_at = ? WHERE id = ?').run(at, id);
}
