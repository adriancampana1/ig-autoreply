import { describe, expect, it } from 'vitest';
import { listActiveAutomations } from '../src/db/repos/automations.js';
import { readAutomationForm, validateAutomationForm } from '../src/panel/automationForm.js';
import { buildTestApp, form, login } from './helpers/app.js';
import { seedAccount, seedAutomation } from './helpers/db.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const validBody = (accountId: number, csrf: string) => ({
  _csrf: csrf,
  accountId: String(accountId),
  mediaId: '1790001',
  keywords: 'EU QUERO, link',
  variations: ['Oi {usuario}, te mandei no direct!', 'Enviado {usuario} 💌', 'Olha o direct {usuario}'],
  dmText: 'Aqui está: https://exemplo.com (mensagem automática)',
});

describe('validateAutomationForm', () => {
  it('exige palavra-chave, 3 variações distintas e DM ≤ 1000 bytes', () => {
    const result = validateAutomationForm({ accountId: 1, mediaId: '1', keywords: ' , ', variations: ['a', 'A', ''], dmText: 'ã'.repeat(501) });
    expect(result).toEqual({
      ok: false,
      errors: {
        keywords: 'Informe pelo menos uma palavra-chave.',
        variations: 'Escreva pelo menos 3 versões diferentes da resposta.',
        dmText: 'A mensagem do Direct está longa demais. Encurte um pouco.',
      },
    });
    const ok = validateAutomationForm({ accountId: 1, mediaId: '1', keywords: 'a, b', variations: ['x', 'y', 'z'], dmText: 'oi' });
    expect(ok).toMatchObject({ ok: true, data: { keywords: ['a', 'b'], publicVariations: ['x', 'y', 'z'] } });
  });

  it('normaliza quebras de linha CRLF e CR para LF nas variações e na DM', () => {
    const values = readAutomationForm({
      accountId: '1',
      mediaId: '1',
      keywords: 'a',
      variations: ['linha 1\r\nlinha 2', 'x\ry', 'z'],
      dmText: 'oi\r\ncomo vai\rtudo bem',
    });
    expect(values.variations).toEqual(['linha 1\nlinha 2', 'x\ny', 'z']);
    expect(values.dmText).toBe('oi\ncomo vai\ntudo bem');
    expect(validateAutomationForm(values)).toMatchObject({ ok: true, data: { dmText: 'oi\ncomo vai\ntudo bem' } });
  });
});

describe('automações (rotas)', () => {
  it('cria automação com dados do post confirmados na API', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db, { tokenEnc: t.cipher.encrypt('TOKEN') });
    const session = await login(t.app, t.db);
    t.client.getMedia.mockResolvedValue({ id: '1790001', mediaType: 'IMAGE', permalink: 'https://instagram.com/p/x', caption: 'Promo', timestamp: 't' });
    const res = await t.app.inject({ method: 'POST', url: '/automacoes', headers: { cookie: session.cookie, ...FORM }, payload: form(validBody(account.id, session.csrf)) });
    expect(res.statusCode).toBe(302);
    expect(t.client.getMedia).toHaveBeenCalledWith('TOKEN', '1790001');
    expect(listActiveAutomations(t.db)[0]).toMatchObject({ mediaId: '1790001', keywords: ['EU QUERO', 'link'], mediaCaption: 'Promo' });
  });

  it('grava só \\n quando o navegador envia CRLF na variação e na DM', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db, { tokenEnc: t.cipher.encrypt('TOKEN') });
    const session = await login(t.app, t.db);
    t.client.getMedia.mockResolvedValue({ id: '1790001', mediaType: 'IMAGE', permalink: 'p', timestamp: 't' });
    const body = {
      ...validBody(account.id, session.csrf),
      variations: ['Oi {usuario}\r\nte mandei!', 'Enviado {usuario}', 'Olha o direct {usuario}'],
      dmText: 'Linha 1\r\nLinha 2 (mensagem automática)',
    };
    const res = await t.app.inject({ method: 'POST', url: '/automacoes', headers: { cookie: session.cookie, ...FORM }, payload: form(body) });
    expect(res.statusCode).toBe(302);
    const saved = listActiveAutomations(t.db)[0]!;
    expect(saved.publicVariations[0]).toBe('Oi {usuario}\nte mandei!');
    expect(saved.dmText).toBe('Linha 1\nLinha 2 (mensagem automática)');
    expect(JSON.stringify(saved)).not.toContain('\\r');
  });

  it('mostra erros de validação (422) mantendo o que foi digitado', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db);
    const session = await login(t.app, t.db);
    const body = { ...validBody(account.id, session.csrf), variations: ['só uma'] };
    const res = await t.app.inject({ method: 'POST', url: '/automacoes', headers: { cookie: session.cookie, ...FORM }, payload: form(body) });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Escreva pelo menos 3 versões diferentes da resposta.');
    expect(res.body).toContain('só uma');
    // ganchos do /assets/app.js: contador de bytes, inserir {usuario} e prévia
    expect(res.body).toContain('data-max-bytes="1000"');
    expect(res.body).toContain('data-insert-token="{usuario}"');
    expect(res.body).toContain('data-reply-preview');
    // a prévia mostra quebras de linha como o renderReply do servidor
    expect(res.body).toMatch(/<p data-reply-preview[^>]*class="[^"]*whitespace-pre-line/);
  });

  it('impede segunda automação no mesmo post', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db, { tokenEnc: t.cipher.encrypt('TOKEN') });
    seedAutomation(t.db, account.id, { mediaId: '1790001' });
    const session = await login(t.app, t.db);
    t.client.getMedia.mockResolvedValue({ id: '1790001', mediaType: 'IMAGE', permalink: 'p', timestamp: 't' });
    const res = await t.app.inject({ method: 'POST', url: '/automacoes', headers: { cookie: session.cookie, ...FORM }, payload: form(validBody(account.id, session.csrf)) });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Este post já tem uma automação.');
  });

  it('pausar via htmx devolve o card atualizado', async () => {
    const t = await buildTestApp();
    const automation = seedAutomation(t.db, seedAccount(t.db).id);
    const session = await login(t.app, t.db);
    const res = await t.app.inject({
      method: 'POST', url: `/automacoes/${automation.id}/pausar`,
      headers: { cookie: session.cookie, 'hx-request': 'true', 'x-csrf-token': session.csrf, ...FORM }, payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('aria-checked="false"');
    expect(listActiveAutomations(t.db)).toHaveLength(0);
  });

  it('lista posts da conta marcando os que já têm automação', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db, { tokenEnc: t.cipher.encrypt('TOKEN') });
    seedAutomation(t.db, account.id, { mediaId: '1' });
    const session = await login(t.app, t.db);
    t.client.listMedia.mockResolvedValue([
      { id: '1', mediaType: 'IMAGE', permalink: 'p1', timestamp: 't' },
      { id: '2', mediaType: 'VIDEO', permalink: 'p2', timestamp: 't', thumbnailUrl: 'https://scontent.cdninstagram.com/t.jpg' },
    ]);
    const res = await t.app.inject({ url: `/automacoes/posts?accountId=${account.id}`, headers: { cookie: session.cookie, 'hx-request': 'true' } });
    expect(res.body).toContain('value="2"');
    expect(res.body).toContain('Já tem automação');
  });
});
