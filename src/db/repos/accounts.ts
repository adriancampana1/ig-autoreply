import type { DB } from '../database.js';
import { refreshInteractionStatus } from './interactions.js';

export type AccountStatus = 'ok' | 'reconnect_required' | 'paused_by_safety' | 'disconnected';

export interface Account {
  id: number;
  igId: string;
  appUserId: string | null;
  username: string;
  profilePictureUrl: string | null;
  tokenEnc: string | null;
  tokenExpiresAt: number | null;
  tokenRefreshedAt: number | null;
  status: AccountStatus;
  messagingDisabled: boolean;
  pausedUntil: number | null;
  lastError: string | null;
  connectedAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  ig_id: string;
  app_user_id: string | null;
  username: string;
  profile_picture_url: string | null;
  token_enc: string | null;
  token_expires_at: number | null;
  token_refreshed_at: number | null;
  status: AccountStatus;
  messaging_disabled: number;
  paused_until: number | null;
  last_error: string | null;
  connected_at: number;
  updated_at: number;
}

const toAccount = (r: Row): Account => ({
  id: r.id,
  igId: r.ig_id,
  appUserId: r.app_user_id,
  username: r.username,
  profilePictureUrl: r.profile_picture_url,
  tokenEnc: r.token_enc,
  tokenExpiresAt: r.token_expires_at,
  tokenRefreshedAt: r.token_refreshed_at,
  status: r.status,
  messagingDisabled: r.messaging_disabled === 1,
  pausedUntil: r.paused_until,
  lastError: r.last_error,
  connectedAt: r.connected_at,
  updatedAt: r.updated_at,
});

export interface ConnectedAccountInput {
  igId: string;
  appUserId: string;
  username: string;
  profilePictureUrl?: string;
  tokenEnc: string;
  tokenExpiresAt: number;
}

/** Cria ou reativa a conta após o Business Login (reconectar limpa erros e pausas). */
export function upsertConnectedAccount(db: DB, input: ConnectedAccountInput, now: number): Account {
  db.prepare(
    `INSERT INTO ig_accounts (ig_id, app_user_id, username, profile_picture_url, token_enc, token_expires_at,
       token_refreshed_at, status, messaging_disabled, paused_until, last_error, connected_at, updated_at)
     VALUES (@igId, @appUserId, @username, @pic, @tokenEnc, @exp, @now, 'ok', 0, NULL, NULL, @now, @now)
     ON CONFLICT (ig_id) DO UPDATE SET
       app_user_id = excluded.app_user_id, username = excluded.username,
       profile_picture_url = excluded.profile_picture_url, token_enc = excluded.token_enc,
       token_expires_at = excluded.token_expires_at, token_refreshed_at = excluded.token_refreshed_at,
       status = 'ok', messaging_disabled = 0, paused_until = NULL, last_error = NULL,
       connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
  ).run({ ...input, pic: input.profilePictureUrl ?? null, exp: input.tokenExpiresAt, now });
  return getAccountByIgId(db, input.igId)!;
}

export function getAccountById(db: DB, id: number): Account | undefined {
  const row = db.prepare('SELECT * FROM ig_accounts WHERE id = ?').get(id) as Row | undefined;
  return row && toAccount(row);
}

export function getAccountByIgId(db: DB, igId: string): Account | undefined {
  const row = db.prepare('SELECT * FROM ig_accounts WHERE ig_id = ?').get(igId) as Row | undefined;
  return row && toAccount(row);
}

export function findAccountsByAnyUserId(db: DB, userId: string): Account[] {
  return (db.prepare('SELECT * FROM ig_accounts WHERE ig_id = ? OR app_user_id = ?').all(userId, userId) as Row[]).map(
    toAccount,
  );
}

export function listAccounts(db: DB): Account[] {
  return (db.prepare('SELECT * FROM ig_accounts ORDER BY username').all() as Row[]).map(toAccount);
}

export function updateAccountToken(db: DB, id: number, tokenEnc: string, tokenExpiresAt: number, now: number): void {
  db.prepare(
    'UPDATE ig_accounts SET token_enc = ?, token_expires_at = ?, token_refreshed_at = ?, updated_at = ? WHERE id = ?',
  ).run(tokenEnc, tokenExpiresAt, now, now, id);
}

export function setAccountStatus(
  db: DB,
  id: number,
  status: AccountStatus,
  now: number,
  extra: { lastError?: string | null; pausedUntil?: number | null } = {},
): void {
  db.prepare('UPDATE ig_accounts SET status = ?, last_error = ?, paused_until = ?, updated_at = ? WHERE id = ?').run(
    status,
    extra.lastError ?? null,
    extra.pausedUntil ?? null,
    now,
    id,
  );
}

export function setMessagingDisabled(db: DB, id: number, disabled: boolean, now: number): void {
  db.prepare('UPDATE ig_accounts SET messaging_disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, now, id);
}

/**
 * Apaga o token, pausa as automações e cancela os jobs pendentes (usado no botão "Desconectar" e no
 * callback de desautorização). Reconectar não reativa esses jobs.
 */
export function disconnectAccount(db: DB, id: number, now: number): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE ig_accounts SET token_enc = NULL, token_expires_at = NULL, status = 'disconnected', updated_at = ? WHERE id = ?",
    ).run(now, id);
    db.prepare('UPDATE automations SET is_active = 0, updated_at = ? WHERE account_id = ?').run(now, id);
    const affected = db
      .prepare("SELECT DISTINCT interaction_id AS interactionId FROM jobs WHERE account_id = ? AND status = 'pending'")
      .all(id) as Array<{ interactionId: number }>;
    db.prepare(
      "UPDATE jobs SET status = 'cancelled', fail_reason = 'account_disconnected', updated_at = ? WHERE account_id = ? AND status = 'pending'",
    ).run(now, id);
    for (const { interactionId } of affected) refreshInteractionStatus(db, interactionId);
  })();
}

export function deleteAccount(db: DB, id: number): void {
  db.prepare('DELETE FROM ig_accounts WHERE id = ?').run(id);
}

/** Conta apta a executar ações agora (ok, ou pausa de segurança já vencida). */
export function isAccountUsable(account: Account, now: number): boolean {
  if (!account.tokenEnc) return false;
  if (account.status === 'ok') return true;
  return account.status === 'paused_by_safety' && account.pausedUntil !== null && account.pausedUntil <= now;
}
