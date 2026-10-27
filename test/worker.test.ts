import { describe, expect, it, vi } from 'vitest';
import { disconnectAccount, getAccountById } from '../src/db/repos/accounts.js';
import { getAutomation } from '../src/db/repos/automations.js';
import { claimNextDueJob, lastActionAt } from '../src/db/repos/jobs.js';
import { handleComment } from '../src/engine/matcher.js';
import { SAFETY_PAUSE_MS } from '../src/engine/pacing.js';
import { processJob, runWorkerTick, type WorkerDeps } from '../src/engine/worker.js';
import { GraphApiError } from '../src/instagram/errors.js';
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
