import type { DB } from '../db/database.js';
import { getAccountById, isAccountUsable, setAccountStatus } from '../db/repos/accounts.js';
import { listActiveAutomations, setLastReconciledAt, type Automation } from '../db/repos/automations.js';
import type { InstagramClient } from '../instagram/client.js';
import { classifyError } from '../instagram/errors.js';
import { handleComment } from './matcher.js';
import { COMMENT_WINDOW_MS } from './pacing.js';

export const RECONCILE_OVERLAP_MS = 15 * 60_000;
export const RECONCILE_MAX_PAGES = 5;

export interface ReconcilerDeps {
  db: DB;
  client: InstagramClient;
  decryptToken: (encoded: string) => string;
  now: () => number;
  random: () => number;
  log: { warn: (obj: object, msg: string) => void };
}

async function reconcileAutomation(deps: ReconcilerDeps, automation: Automation, igId: string, token: string): Promise<number> {
  const now = deps.now();
  const since = Math.max(
    automation.createdAt,
    (automation.lastReconciledAt ?? automation.createdAt) - RECONCILE_OVERLAP_MS,
    now - COMMENT_WINDOW_MS,
  );
  let queued = 0;
  let cursor: string | undefined;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const { comments, nextCursor } = await deps.client.listComments(token, automation.mediaId, cursor);
    let reachedOld = false;
    for (const comment of comments) {
      const createdAt = Date.parse(comment.timestamp.replace(/\+0000$/, 'Z'));
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
    if (reachedOld || !nextCursor) break;
    cursor = nextCursor;
  }
  setLastReconciledAt(deps.db, automation.id, now);
  return queued;
}

/** Varre os posts com automação ativa para recuperar comentários cujo webhook não chegou (spec §6.4). */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<{ checked: number; queued: number }> {
  let checked = 0;
  let queued = 0;
  for (const automation of listActiveAutomations(deps.db)) {
    const account = getAccountById(deps.db, automation.accountId);
    if (!account || !isAccountUsable(account, deps.now())) continue;
    try {
      queued += await reconcileAutomation(deps, automation, account.igId, deps.decryptToken(account.tokenEnc!));
      checked += 1;
    } catch (error) {
      const c = classifyError(error);
      deps.log.warn({ automationId: automation.id, kind: c.kind, code: c.code, message: c.message }, 'falha na reconciliação');
      if (c.kind === 'auth') setAccountStatus(deps.db, account.id, 'reconnect_required', deps.now(), { lastError: c.message });
    }
  }
  return { checked, queued };
}
