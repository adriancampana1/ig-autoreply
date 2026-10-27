import { describe, expect, it } from 'vitest';
import { insertInteraction, refreshInteractionStatus } from '../src/db/repos/interactions.js';
import { cancelJob, enqueueJob } from '../src/db/repos/jobs.js';
import { buildTestApp, login } from './helpers/app.js';
import { seedAccount, seedAutomation, T0 } from './helpers/db.js';

describe('atividade (rota)', () => {
  it('mostra os motivos em português', async () => {
    const t = await buildTestApp();
    const automation = seedAutomation(t.db, seedAccount(t.db).id);
    insertInteraction(t.db, {
      automationId: automation.id, commentId: 'C1', commenterIgsid: 'U1', commenterUsername: 'ana', commentText: 'eu quero de novo',
      matchedKeyword: 'eu quero', source: 'webhook', status: 'skipped', skipReason: 'already_replied_to_person',
    }, T0);
    const session = await login(t.app, t.db);
    const res = await t.app.inject({ url: '/atividade', headers: { cookie: session.cookie } });
    expect(res.body).toContain('@ana');
    expect(res.body).toContain('Esta pessoa já recebeu resposta neste post');
  });

  it('filtra por situação e pagina', async () => {
    const t = await buildTestApp();
    const automation = seedAutomation(t.db, seedAccount(t.db).id);
    for (let i = 0; i < 25; i += 1) {
      insertInteraction(t.db, {
        automationId: automation.id, commentId: `C${i}`, commenterIgsid: `U${i}`, commenterUsername: `pessoa${i}`,
        commentText: 'eu quero', matchedKeyword: 'eu quero', source: 'webhook', status: 'skipped', skipReason: 'already_replied_to_person',
      }, T0 + i);
    }
    const session = await login(t.app, t.db);
    const first = await t.app.inject({ url: '/atividade?status=skipped', headers: { cookie: session.cookie } });
    expect(first.body).toContain('@pessoa24');
    expect(first.body).not.toContain('@pessoa4<');
    expect(first.body).toContain('Mais antigas');
    const second = await t.app.inject({ url: '/atividade?status=skipped&pagina=2', headers: { cookie: session.cookie } });
    expect(second.body).toContain('@pessoa4<');
    const none = await t.app.inject({ url: '/atividade?status=failed', headers: { cookie: session.cookie } });
    expect(none.body).toContain('Nada por aqui ainda');
  });

  it('explica jobs cancelados quando a interação terminou como falha', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db);
    const automation = seedAutomation(t.db, account.id);
    const interactionId = insertInteraction(t.db, {
      automationId: automation.id, commentId: 'C1', commenterIgsid: 'U1', commenterUsername: 'bia', commentText: 'eu quero',
      matchedKeyword: 'eu quero', source: 'webhook', status: 'queued',
    }, T0)!;
    enqueueJob(t.db, { interactionId, accountId: account.id, type: 'public_reply', runAt: T0 }, T0);
    enqueueJob(t.db, { interactionId, accountId: account.id, type: 'private_reply', runAt: T0 }, T0);
    const ids = t.db.prepare('SELECT id, type FROM jobs ORDER BY id').all() as Array<{ id: number; type: string }>;
    cancelJob(t.db, ids[0]!.id, 'account_disconnected', T0);
    cancelJob(t.db, ids[1]!.id, 'window_expired', T0);
    expect(refreshInteractionStatus(t.db, interactionId)).toBe('failed');
    const session = await login(t.app, t.db);
    const res = await t.app.inject({ url: '/atividade', headers: { cookie: session.cookie } });
    expect(res.body).toContain('A conta foi desconectada antes do envio');
    expect(res.body).toContain('Passou do prazo de 7 dias ou a pessoa já recebeu a mensagem');
    expect(res.body).toContain('Cancelada');
  });

  it('aceita valores inválidos de página sem erro', async () => {
    const t = await buildTestApp();
    seedAutomation(t.db, seedAccount(t.db).id);
    const session = await login(t.app, t.db);
    for (const pagina of ['1.5', 'Infinity', 'abc', '1e20', '-3', '0', '99999999999']) {
      const res = await t.app.inject({ url: `/atividade?pagina=${pagina}`, headers: { cookie: session.cookie } });
      expect(res.statusCode, pagina).toBe(200);
    }
  });

  it('filtra por conta e preserva os filtros nos links de paginação', async () => {
    const t = await buildTestApp();
    const loja = seedAccount(t.db);
    const outra = seedAccount(t.db, { igId: 'IG2', username: 'outraloja' });
    const autoLoja = seedAutomation(t.db, loja.id);
    const autoOutra = seedAutomation(t.db, outra.id);
    for (let i = 0; i < 21; i += 1) {
      insertInteraction(t.db, {
        automationId: autoOutra.id, commentId: `O${i}`, commenterIgsid: `UO${i}`, commenterUsername: `outra${i}`,
        commentText: 'eu quero', matchedKeyword: 'eu quero', source: 'webhook', status: 'skipped', skipReason: 'already_replied_to_person',
      }, T0 + i);
    }
    insertInteraction(t.db, {
      automationId: autoLoja.id, commentId: 'L1', commenterIgsid: 'UL1', commenterUsername: 'daloja',
      commentText: 'eu quero', matchedKeyword: 'eu quero', source: 'webhook', status: 'skipped', skipReason: 'already_replied_to_person',
    }, T0);
    const session = await login(t.app, t.db);
    const res = await t.app.inject({ url: `/atividade?conta=${outra.id}&status=skipped`, headers: { cookie: session.cookie } });
    expect(res.body).toContain('@outra20');
    expect(res.body).not.toContain('@daloja');
    expect(res.body).toMatch(new RegExp(`href="/atividade\\?conta=${outra.id}(&amp;|&)status=skipped(&amp;|&)pagina=2"`));
    const only = await t.app.inject({ url: `/atividade?conta=${loja.id}`, headers: { cookie: session.cookie } });
    expect(only.body).toContain('@daloja');
    expect(only.body).not.toContain('@outra20');
  });
});
