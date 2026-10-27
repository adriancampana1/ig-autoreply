import { describe, expect, it, vi } from 'vitest';
import { getAccountById } from '../src/db/repos/accounts.js';
import { getAutomation } from '../src/db/repos/automations.js';
import { reconcileOnce } from '../src/engine/reconciler.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';
import { createFakeInstagram, silentLog } from './helpers/fakeInstagram.js';

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', '+0000');

describe('reconcileOnce', () => {
  it('enfileira comentários novos com palavra-chave e para ao chegar em comentários antigos', async () => {
    const db = makeDb();
    const account = seedAccount(db);
    const automation = seedAutomation(db, account.id);
    const now = T0 + 60 * 60_000;
    const listComments = vi.fn(async (_t: string, _m: string, cursor?: string) =>
      cursor
        ? { comments: [{ id: 'old', text: 'eu quero', timestamp: iso(T0 - 1), fromId: 'U9' }] }
        : {
            comments: [
              { id: 'c2', text: 'EU QUERO', timestamp: iso(T0 + 50 * 60_000), fromId: 'U2', fromUsername: 'bia' },
              { id: 'c1', text: 'lindo', timestamp: iso(T0 + 40 * 60_000), fromId: 'U1' },
            ],
            nextCursor: 'P2',
          },
    );
    const deps = {
      db, client: createFakeInstagram({ listComments }), decryptToken: (e: string) => e,
      now: () => now, random: () => 0, log: silentLog,
    };
    expect(await reconcileOnce(deps)).toEqual({ checked: 1, queued: 1 });
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(getAutomation(db, automation.id)!.lastReconciledAt).toBe(now);
    const rows = db.prepare('SELECT comment_id AS id, source FROM interactions').all();
    expect(rows).toEqual([{ id: 'c2', source: 'reconciler' }]);
  });

  it('token inválido durante a varredura marca a conta para reconectar', async () => {
    const db = makeDb();
    const account = seedAccount(db);
    seedAutomation(db, account.id);
    const deps = {
      db,
      client: createFakeInstagram({ listComments: vi.fn(async () => { throw new GraphApiError('bad', 400, 190); }) }),
      decryptToken: (e: string) => e, now: () => T0 + 1, random: () => 0, log: silentLog,
    };
    expect(await reconcileOnce(deps)).toEqual({ checked: 0, queued: 0 });
    expect(getAccountById(db, account.id)!.status).toBe('reconnect_required');
  });
});
