import { describe, expect, it, vi } from 'vitest';
import { getAccountById, updateAccountToken } from '../src/db/repos/accounts.js';
import { insertInteraction } from '../src/db/repos/interactions.js';
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
});
