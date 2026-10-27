import { describe, expect, it, vi } from 'vitest';
import { getAccountById } from '../src/db/repos/accounts.js';
import { getAutomation } from '../src/db/repos/automations.js';
import { RECONCILE_MAX_PAGES, reconcileOnce } from '../src/engine/reconciler.js';
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

  it('não avança lastReconciledAt (e avisa) quando o limite de páginas é atingido', async () => {
    const db = makeDb();
    const account = seedAccount(db);
    const automation = seedAutomation(db, account.id);
    const now = T0 + 60 * 60_000;
    const warn = vi.fn();
    const listComments = vi.fn(async (_t: string, _m: string, cursor?: string) => ({
      comments: [{ id: `c${cursor ?? 0}`, text: 'lindo', timestamp: iso(T0 + 50 * 60_000), fromId: 'U1' }],
      nextCursor: `${Number(cursor ?? 0) + 1}`,
    }));
    const deps = {
      db, client: createFakeInstagram({ listComments }), decryptToken: (e: string) => e,
      now: () => now, random: () => 0, log: { warn },
    };
    expect(await reconcileOnce(deps)).toEqual({ checked: 1, queued: 0 });
    expect(listComments).toHaveBeenCalledTimes(RECONCILE_MAX_PAGES);
    expect(getAutomation(db, automation.id)!.lastReconciledAt).toBeNull();
    expect(warn).toHaveBeenCalledWith({ automationId: automation.id, pages: RECONCILE_MAX_PAGES }, expect.any(String));
  });

  it('ignora comentário oculto e comentário com timestamp inválido', async () => {
    const db = makeDb();
    const account = seedAccount(db);
    const automation = seedAutomation(db, account.id);
    const warn = vi.fn();
    const listComments = vi.fn(async () => ({
      comments: [
        { id: 'hid', text: 'eu quero', timestamp: iso(T0 + 50 * 60_000), fromId: 'U1', hidden: true },
        { id: 'bad', text: 'eu quero', timestamp: 'ontem', fromId: 'U2' },
        { id: 'ok', text: 'eu quero', timestamp: iso(T0 + 51 * 60_000), fromId: 'U3' },
      ],
    }));
    const deps = {
      db, client: createFakeInstagram({ listComments }), decryptToken: (e: string) => e,
      now: () => T0 + 60 * 60_000, random: () => 0, log: { warn },
    };
    expect(await reconcileOnce(deps)).toEqual({ checked: 1, queued: 1 });
    expect(db.prepare('SELECT comment_id AS id FROM interactions').all()).toEqual([{ id: 'ok' }]);
    expect(warn).toHaveBeenCalledWith({ automationId: automation.id, commentId: 'bad' }, expect.any(String));
  });

  it.each([
    ['rate_limit', new GraphApiError('too many', 400, 4)],
    ['abuse', new GraphApiError('blocked', 400, 368)],
  ])('erro de %s interrompe as demais automações da mesma conta na rodada', async (_kind, failure) => {
    const db = makeDb();
    const account = seedAccount(db);
    seedAutomation(db, account.id, { mediaId: 'M1' });
    seedAutomation(db, account.id, { mediaId: 'M2' });
    const listComments = vi.fn(async () => { throw failure; });
    const deps = {
      db, client: createFakeInstagram({ listComments }), decryptToken: (e: string) => e,
      now: () => T0 + 1, random: () => 0, log: silentLog,
    };
    expect(await reconcileOnce(deps)).toEqual({ checked: 0, queued: 0 });
    expect(listComments).toHaveBeenCalledTimes(1);
    expect(getAccountById(db, account.id)!.status).toBe('ok');
  });
});
