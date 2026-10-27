import { describe, expect, it } from 'vitest';
import { disconnectAccount } from '../src/db/repos/accounts.js';
import { setAutomationActive } from '../src/db/repos/automations.js';
import { handleComment, type IncomingComment } from '../src/engine/matcher.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';

function setup() {
  const db = makeDb();
  const account = seedAccount(db);
  const automation = seedAutomation(db, account.id);
  const deps = { db, now: () => T0 + 1000, random: () => 0 };
  const comment = (overrides: Partial<IncomingComment> = {}): IncomingComment => ({
    accountIgId: 'IG1',
    commentId: 'C1',
    fromId: 'U1',
    fromUsername: 'ana',
    isSelf: false,
    text: 'Eu quero!!',
    mediaId: 'M1',
    source: 'webhook',
    ...overrides,
  });
  return { db, account, automation, deps, comment };
}

const jobs = (db: ReturnType<typeof setup>['db']) =>
  db.prepare('SELECT type, run_at AS runAt FROM jobs ORDER BY run_at').all() as Array<{ type: string; runAt: number }>;

describe('handleComment', () => {
  it('cria interação e 2 jobs com atraso: pública (15–90s) e DM depois (3–10s)', () => {
    const { db, deps, comment } = setup();
    expect(handleComment(deps, comment())).toMatchObject({ kind: 'queued' });
    expect(jobs(db)).toEqual([
      { type: 'public_reply', runAt: T0 + 1000 + 15_000 },
      { type: 'private_reply', runAt: T0 + 1000 + 15_000 + 3_000 },
    ]);
  });

  it('ignora conta desconhecida ou desconectada', () => {
    const { db, account, deps, comment } = setup();
    expect(handleComment(deps, comment({ accountIgId: 'OUTRA' }))).toEqual({ kind: 'ignored', reason: 'unknown_account' });
    disconnectAccount(db, account.id, T0);
    expect(handleComment(deps, comment())).toEqual({ kind: 'ignored', reason: 'unknown_account' });
  });

  it('ignora comentário da própria conta (evita loop com as nossas respostas)', () => {
    const { deps, comment } = setup();
    expect(handleComment(deps, comment({ isSelf: true }))).toEqual({ kind: 'ignored', reason: 'self_comment' });
    expect(handleComment(deps, comment({ fromId: 'IG1' }))).toEqual({ kind: 'ignored', reason: 'self_comment' });
  });

  it('ignora post sem automação ativa e texto sem palavra-chave', () => {
    const { db, automation, deps, comment } = setup();
    expect(handleComment(deps, comment({ text: 'que lindo' }))).toEqual({ kind: 'ignored', reason: 'no_keyword' });
    expect(handleComment(deps, comment({ mediaId: 'M2' }))).toEqual({ kind: 'ignored', reason: 'no_automation' });
    setAutomationActive(db, automation.id, false, T0);
    expect(handleComment(deps, comment())).toEqual({ kind: 'ignored', reason: 'no_automation' });
  });

  it('no reconciler, ignora comentários anteriores à automação ou com mais de 7 dias', () => {
    const { deps, comment } = setup();
    expect(handleComment(deps, comment({ source: 'reconciler', createdAt: T0 - 1 }))).toEqual({
      kind: 'ignored',
      reason: 'before_automation',
    });
    const late = { ...deps, now: () => T0 + 8 * 86_400_000 };
    expect(handleComment(late, comment({ source: 'reconciler', createdAt: T0 + 1 }))).toEqual({ kind: 'ignored', reason: 'too_old' });
  });

  it('deduplica o mesmo comentário (reentrega do webhook)', () => {
    const { db, deps, comment } = setup();
    handleComment(deps, comment());
    expect(handleComment(deps, comment())).toEqual({ kind: 'ignored', reason: 'duplicate' });
    expect(jobs(db)).toHaveLength(2);
  });

  it('a mesma pessoa comentando de novo no post vira "skipped", sem novos jobs', () => {
    const { db, deps, comment } = setup();
    handleComment(deps, comment());
    expect(handleComment(deps, comment({ commentId: 'C2' }))).toMatchObject({ kind: 'skipped' });
    expect(jobs(db)).toHaveLength(2);
    const row = db.prepare("SELECT skip_reason AS r FROM interactions WHERE comment_id = 'C2'").get() as { r: string };
    expect(row.r).toBe('already_replied_to_person');
  });
});
