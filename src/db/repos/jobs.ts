import type { DB } from '../database.js';

export type JobType = 'public_reply' | 'private_reply';

export interface ClaimedJob {
  id: number;
  type: JobType;
  attempts: number;
  interactionId: number;
  interactionCreatedAt: number;
  commentId: string;
  commenterUsername: string | null;
  accountId: number;
  automationId: number;
}

export function enqueueJob(
  db: DB,
  job: { interactionId: number; accountId: number; type: JobType; runAt: number },
  now: number,
): void {
  db.prepare(
    "INSERT INTO jobs (interaction_id, account_id, type, status, attempts, run_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT (interaction_id, type) DO NOTHING",
  ).run(job.interactionId, job.accountId, job.type, job.runAt, now);
}

/**
 * Pega o próximo job vencido de uma conta apta (status ok, ou pausa de segurança vencida)
 * e o marca como 'running'. Jobs de contas desconectadas/pausadas ficam aguardando.
 */
export function claimNextDueJob(db: DB, now: number): ClaimedJob | undefined {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT j.id, j.type, j.attempts, j.interaction_id AS interactionId, i.created_at AS interactionCreatedAt,
           i.comment_id AS commentId, i.commenter_username AS commenterUsername, j.account_id AS accountId,
           i.automation_id AS automationId
         FROM jobs j
         JOIN interactions i ON i.id = j.interaction_id
         JOIN ig_accounts acc ON acc.id = j.account_id
         WHERE j.status = 'pending' AND j.run_at <= @now AND acc.token_enc IS NOT NULL
           AND (acc.status = 'ok' OR (acc.status = 'paused_by_safety' AND acc.paused_until <= @now))
         ORDER BY j.run_at, j.id
         LIMIT 1`,
      )
      .get({ now }) as ClaimedJob | undefined;
    if (row) db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(now, row.id);
    return row;
  })();
}

export function completeJob(db: DB, id: number, resultId: string, now: number): void {
  db.prepare("UPDATE jobs SET status = 'done', result_id = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?").run(
    resultId,
    now,
    now,
    id,
  );
}

export function failJob(
  db: DB,
  id: number,
  failure: { reason: string; code?: string; message?: string },
  now: number,
): void {
  db.prepare(
    "UPDATE jobs SET status = 'failed', attempts = attempts + 1, fail_reason = ?, last_error_code = ?, last_error_message = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?",
  ).run(failure.reason, failure.code ?? null, failure.message ?? null, now, now, id);
}

/**
 * Devolve o job para a fila. `countAttempt=false` para esperas que não são falha (ritmo, limite, conta pausada).
 * `recordAttempt` (padrão = `countAttempt`) registra `last_attempt_at` sem incrementar `attempts`: use quando
 * houve chamada real à API (ex.: rate limit, token inválido), para o espaçamento enxergá-la.
 */
export function rescheduleJob(
  db: DB,
  id: number,
  runAt: number,
  now: number,
  opts: { countAttempt: boolean; recordAttempt?: boolean; reason?: string; code?: string; message?: string },
): void {
  db.prepare(
    `UPDATE jobs SET status = 'pending', run_at = ?, attempts = attempts + ?, fail_reason = ?, last_error_code = ?,
       last_error_message = ?, last_attempt_at = COALESCE(?, last_attempt_at), updated_at = ? WHERE id = ?`,
  ).run(
    runAt,
    opts.countAttempt ? 1 : 0,
    opts.reason ?? null,
    opts.code ?? null,
    opts.message ?? null,
    (opts.recordAttempt ?? opts.countAttempt) ? now : null,
    now,
    id,
  );
}

/** Limite de chamadas vale para a conta inteira: nenhum job pendente dela roda antes de `runAt`. */
export function deferPendingJobsOfAccount(db: DB, accountId: number, runAt: number, now: number): void {
  db.prepare(
    "UPDATE jobs SET run_at = MAX(run_at, ?), updated_at = ? WHERE account_id = ? AND status = 'pending'",
  ).run(runAt, now, accountId);
}

/** Falha os jobs ainda pendentes de uma interação (ex.: a DM quando o comentário foi ocultado), sem registrar tentativa. */
export function failPendingJobsOfInteraction(db: DB, interactionId: number, reason: string, now: number): void {
  db.prepare(
    "UPDATE jobs SET status = 'failed', fail_reason = ?, updated_at = ? WHERE interaction_id = ? AND status = 'pending'",
  ).run(reason, now, interactionId);
}

/** Cancela um job (ex.: conta desconectada) registrando o motivo. */
export function cancelJob(db: DB, id: number, reason: string, now: number): void {
  db.prepare("UPDATE jobs SET status = 'cancelled', fail_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, id);
}

/** Quantas tentativas (sucesso, falha ou retentativa) a conta executou desde `since` — base do teto por hora. */
export function countActionsSince(db: DB, accountId: number, since: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM jobs WHERE account_id = ? AND last_attempt_at >= ?')
    .get(accountId, since) as { n: number };
  return row.n;
}

/** Momento da última tentativa da conta (base do espaçamento mínimo entre ações). */
export function lastActionAt(db: DB, accountId: number): number | null {
  const row = db.prepare('SELECT MAX(last_attempt_at) AS t FROM jobs WHERE account_id = ?').get(accountId) as {
    t: number | null;
  };
  return row.t;
}

/** Ao subir o processo: jobs que ficaram 'running' (queda no meio) voltam para a fila. */
export function resetRunningJobs(db: DB, now: number): number {
  return db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(now).changes;
}

/** Jobs pendentes cujo comentário passou da janela de 7 dias são cancelados. Retorna os interaction_ids afetados. */
export function cancelJobsOlderThan(db: DB, interactionCreatedBefore: number, now: number): number[] {
  const rows = db
    .prepare(
      `SELECT j.id, j.interaction_id AS interactionId FROM jobs j JOIN interactions i ON i.id = j.interaction_id
       WHERE j.status = 'pending' AND i.created_at < ?`,
    )
    .all(interactionCreatedBefore) as Array<{ id: number; interactionId: number }>;
  const cancel = db.prepare("UPDATE jobs SET status = 'cancelled', fail_reason = 'window_expired', updated_at = ? WHERE id = ?");
  for (const row of rows) cancel.run(now, row.id);
  return [...new Set(rows.map((row) => row.interactionId))];
}
