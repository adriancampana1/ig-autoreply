import { describe, expect, it, vi } from 'vitest';
import { getAccountById, updateAccountToken } from '../src/db/repos/accounts.js';
import { insertInteraction } from '../src/db/repos/interactions.js';
import { enqueueJob } from '../src/db/repos/jobs.js';
import { insertWebhookEvent } from '../src/db/repos/webhookEvents.js';
import { refreshExpiringTokens, runHousekeeping } from '../src/engine/maintenance.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';
import { silentLog } from './helpers/fakeInstagram.js';

const DAY = 86_400_000;

describe('refreshExpiringTokens', () => {
  const deps = (db: ReturnType<typeof makeDb>, now: number, refresh = vi.fn(async () => ({ accessToken: 'NEW', expiresInSec: 60 * 86_400 }))) => ({
    db, refresh, encrypt: (p: string) => `enc:${p}`, decrypt: (e: string) => e, now: () => now, log: silentLog,
  });

  it('não renova token novo (<24h) nem token com validade longa', async () => {
    const db = makeDb();
    seedAccount(db); // vence em T0 + 60 dias
    const d = deps(db, T0 + 1000);
    expect(await refreshExpiringTokens(d)).toEqual({ refreshed: 0, failed: 0 });
    const d2 = deps(db, T0 + 2 * DAY);
    expect(await refreshExpiringTokens(d2)).toEqual({ refreshed: 0, failed: 0 });
  });

  it('não renova token com menos de 24h de idade mesmo dentro da janela de 30 dias', async () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const now = T0 + 12 * 3_600_000;
    updateAccountToken(db, acc.id, 'x', now + 5 * DAY, now - 3_600_000); // renovado há 1h, vence em 5 dias
    const d = deps(db, now);
    expect(await refreshExpiringTokens(d)).toEqual({ refreshed: 0, failed: 0 });
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('renova quando faltam ≤ 30 dias e grava a nova expiração', async () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const now = T0 + 35 * DAY;
    const d = deps(db, now);
    expect(await refreshExpiringTokens(d)).toEqual({ refreshed: 1, failed: 0 });
    expect(d.refresh).toHaveBeenCalledWith('enc-token');
    expect(getAccountById(db, acc.id)).toMatchObject({ tokenEnc: 'enc:NEW', tokenExpiresAt: now + 60 * DAY, tokenRefreshedAt: now });
  });

  it('token revogado: conta vai para "reconnect_required"', async () => {
    const db = makeDb();
    const acc = seedAccount(db);
    updateAccountToken(db, acc.id, 'x', T0 + 10 * DAY, T0);
    const d = deps(db, T0 + 2 * DAY, vi.fn(async () => { throw new GraphApiError('revoked', 400, 190); }));
    expect(await refreshExpiringTokens(d)).toEqual({ refreshed: 0, failed: 1 });
    expect(getAccountById(db, acc.id)!.status).toBe('reconnect_required');
  });
});

describe('runHousekeeping', () => {
  it('apaga eventos > 30 dias e interações > 90 dias', () => {
    const db = makeDb();
    const auto = seedAutomation(db, seedAccount(db).id);
    insertWebhookEvent(db, '{}', T0);
    insertWebhookEvent(db, '{}', T0 + 89 * DAY);
    insertInteraction(db, {
      automationId: auto.id, commentId: 'C1', commenterIgsid: 'U1', commentText: 'x', matchedKeyword: 'x',
      source: 'webhook', status: 'skipped',
    }, T0);
    expect(runHousekeeping(db, T0 + 91 * DAY)).toEqual({ cancelled: 0, events: 1, interactions: 1 });
  });

  const queuedInteraction = (db: ReturnType<typeof makeDb>, automationId: number, accountId: number, commentId: string, at: number) => {
    const id = insertInteraction(db, {
      automationId, commentId, commenterIgsid: `U-${commentId}`, commentText: 'eu quero', matchedKeyword: 'eu quero',
      source: 'webhook', status: 'queued',
    }, at)!;
    enqueueJob(db, { interactionId: id, accountId, type: 'public_reply', runAt: at }, at);
    return id;
  };

  it('cancela jobs pendentes de comentários com mais de 7 dias e recalcula o status', () => {
    const db = makeDb();
    const account = seedAccount(db);
    const auto = seedAutomation(db, account.id);
    const now = T0 + 10 * DAY;
    const oldId = queuedInteraction(db, auto.id, account.id, 'OLD', T0 + 2 * DAY); // 8 dias
    const freshId = queuedInteraction(db, auto.id, account.id, 'NEW', T0 + 5 * DAY); // 5 dias
    expect(runHousekeeping(db, now)).toEqual({ cancelled: 1, events: 0, interactions: 0 });
    const job = (id: number) => db.prepare('SELECT status, fail_reason AS reason FROM jobs WHERE interaction_id = ?').get(id);
    expect(job(oldId)).toEqual({ status: 'cancelled', reason: 'window_expired' });
    expect(job(freshId)).toEqual({ status: 'pending', reason: null });
    const status = (id: number) => (db.prepare('SELECT status FROM interactions WHERE id = ?').get(id) as { status: string }).status;
    expect(status(oldId)).toBe('failed');
    expect(status(freshId)).toBe('queued');
  });

  it('a retenção de 90 dias apaga interações antigas e seus jobs em cascata', () => {
    const db = makeDb();
    const account = seedAccount(db);
    const auto = seedAutomation(db, account.id);
    const now = T0 + 100 * DAY;
    queuedInteraction(db, auto.id, account.id, 'OLD', T0 + DAY); // 99 dias
    const recentId = queuedInteraction(db, auto.id, account.id, 'RECENT', T0 + 50 * DAY);
    expect(runHousekeeping(db, now).interactions).toBe(1);
    expect(db.prepare('SELECT id FROM interactions').all()).toEqual([{ id: recentId }]);
    expect(db.prepare('SELECT interaction_id AS id FROM jobs').all()).toEqual([{ id: recentId }]);
  });

  it('a retenção de eventos de webhook usa o corte de 30 dias', () => {
    const db = makeDb();
    insertWebhookEvent(db, '{"a":1}', T0 + 69 * DAY); // 31 dias antes de "agora"
    insertWebhookEvent(db, '{"a":2}', T0 + 71 * DAY); // 29 dias
    expect(runHousekeeping(db, T0 + 100 * DAY).events).toBe(1);
    expect(db.prepare('SELECT payload_json AS p FROM webhook_events').all()).toEqual([{ p: '{"a":2}' }]);
  });
});
