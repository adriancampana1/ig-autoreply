import type { DB } from '../db/database.js';
import { listAccounts, setAccountStatus, updateAccountToken } from '../db/repos/accounts.js';
import { purgeInteractionsBefore, refreshInteractionStatus } from '../db/repos/interactions.js';
import { cancelJobsOlderThan } from '../db/repos/jobs.js';
import { purgeWebhookEventsBefore } from '../db/repos/webhookEvents.js';
import type { LongLivedToken } from '../instagram/oauth.js';
import { classifyError } from '../instagram/errors.js';
import { COMMENT_WINDOW_MS } from './pacing.js';

const DAY_MS = 86_400_000;
export const TOKEN_MIN_AGE_MS = DAY_MS;
export const TOKEN_REFRESH_WINDOW_MS = 30 * DAY_MS;
export const WEBHOOK_EVENTS_RETENTION_MS = 30 * DAY_MS;
export const INTERACTIONS_RETENTION_MS = 90 * DAY_MS;

export interface TokenRefreshDeps {
  db: DB;
  refresh: (token: string) => Promise<LongLivedToken>;
  encrypt: (plain: string) => string;
  decrypt: (encoded: string) => string;
  now: () => number;
  log: { warn: (obj: object, msg: string) => void };
}

/** Renova tokens com ≥ 24h de idade que vencem em ≤ 30 dias (spec §6.5). */
export async function refreshExpiringTokens(deps: TokenRefreshDeps): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;
  for (const account of listAccounts(deps.db)) {
    const now = deps.now();
    if (!account.tokenEnc || account.tokenExpiresAt === null || account.status === 'disconnected') continue;
    const age = now - (account.tokenRefreshedAt ?? account.connectedAt);
    if (age < TOKEN_MIN_AGE_MS || account.tokenExpiresAt - now > TOKEN_REFRESH_WINDOW_MS) continue;
    try {
      const token = await deps.refresh(deps.decrypt(account.tokenEnc));
      updateAccountToken(deps.db, account.id, deps.encrypt(token.accessToken), now + token.expiresInSec * 1000, now);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      const c = classifyError(error);
      deps.log.warn({ accountId: account.id, kind: c.kind, code: c.code }, 'falha ao renovar token');
      if (c.kind === 'auth') setAccountStatus(deps.db, account.id, 'reconnect_required', now, { lastError: c.message });
    }
  }
  return { refreshed, failed };
}

/** Cancela jobs fora da janela de 7 dias e aplica a retenção de dados (spec §12). */
export function runHousekeeping(db: DB, now: number): { cancelled: number; events: number; interactions: number } {
  const affected = cancelJobsOlderThan(db, now - COMMENT_WINDOW_MS, now);
  for (const interactionId of affected) refreshInteractionStatus(db, interactionId);
  return {
    cancelled: affected.length,
    events: purgeWebhookEventsBefore(db, now - WEBHOOK_EVENTS_RETENTION_MS),
    interactions: purgeInteractionsBefore(db, now - INTERACTIONS_RETENTION_MS),
  };
}
