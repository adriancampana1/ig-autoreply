import { deleteWebhookEventsMentioning, insertWebhookEvent } from '../src/db/repos/webhookEvents.js';
import { describe, expect, it } from 'vitest';
import {
  disconnectAccount,
  getAccountById,
  isAccountUsable,
  setAccountStatus,
  upsertConnectedAccount,
} from '../src/db/repos/accounts.js';
import {
  DuplicateAutomationError,
  findActiveAutomation,
  getAutomation,
  listAutomationSummaries,
} from '../src/db/repos/automations.js';
import {
  hasActedForPerson,
  insertInteraction,
  listActivity,
  purgeInteractionsBefore,
  refreshInteractionStatus,
} from '../src/db/repos/interactions.js';
import {
  cancelJobsOlderThan,
  cancelJob,
  claimNextDueJob,
  completeJob,
  countActionsSince,
  enqueueJob,
  failJob,
  lastActionAt,
  rescheduleJob,
  resetRunningJobs,
} from '../src/db/repos/jobs.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';

const interaction = (automationId: number, commentId: string, person = 'U1') => ({
  automationId,
  commentId,
  commenterIgsid: person,
  commenterUsername: 'ana',
  commentText: 'eu quero',
  matchedKeyword: 'eu quero',
  source: 'webhook' as const,
  status: 'queued' as const,
});

describe('accounts repo', () => {
  it('reconectar limpa status de erro e mantém o mesmo id', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    setAccountStatus(db, acc.id, 'reconnect_required', T0, { lastError: 'token' });
    const again = upsertConnectedAccount(
      db,
      { igId: 'IG1', appUserId: 'APP', username: 'loja_nova', tokenEnc: 'x', tokenExpiresAt: T0 + 1 },
      T0 + 5,
    );
    expect(again).toMatchObject({ id: acc.id, username: 'loja_nova', status: 'ok', lastError: null });
  });

  it('isAccountUsable considera token, status e pausa vencida', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    expect(isAccountUsable(acc, T0)).toBe(true);
    setAccountStatus(db, acc.id, 'paused_by_safety', T0, { pausedUntil: T0 + 1000 });
    expect(isAccountUsable(getAccountById(db, acc.id)!, T0)).toBe(false);
    expect(isAccountUsable(getAccountById(db, acc.id)!, T0 + 1000)).toBe(true);
    disconnectAccount(db, acc.id, T0);
    expect(isAccountUsable(getAccountById(db, acc.id)!, T0 + 1000)).toBe(false);
  });

  it('desconectar pausa as automações da conta', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    disconnectAccount(db, acc.id, T0);
    expect(getAutomation(db, auto.id)!.isActive).toBe(false);
  });
});

describe('automations repo', () => {
  it('impede duas automações no mesmo post', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    seedAutomation(db, acc.id);
    expect(() => seedAutomation(db, acc.id)).toThrow(DuplicateAutomationError);
  });

  it('findActiveAutomation ignora automações pausadas e o resumo conta respostas', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    expect(findActiveAutomation(db, acc.id, 'M1')?.id).toBe(auto.id);
    const id = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    db.prepare("UPDATE interactions SET status = 'done' WHERE id = ?").run(id);
    expect(listAutomationSummaries(db, T0 - 1)[0]).toMatchObject({ accountUsername: 'loja', repliesToday: 1, repliesTotal: 1 });
  });
});

describe('interactions + jobs repos', () => {
  it('deduplica por comment_id e detecta pessoa já atendida', () => {
    const db = makeDb();
    const auto = seedAutomation(db, seedAccount(db).id);
    expect(insertInteraction(db, interaction(auto.id, 'C1'), T0)).toBeTypeOf('number');
    expect(insertInteraction(db, interaction(auto.id, 'C1'), T0)).toBeNull();
    expect(hasActedForPerson(db, auto.id, 'U1')).toBe(true);
    expect(hasActedForPerson(db, auto.id, 'U2')).toBe(false);
  });

  it('claimNextDueJob respeita run_at e o estado da conta', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 + 100 }, T0);
    expect(claimNextDueJob(db, T0)).toBeUndefined();
    setAccountStatus(db, acc.id, 'reconnect_required', T0);
    expect(claimNextDueJob(db, T0 + 100)).toBeUndefined();
    setAccountStatus(db, acc.id, 'ok', T0);
    expect(claimNextDueJob(db, T0 + 100)).toMatchObject({ type: 'public_reply', commentId: 'C1', commenterUsername: 'ana' });
    expect(claimNextDueJob(db, T0 + 100)).toBeUndefined(); // já está 'running'
  });

  it('status agregado: done, partial, failed', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'private_reply', runAt: T0 }, T0);
    expect(refreshInteractionStatus(db, iid)).toBe('queued');
    const [a, b] = db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: number }>;
    completeJob(db, a!.id, 'R1', T0);
    failJob(db, b!.id, { reason: 'messaging_disabled' }, T0);
    expect(refreshInteractionStatus(db, iid)).toBe('partial');
    const rows = listActivity(db, { limit: 10, offset: 0 });
    expect(rows[0]).toMatchObject({ publicStatus: 'done', dmStatus: 'failed', dmFailReason: 'messaging_disabled', status: 'partial' });
  });

  it('cancela jobs pendentes de comentários com mais de 7 dias', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'private_reply', runAt: T0 }, T0);
    expect(cancelJobsOlderThan(db, T0 + 1, T0 + 2)).toEqual([iid]);
    expect(refreshInteractionStatus(db, iid)).toBe('failed');
  });
});

describe('rate-limit primitives', () => {
  it('conta tentativas (sucesso, falha e retentativa), mas não esperas de ritmo', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const jobIdOf = (iid: number) => (db.prepare('SELECT id FROM jobs WHERE interaction_id = ?').get(iid) as { id: number }).id;
    const iids = ['C1', 'C2', 'C3', 'C4'].map((c) => {
      const iid = insertInteraction(db, interaction(auto.id, c), T0)!;
      enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
      return iid;
    });
    const [i1, i2, i3, i4] = iids as [number, number, number, number];
    expect(lastActionAt(db, acc.id)).toBeNull();
    completeJob(db, jobIdOf(i1), 'R1', T0 + 1);
    failJob(db, jobIdOf(i2), { reason: 'boom' }, T0 + 2);
    rescheduleJob(db, jobIdOf(i3), T0 + 100, T0 + 3, { countAttempt: true, reason: 'timeout' });
    rescheduleJob(db, jobIdOf(i4), T0 + 200, T0 + 4, { countAttempt: false });
    expect(lastActionAt(db, acc.id)).toBe(T0 + 3);
    expect(countActionsSince(db, acc.id, T0)).toBe(3);
    expect(countActionsSince(db, acc.id, T0 + 2)).toBe(2);
    expect(countActionsSince(db, acc.id, T0 + 4)).toBe(0);
  });

  it('recordAttempt registra a tentativa para o ritmo sem incrementar attempts', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    const id = (db.prepare('SELECT id FROM jobs').get() as { id: number }).id;
    rescheduleJob(db, id, T0 + 100, T0 + 5, { countAttempt: false, recordAttempt: true, reason: 'rate_limited' });
    expect(lastActionAt(db, acc.id)).toBe(T0 + 5);
    expect(db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(id)).toEqual({ attempts: 0 });
  });

  it('cancelJob marca o job como cancelado com o motivo', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    const id = (db.prepare('SELECT id FROM jobs').get() as { id: number }).id;
    cancelJob(db, id, 'account_disconnected', T0 + 1);
    expect(db.prepare('SELECT status, fail_reason AS reason, updated_at AS at FROM jobs WHERE id = ?').get(id)).toEqual({
      status: 'cancelled', reason: 'account_disconnected', at: T0 + 1,
    });
  });

  it('resetRunningJobs devolve jobs em execução para a fila', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    expect(claimNextDueJob(db, T0)).toBeDefined();
    expect(resetRunningJobs(db, T0 + 1)).toBe(1);
    expect(claimNextDueJob(db, T0 + 2)).toMatchObject({ commentId: 'C1' });
  });

  it('purgeInteractionsBefore remove os jobs em cascata', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    expect(purgeInteractionsBefore(db, T0 + 1)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
  });
});

describe('claimNextDueJob e contas', () => {
  it('pula conta pausada por segurança até a pausa vencer', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    setAccountStatus(db, acc.id, 'paused_by_safety', T0, { pausedUntil: T0 + 1000 });
    expect(claimNextDueJob(db, T0 + 999)).toBeUndefined();
    expect(claimNextDueJob(db, T0 + 1000)).toMatchObject({ commentId: 'C1' });
  });

  it('pula conta sem token', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    db.prepare('UPDATE ig_accounts SET token_enc = NULL WHERE id = ?').run(acc.id);
    expect(claimNextDueJob(db, T0 + 100)).toBeUndefined();
  });
});

describe('desconexão, reconexão e status', () => {
  it('desconectar cancela jobs pendentes; reconectar não os reativa', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    disconnectAccount(db, acc.id, T0);
    expect(db.prepare('SELECT status, fail_reason AS reason FROM jobs').get()).toEqual({ status: 'cancelled', reason: 'account_disconnected' });
    expect(db.prepare('SELECT status FROM interactions WHERE id = ?').get(iid)).toEqual({ status: 'failed' });
    upsertConnectedAccount(db, { igId: 'IG1', appUserId: 'APP', username: 'loja', tokenEnc: 'x', tokenExpiresAt: T0 + 1 }, T0 + 5);
    expect(claimNextDueJob(db, T0 + 100)).toBeUndefined();
  });

  it('interação sem jobs (pulada) mantém o status', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(
      db,
      { ...interaction(auto.id, 'C1'), status: 'skipped', skipReason: 'already_replied_to_person' },
      T0,
    )!;
    expect(refreshInteractionStatus(db, iid)).toBe('skipped');
    expect(db.prepare('SELECT status FROM interactions WHERE id = ?').get(iid)).toEqual({ status: 'skipped' });
  });

  it('interação inexistente (ex.: apagada pela exclusão de dados) devolve null sem lançar', () => {
    const db = makeDb();
    expect(refreshInteractionStatus(db, 9999)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM interactions').get()).toEqual({ n: 0 });
  });
});

describe('webhook_events por conta', () => {
  it('deleteWebhookEventsMentioning apaga só os eventos que citam o ig_id', () => {
    const db = makeDb();
    insertWebhookEvent(db, '{"entry":[{"id":"17841400000000001"}]}', T0);
    insertWebhookEvent(db, '{"entry":[{"id":"17841400000000002"}]}', T0);
    expect(deleteWebhookEventsMentioning(db, '17841400000000001')).toBe(1);
    expect(db.prepare('SELECT payload_json AS p FROM webhook_events').all()).toEqual([{ p: '{"entry":[{"id":"17841400000000002"}]}' }]);
  });
});
