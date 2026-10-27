import { describe, expect, it, vi } from 'vitest';
import { disconnectAccount, getAccountById } from '../src/db/repos/accounts.js';
import { getAutomation } from '../src/db/repos/automations.js';
import { claimNextDueJob, lastActionAt } from '../src/db/repos/jobs.js';
import { handleComment } from '../src/engine/matcher.js';
import { SAFETY_PAUSE_MS } from '../src/engine/pacing.js';
import { processJob, runWorkerTick, type WorkerDeps } from '../src/engine/worker.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { FAIL_REASON_TEXT } from '../src/panel/views/messages.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';
import { createFakeInstagram, silentLog } from './helpers/fakeInstagram.js';

function setup(clientOverrides: Parameters<typeof createFakeInstagram>[0] = {}) {
  const db = makeDb();
  const account = seedAccount(db);
  const automation = seedAutomation(db, account.id);
  let now = T0;
  const client = createFakeInstagram(clientOverrides);
  const deps: WorkerDeps = {
    db,
    client,
    decryptToken: (enc) => `plain:${enc}`,
    now: () => now,
    random: () => 0,
    maxActionsPerHour: 200,
    log: silentLog,
  };
  const comment = (id: string, from = 'U1') =>
    handleComment({ db, now: () => now, random: () => 0 }, {
      accountIgId: 'IG1', commentId: id, fromId: from, fromUsername: 'ana', isSelf: false, text: 'eu quero', mediaId: 'M1', source: 'webhook',
    });
  const advance = (ms: number) => { now += ms; };
  const jobRows = () =>
    db.prepare('SELECT type, status, attempts, run_at AS runAt, fail_reason AS reason FROM jobs ORDER BY id').all() as Array<{
      type: string; status: string; attempts: number; runAt: number; reason: string | null;
    }>;
  return { db, account, automation, client, deps, comment, advance, jobRows, getNow: () => now };
}

describe('runWorkerTick', () => {
  it('não executa antes do atraso; depois responde em público e manda a DM', async () => {
    const t = setup();
    t.comment('C1');
    expect(await runWorkerTick(t.deps)).toBe(0);
    t.advance(15_000);
    await runWorkerTick(t.deps);
    expect(t.client.replyToComment).toHaveBeenCalledWith('plain:enc-token', 'C1', 'Oi @ana, te mandei no direct!');
    t.advance(8_000);
    await runWorkerTick(t.deps);
    expect(t.client.sendPrivateReply).toHaveBeenCalledWith('plain:enc-token', 'IG1', 'C1', expect.stringContaining('https://exemplo.com'));
    expect(t.jobRows().map((j) => j.status)).toEqual(['done', 'done']);
    expect(getAutomation(t.db, t.automation.id)!.lastVariationIndex).toBe(0);
    const status = t.db.prepare('SELECT status FROM interactions').get() as { status: string };
    expect(status.status).toBe('done');
  });

  it('respeita 8s entre ações da mesma conta (reagenda sem contar tentativa)', async () => {
    const t = setup();
    t.comment('C1');
    t.advance(20_000); // os dois jobs vencidos
    await runWorkerTick(t.deps);
    expect(t.client.replyToComment).toHaveBeenCalledTimes(1);
    expect(t.client.sendPrivateReply).not.toHaveBeenCalled();
    const dm = t.jobRows()[1]!;
    expect(dm).toMatchObject({ status: 'pending', attempts: 0 });
    expect(dm.runAt).toBe(t.getNow() + 8_000);
  });

  it('token inválido: conta vai para "reconnect_required" e o job aguarda', async () => {
    const t = setup({ replyToComment: async () => { throw new GraphApiError('invalid', 400, 190); } });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    expect(getAccountById(t.db, t.account.id)!.status).toBe('reconnect_required');
    expect(t.jobRows()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('sinal de abuso: pausa a conta por 24h (disjuntor)', async () => {
    const t = setup({ replyToComment: async () => { throw new GraphApiError('blocked', 400, 368); } });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    const acc = getAccountById(t.db, t.account.id)!;
    expect(acc.status).toBe('paused_by_safety');
    expect(acc.pausedUntil).toBe(t.getNow() + SAFETY_PAUSE_MS);
    t.advance(60_000);
    expect(await runWorkerTick(t.deps)).toBe(0);
  });

  it('DMs desativadas: marca a conta, falha só a DM e mantém a resposta pública', async () => {
    const t = setup({
      sendPrivateReply: async () => {
        throw new GraphApiError('(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.', 403, 200);
      },
    });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    t.advance(10_000);
    await runWorkerTick(t.deps);
    expect(getAccountById(t.db, t.account.id)!.messagingDisabled).toBe(true);
    expect(t.jobRows().map((j) => [j.status, j.reason])).toEqual([
      ['done', null],
      ['failed', 'messaging_disabled'],
    ]);
    const status = t.db.prepare('SELECT status FROM interactions').get() as { status: string };
    expect(status.status).toBe('partial');
  });

  it('erro transitório: tenta de novo com backoff e desiste após 5 tentativas', async () => {
    const t = setup({ replyToComment: vi.fn(async () => { throw new GraphApiError('oops', 500); }) });
    t.comment('C1');
    t.db.prepare("UPDATE jobs SET status = 'cancelled' WHERE type = 'private_reply'").run();
    t.advance(15_000);
    for (const wait of [0, 60_000, 300_000, 900_000, 3_600_000]) {
      t.advance(wait);
      await runWorkerTick(t.deps);
    }
    expect(t.client.replyToComment).toHaveBeenCalledTimes(5);
    expect(t.jobRows()[0]).toMatchObject({ status: 'failed', attempts: 5, reason: 'temporary_error' });
  });

  it('rate limit: a tentativa real conta para o espaçamento, mesmo sem contar tentativa do job', async () => {
    const t = setup({ replyToComment: async () => { throw new GraphApiError('too many calls', 400, 4); } });
    t.comment('C1');
    t.advance(15_000);
    const attemptAt = t.getNow();
    await runWorkerTick(t.deps);
    expect(t.jobRows()[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(lastActionAt(t.db, t.account.id)).toBe(attemptAt);
  });

  it('comentário oculto: não responde, falha a resposta e a DM com "comment_hidden" e registra a tentativa', async () => {
    const t = setup({ isCommentHidden: async () => true });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    expect(t.client.isCommentHidden).toHaveBeenCalledWith('plain:enc-token', 'C1');
    expect(t.client.replyToComment).not.toHaveBeenCalled();
    t.advance(60_000);
    await runWorkerTick(t.deps);
    expect(t.client.sendPrivateReply).not.toHaveBeenCalled();
    expect(t.jobRows().map((j) => [j.type, j.status, j.reason])).toEqual([
      ['public_reply', 'failed', 'comment_hidden'],
      ['private_reply', 'failed', 'comment_hidden'],
    ]);
    expect(lastActionAt(t.db, t.account.id)).toBe(T0 + 15_000);
    const status = t.db.prepare('SELECT status FROM interactions').get() as { status: string };
    expect(status.status).toBe('failed');
    expect(FAIL_REASON_TEXT.comment_hidden).toBe('O comentário foi ocultado — nada foi enviado');
  });

  it('comentário visível: confere antes e responde em seguida', async () => {
    const t = setup();
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    expect(t.client.isCommentHidden).toHaveBeenCalledTimes(1);
    expect(t.client.replyToComment).toHaveBeenCalledTimes(1);
    expect(t.client.isCommentHidden.mock.invocationCallOrder[0]!).toBeLessThan(t.client.replyToComment.mock.invocationCallOrder[0]!);
  });

  it('erro na conferência de oculto é tratado como erro da API (classifyError)', async () => {
    const t = setup({ isCommentHidden: async () => { throw new GraphApiError('too many calls', 400, 4); } });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    expect(t.client.replyToComment).not.toHaveBeenCalled();
    expect(t.jobRows()[0]).toMatchObject({ status: 'pending', attempts: 0, reason: 'rate_limited' });
    expect(lastActionAt(t.db, t.account.id)).toBe(T0 + 15_000);

    const gone = setup({ isCommentHidden: async () => { throw new GraphApiError('Unsupported get request', 400, 100); } });
    gone.comment('C1');
    gone.advance(15_000);
    await runWorkerTick(gone.deps);
    expect(gone.jobRows()[0]).toMatchObject({ status: 'failed', reason: 'comment_unavailable' });
  });

  it('rate limit vale para a conta: adia todos os jobs pendentes dela até o horário de retentativa', async () => {
    const t = setup({ replyToComment: async () => { throw new GraphApiError('too many calls', 400, 4); } });
    t.comment('C1', 'U1');
    t.comment('C2', 'U2');
    t.comment('C3', 'U3');
    const other = seedAccount(t.db, { igId: 'IG2', username: 'outra' });
    seedAutomation(t.db, other.id, { mediaId: 'M2' });
    handleComment({ db: t.db, now: () => t.getNow(), random: () => 0 }, {
      accountIgId: 'IG2', commentId: 'O1', fromId: 'U9', isSelf: false, text: 'eu quero', mediaId: 'M2', source: 'webhook',
    });
    t.advance(15_000);
    const retryAt = t.getNow() + 15 * 60_000;
    expect(await processJob(t.deps, claimNextDueJob(t.db, t.getNow())!)).toBe('rescheduled');
    const pending = t.db.prepare("SELECT account_id AS accountId, run_at AS runAt FROM jobs WHERE status = 'pending'").all() as Array<{
      accountId: number; runAt: number;
    }>;
    const mine = pending.filter((j) => j.accountId === t.account.id);
    expect(mine).toHaveLength(6);
    for (const job of mine) expect(job.runAt).toBeGreaterThanOrEqual(retryAt);
    for (const job of pending.filter((j) => j.accountId === other.id)) expect(job.runAt).toBeLessThan(retryAt);
    t.advance(60_000);
    expect(await runWorkerTick(t.deps)).toBe(1); // só a conta IG2 age
    expect(t.client.replyToComment).toHaveBeenCalledTimes(2);
  });

  it('resposta pública reagendada (ritmo) empurra a DM da mesma interação para depois dela', async () => {
    const t = setup();
    t.comment('C0', 'U0');
    t.comment('C1', 'U1');
    t.advance(15_000);
    // C0 já foi atendido há 1 s: o espaçamento de 8 s adia a resposta pública de C1
    t.db.prepare("UPDATE jobs SET status = 'done', last_attempt_at = ? WHERE interaction_id = 1").run(t.getNow() - 1_000);
    const job = claimNextDueJob(t.db, t.getNow())!;
    expect(job.type).toBe('public_reply');
    expect(await processJob(t.deps, job)).toBe('rescheduled');
    const [pub, dm] = t.jobRows().slice(2);
    expect(pub!.runAt).toBe(t.getNow() + 7_000);
    expect(dm!.runAt).toBeGreaterThanOrEqual(pub!.runAt + 3_000);
    expect(dm!.runAt).toBeLessThanOrEqual(pub!.runAt + 10_000);
  });

  it('DM não sai enquanto a resposta pública da interação ainda está na fila', async () => {
    const t = setup();
    t.comment('C1');
    t.db.prepare("UPDATE jobs SET run_at = ? WHERE type = 'public_reply'").run(T0 + 60_000);
    t.advance(18_000);
    expect(await runWorkerTick(t.deps)).toBe(1);
    expect(t.client.sendPrivateReply).not.toHaveBeenCalled();
    expect(t.jobRows()[1]).toMatchObject({ status: 'pending', attempts: 0, runAt: T0 + 63_000 });
    expect(lastActionAt(t.db, t.account.id)).toBeNull();
    t.advance(60_000);
    await runWorkerTick(t.deps);
    t.advance(10_000);
    await runWorkerTick(t.deps);
    expect(t.client.replyToComment.mock.invocationCallOrder[0]!).toBeLessThan(t.client.sendPrivateReply.mock.invocationCallOrder[0]!);
  });

  it('com vários comentários simultâneos, a DM nunca sai antes da resposta pública', async () => {
    let seed = 42;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
    };
    let inversions = 0;
    for (let round = 0; round < 20; round += 1) {
      const t = setup();
      const replied = new Set<string>();
      t.client.replyToComment.mockImplementation(async (_t, commentId) => { replied.add(commentId); return { id: 'R' }; });
      t.client.sendPrivateReply.mockImplementation(async (_t, _ig, commentId) => {
        if (!replied.has(commentId)) inversions += 1;
        return { messageId: 'M' };
      });
      const deps = { ...t.deps, random };
      for (let i = 0; i < 5; i += 1) {
        handleComment({ db: t.db, now: t.getNow, random }, {
          accountIgId: 'IG1', commentId: `C${i}`, fromId: `U${i}`, isSelf: false, text: 'eu quero', mediaId: 'M1', source: 'webhook',
        });
      }
      for (let s = 0; s < 300; s += 1) {
        t.advance(1_000);
        await runWorkerTick(deps);
      }
      expect(t.client.sendPrivateReply).toHaveBeenCalledTimes(5);
    }
    expect(inversions).toBe(0);
  });

  it('com o sinal de parada, termina o job atual e não pega o próximo', async () => {
    const stop = new AbortController();
    const t = setup({
      replyToComment: async () => {
        stop.abort();
        return { id: 'R' };
      },
    });
    t.comment('C1', 'U1');
    t.comment('C2', 'U2');
    t.advance(15_000);
    expect(await runWorkerTick(t.deps, 10, stop.signal)).toBe(1);
    expect(t.client.replyToComment).toHaveBeenCalledTimes(1);
    expect(t.jobRows().map((j) => j.status)).toEqual(['done', 'pending', 'pending', 'pending']);
    expect(await runWorkerTick(t.deps, 10, stop.signal)).toBe(0);
  });

  it('conta desconectada: cancela o job sem chamar a API', async () => {
    const t = setup();
    t.comment('C1');
    t.advance(15_000);
    // corrida: o job já foi reivindicado quando a conta é desconectada
    const job = claimNextDueJob(t.db, t.getNow())!;
    disconnectAccount(t.db, t.account.id, t.getNow()); // cancela os pendentes; o job 'running' fica para o worker
    expect(await processJob(t.deps, job)).toBe('failed');
    expect(t.client.replyToComment).not.toHaveBeenCalled();
    expect(t.jobRows()[0]).toMatchObject({ status: 'cancelled', reason: 'account_disconnected' });
    expect(t.jobRows()[1]).toMatchObject({ status: 'cancelled', reason: 'account_disconnected' });
    const status = t.db.prepare('SELECT status FROM interactions').get() as { status: string };
    expect(status.status).toBe('failed');
  });
});
