import type { DB } from '../db/database.js';
import { getAccountById, isAccountUsable, setAccountStatus } from '../db/repos/accounts.js';
import { listActiveAutomations, setLastReconciledAt, type Automation } from '../db/repos/automations.js';
import type { InstagramClient } from '../instagram/client.js';
import { classifyError } from '../instagram/errors.js';
import { handleComment } from './matcher.js';
import { COMMENT_WINDOW_MS } from './pacing.js';

export const RECONCILE_OVERLAP_MS = 15 * 60_000;
export const RECONCILE_MAX_PAGES = 40;

export interface ReconcilerDeps {
  db: DB;
  client: InstagramClient;
  decryptToken: (encoded: string) => string;
  now: () => number;
  random: () => number;
  log: { warn: (obj: object, msg: string) => void };
}

async function reconcileAutomation(
  deps: ReconcilerDeps,
  automation: Automation,
  igId: string,
  token: string,
): Promise<{ queued: number; complete: boolean }> {
  const now = deps.now();
  const since = Math.max(
    automation.createdAt,
    (automation.lastReconciledAt ?? automation.createdAt) - RECONCILE_OVERLAP_MS,
    now - COMMENT_WINDOW_MS,
  );
  let queued = 0;
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const { comments, nextCursor } = await deps.client.listComments(token, automation.mediaId, cursor);
    let reachedOld = false;
    for (const comment of comments) {
      const createdAt = Date.parse(comment.timestamp.replace(/\+0000$/, 'Z'));
      if (Number.isNaN(createdAt)) {
        deps.log.warn({ automationId: automation.id, commentId: comment.id }, 'comentário com timestamp inválido ignorado');
        continue;
      }
      if (createdAt < since) {
        reachedOld = true;
        continue;
      }
      if (!comment.fromId || comment.hidden) continue;
      const outcome = handleComment(
        { db: deps.db, now: deps.now, random: deps.random },
        {
          accountIgId: igId,
          commentId: comment.id,
          fromId: comment.fromId,
          fromUsername: comment.fromUsername,
          isSelf: false,
          text: comment.text,
          mediaId: automation.mediaId,
          createdAt,
          source: 'reconciler',
        },
      );
      if (outcome.kind === 'queued') queued += 1;
    }
    if (reachedOld || !nextCursor) {
      complete = true;
      break;
    }
    cursor = nextCursor;
  }
  if (complete) {
    setLastReconciledAt(deps.db, automation.id, now);
  } else {
    // Limite de páginas atingido sem chegar a comentários antigos: não avança o marco, para não perder comentários.
    deps.log.warn({ automationId: automation.id, pages: RECONCILE_MAX_PAGES }, 'reconciliação interrompida no limite de páginas');
  }
  return { queued, complete };
}

/** Varre os posts com automação ativa para recuperar comentários cujo webhook não chegou (spec §6.4). */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<{ checked: number; queued: number }> {
  let checked = 0;
  let queued = 0;
  const throttledAccounts = new Set<number>();
  for (const automation of listActiveAutomations(deps.db)) {
    if (throttledAccounts.has(automation.accountId)) continue;
    const account = getAccountById(deps.db, automation.accountId);
    if (!account || !isAccountUsable(account, deps.now())) continue;
    try {
      const result = await reconcileAutomation(deps, automation, account.igId, deps.decryptToken(account.tokenEnc!));
      queued += result.queued;
      checked += 1;
    } catch (error) {
      const c = classifyError(error);
      deps.log.warn({ automationId: automation.id, kind: c.kind, code: c.code, message: c.message }, 'falha na reconciliação');
      if (c.kind === 'auth') setAccountStatus(deps.db, account.id, 'reconnect_required', deps.now(), { lastError: c.message });
      if (c.kind === 'rate_limit' || c.kind === 'abuse') {
        throttledAccounts.add(account.id);
        deps.log.warn({ accountId: account.id, kind: c.kind }, 'reconciliação da conta suspensa nesta rodada');
      }
    }
  }
  return { checked, queued };
}
