import type { DB } from '../db/database.js';
import { getAccountByIgId } from '../db/repos/accounts.js';
import { findActiveAutomation } from '../db/repos/automations.js';
import { commentExists, hasActedForPerson, insertInteraction, type InteractionSource } from '../db/repos/interactions.js';
import { enqueueJob } from '../db/repos/jobs.js';
import { findMatchingKeyword } from '../lib/text.js';
import { COMMENT_WINDOW_MS, PRIVATE_REPLY_EXTRA_DELAY_MS, PUBLIC_REPLY_DELAY_MS, randomBetween } from './pacing.js';

export interface IncomingComment {
  accountIgId: string;
  commentId: string;
  fromId: string;
  fromUsername?: string;
  isSelf: boolean;
  text: string;
  mediaId: string;
  /** Epoch ms da criação do comentário, quando conhecido (reconciler). */
  createdAt?: number;
  source: InteractionSource;
}

export type IgnoreReason =
  | 'unknown_account'
  | 'self_comment'
  | 'no_automation'
  | 'before_automation'
  | 'too_old'
  | 'no_keyword'
  | 'duplicate';

export type MatchOutcome =
  | { kind: 'ignored'; reason: IgnoreReason }
  | { kind: 'skipped'; interactionId: number }
  | { kind: 'queued'; interactionId: number };

export interface MatcherDeps {
  db: DB;
  now: () => number;
  random: () => number;
}

/** Aplica as 7 regras da spec §6.2 e, se for o caso, cria a interação e os 2 jobs numa transação. */
export function handleComment(deps: MatcherDeps, comment: IncomingComment): MatchOutcome {
  const { db } = deps;
  const now = deps.now();

  const account = getAccountByIgId(db, comment.accountIgId);
  if (!account || account.status === 'disconnected') return { kind: 'ignored', reason: 'unknown_account' };
  // No reconciler o from.id pode vir escopado (≠ igId): o @ da própria conta também identifica as nossas respostas.
  const isSelf =
    comment.isSelf ||
    comment.fromId === account.igId ||
    comment.fromUsername?.toLowerCase() === account.username.toLowerCase();
  if (isSelf) return { kind: 'ignored', reason: 'self_comment' };

  const automation = findActiveAutomation(db, account.id, comment.mediaId);
  if (!automation) return { kind: 'ignored', reason: 'no_automation' };
  if (comment.createdAt !== undefined) {
    // activatedAt (não createdAt): comentários feitos enquanto a automação estava pausada não são respondidos.
    if (comment.createdAt < automation.activatedAt) return { kind: 'ignored', reason: 'before_automation' };
    if (now - comment.createdAt > COMMENT_WINDOW_MS) return { kind: 'ignored', reason: 'too_old' };
  }

  const keyword = findMatchingKeyword(comment.text, automation.keywords);
  if (!keyword) return { kind: 'ignored', reason: 'no_keyword' };
  if (commentExists(db, comment.commentId)) return { kind: 'ignored', reason: 'duplicate' };

  return db.transaction((): MatchOutcome => {
    const base = {
      automationId: automation.id,
      commentId: comment.commentId,
      commenterIgsid: comment.fromId,
      commenterUsername: comment.fromUsername,
      commentText: comment.text,
      matchedKeyword: keyword,
      source: comment.source,
    };
    if (hasActedForPerson(db, automation.id, comment.fromId)) {
      const id = insertInteraction(db, { ...base, status: 'skipped', skipReason: 'already_replied_to_person' }, now);
      return id === null ? { kind: 'ignored', reason: 'duplicate' } : { kind: 'skipped', interactionId: id };
    }
    const id = insertInteraction(db, { ...base, status: 'queued' }, now);
    if (id === null) return { kind: 'ignored', reason: 'duplicate' };
    const publicAt = now + randomBetween(PUBLIC_REPLY_DELAY_MS, deps.random);
    const privateAt = publicAt + randomBetween(PRIVATE_REPLY_EXTRA_DELAY_MS, deps.random);
    enqueueJob(db, { interactionId: id, accountId: account.id, type: 'public_reply', runAt: publicAt }, now);
    enqueueJob(db, { interactionId: id, accountId: account.id, type: 'private_reply', runAt: privateAt }, now);
    return { kind: 'queued', interactionId: id };
  })();
}
