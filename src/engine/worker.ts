import type { DB } from '../db/database.js';
import { getAccountById, setAccountStatus, setMessagingDisabled, type Account } from '../db/repos/accounts.js';
import { getAutomation, setLastVariationIndex } from '../db/repos/automations.js';
import { refreshInteractionStatus } from '../db/repos/interactions.js';
import {
  cancelJob,
  claimNextDueJob,
  completeJob,
  countActionsSince,
  failJob,
  lastActionAt,
  rescheduleJob,
  type ClaimedJob,
} from '../db/repos/jobs.js';
import type { InstagramClient } from '../instagram/client.js';
import { classifyError } from '../instagram/errors.js';
import { pickVariationIndex, renderReply } from '../lib/text.js';
import { nextAllowedAt, RECONNECT_RETRY_MS, SAFETY_PAUSE_MS, transientBackoff } from './pacing.js';

export interface WorkerDeps {
  db: DB;
  client: InstagramClient;
  decryptToken: (encoded: string) => string;
  now: () => number;
  random: () => number;
  maxActionsPerHour: number;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export type JobOutcome = 'done' | 'failed' | 'rescheduled';

async function execute(deps: WorkerDeps, job: ClaimedJob, account: Account): Promise<string> {
  const automation = getAutomation(deps.db, job.automationId);
  if (!automation) throw new Error('Automação removida');
  const token = deps.decryptToken(account.tokenEnc!);
  if (job.type === 'public_reply') {
    const index = pickVariationIndex(automation.publicVariations.length, automation.lastVariationIndex, deps.random);
    const text = renderReply(automation.publicVariations[index]!, job.commenterUsername);
    const { id } = await deps.client.replyToComment(token, job.commentId, text);
    setLastVariationIndex(deps.db, automation.id, index);
    return id;
  }
  const { messageId } = await deps.client.sendPrivateReply(token, account.igId, job.commentId, automation.dmText);
  if (account.messagingDisabled) setMessagingDisabled(deps.db, account.id, false, deps.now());
  return messageId;
}

/** Executa um job já reivindicado e aplica a política de erros da spec §9. */
export async function processJob(deps: WorkerDeps, job: ClaimedJob): Promise<JobOutcome> {
  const { db } = deps;
  const now = deps.now();
  const account = getAccountById(db, job.accountId);
  if (!account || account.status === 'disconnected') {
    cancelJob(db, job.id, 'account_disconnected', now);
    refreshInteractionStatus(db, job.interactionId);
    return 'failed';
  }
  if (!account.tokenEnc) {
    rescheduleJob(db, job.id, now + RECONNECT_RETRY_MS, now, { countAttempt: false, reason: 'token_invalid' });
    return 'rescheduled';
  }

  const allowedAt = nextAllowedAt({
    now,
    lastActionAt: lastActionAt(db, account.id),
    actionsLastHour: countActionsSince(db, account.id, now - 60 * 60_000),
    maxPerHour: deps.maxActionsPerHour,
  });
  if (allowedAt > now) {
    rescheduleJob(db, job.id, allowedAt + Math.floor(deps.random() * 2_000), now, { countAttempt: false });
    return 'rescheduled';
  }

  if (account.status === 'paused_by_safety') setAccountStatus(db, account.id, 'ok', now);

  try {
    const resultId = await execute(deps, job, account);
    completeJob(db, job.id, resultId, deps.now());
    refreshInteractionStatus(db, job.interactionId);
    deps.log.info({ jobId: job.id, type: job.type, accountId: account.id }, 'ação executada');
    return 'done';
  } catch (error) {
    const c = classifyError(error);
    const at = deps.now();
    const details = { reason: c.reason, code: c.code, message: c.message };
    deps.log.warn({ jobId: job.id, type: job.type, accountId: account.id, ...details, kind: c.kind }, 'falha ao executar ação');

    switch (c.kind) {
      case 'auth':
        setAccountStatus(db, account.id, 'reconnect_required', at, { lastError: c.message });
        rescheduleJob(db, job.id, at, at, { countAttempt: false, recordAttempt: true, ...details });
        return 'rescheduled';
      case 'rate_limit':
        rescheduleJob(db, job.id, at + (c.retryAfterMs ?? 15 * 60_000), at, { countAttempt: false, recordAttempt: true, ...details });
        return 'rescheduled';
      case 'abuse': {
        const pausedUntil = at + SAFETY_PAUSE_MS;
        setAccountStatus(db, account.id, 'paused_by_safety', at, { lastError: c.message, pausedUntil });
        rescheduleJob(db, job.id, pausedUntil, at, { countAttempt: false, recordAttempt: true, ...details });
        return 'rescheduled';
      }
      case 'messaging_disabled':
        setMessagingDisabled(db, account.id, true, at);
        failJob(db, job.id, details, at);
        break;
      case 'permanent':
        failJob(db, job.id, details, at);
        break;
      case 'transient': {
        const attempts = job.attempts + 1;
        if (attempts >= (c.maxAttempts ?? 5)) {
          failJob(db, job.id, details, at);
          break;
        }
        rescheduleJob(db, job.id, at + transientBackoff(attempts), at, { countAttempt: true, ...details });
        return 'rescheduled';
      }
    }
    refreshInteractionStatus(db, job.interactionId);
    return 'failed';
  }
}

/** Uma rodada do worker: processa em sequência até `maxJobs` jobs vencidos. */
export async function runWorkerTick(deps: WorkerDeps, maxJobs = 10): Promise<number> {
  let processed = 0;
  while (processed < maxJobs) {
    const job = claimNextDueJob(deps.db, deps.now());
    if (!job) break;
    await processJob(deps, job);
    processed += 1;
  }
  return processed;
}
