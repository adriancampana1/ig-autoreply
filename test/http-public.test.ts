import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAccountById } from '../src/db/repos/accounts.js';
import { insertWebhookEvent } from '../src/db/repos/webhookEvents.js';
import { ASSET_VERSION } from '../src/http/assets.js';
import { serializeRequest } from '../src/http/logSerializers.js';
import { buildTestApp, form } from './helpers/app.js';
import { seedAccount, seedAutomation, T0 } from './helpers/db.js';

const signedRequest = (userId: string, secret = 'ig-secret') => {
  const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: userId, issued_at: 1 })).toString('base64url');
  return `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
};

describe('rotas públicas', () => {
  it('/healthz: 200 com worker recente, 503 se o worker parou', async () => {
    const t = await buildTestApp();
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    t.now.value = T0 + 120_000;
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(503);
  });

  it('/privacidade é pública, em português e inglês, com cabeçalhos de segurança', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ url: '/privacidade' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Política de Privacidade');
    expect(res.body).toContain('Privacy Policy');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('/privacidade descreve com verdade a remoção do app, a exclusão e as notificações brutas', async () => {
    const { app } = await buildTestApp();
    const body = (await app.inject({ url: '/privacidade' })).body;
    expect(body).toContain('o acesso é revogado na hora e nenhuma resposta é mais enviada');
    expect(body).toContain('podem incluir comentários feitos em qualquer post da conta conectada');
    expect(body).toContain('pedido de exclusão de dados');
    expect(body).toContain('após 90 dias');
    expect(body).toContain('após 30 dias');
    expect(body).not.toContain('o que dispara a exclusão automática dos dados');
  });

  it('CSS/JS saem com ?v=<versão> (cache-busting) no painel e nas páginas públicas', async () => {
    const { app } = await buildTestApp();
    expect(ASSET_VERSION).toMatch(/^[0-9a-z.-]{6,}$/);
    const privacy = (await app.inject({ url: '/privacidade' })).body;
    expect(privacy).toContain(`href="/assets/app.css?v=${ASSET_VERSION}"`);
    const login = (await app.inject({ url: '/entrar' })).body;
    expect(login).toContain(`href="/assets/app.css?v=${ASSET_VERSION}"`);
    expect(login).toContain(`src="/assets/htmx.min.js?v=${ASSET_VERSION}"`);
    expect(login).toContain(`src="/assets/app.js?v=${ASSET_VERSION}"`);
    expect((await app.inject({ url: `/assets/app.js?v=${ASSET_VERSION}` })).statusCode).toBe(200);
  });

  it('404 não ecoa a URL na resposta nem a query string no log', async () => {
    const lines: string[] = [];
    const stream = { write: (line: string) => { lines.push(line); } };
    const { app } = await buildTestApp({ logger: { level: 'info', stream, serializers: { req: serializeRequest } } });
    const json = await app.inject({ url: '/nao-existe?code=SEGREDO' });
    expect(json.statusCode).toBe(404);
    expect(json.body).not.toContain('nao-existe');
    expect(json.body).not.toContain('SEGREDO');
    expect(json.json()).toEqual({ error: 'Not Found', statusCode: 404 });
    const page = await app.inject({ url: '/outra?code=SEGREDO', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(404);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Página não encontrada');
    expect(page.body).not.toContain('SEGREDO');
    expect((await app.inject({ url: '/assets/nao-existe.js?code=SEGREDO' })).statusCode).toBe(404);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain('SEGREDO');
  });

  it('/meta/deauthorize desconecta a conta do signed_request válido', async () => {
    const { app, db } = await buildTestApp();
    const account = seedAccount(db);
    seedAutomation(db, account.id);
    const bad = await app.inject({
      method: 'POST', url: '/meta/deauthorize', payload: form({ signed_request: signedRequest('APP-IG1', 'x') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({
      method: 'POST', url: '/meta/deauthorize', payload: form({ signed_request: signedRequest('APP-IG1') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(getAccountById(db, account.id)).toMatchObject({ status: 'disconnected', tokenEnc: null });
  });

  it('/meta/data-deletion apaga a conta (e as notificações brutas dela) e devolve url + confirmation_code consultável', async () => {
    const { app, db } = await buildTestApp();
    const account = seedAccount(db);
    seedAccount(db, { igId: 'IG2' });
    const ownEvent = JSON.stringify({ object: 'instagram', entry: [{ id: 'IG1', changes: [{ field: 'comments', value: { text: 'oi' } }] }] });
    const otherEvent = JSON.stringify({ object: 'instagram', entry: [{ id: 'IG2', changes: [{ field: 'comments', value: { text: 'oi' } }] }] });
    insertWebhookEvent(db, ownEvent, T0);
    insertWebhookEvent(db, otherEvent, T0);
    insertWebhookEvent(db, ownEvent, T0 + 1);
    const res = await app.inject({
      method: 'POST', url: '/meta/data-deletion', payload: form({ signed_request: signedRequest('IG1', 'meta-secret') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const body = res.json() as { url: string; confirmation_code: string };
    expect(body.url).toBe(`https://dm.example.com/meta/data-deletion/status?code=${body.confirmation_code}`);
    expect(getAccountById(db, account.id)).toBeUndefined();
    expect(db.prepare('SELECT payload_json AS p FROM webhook_events ORDER BY id').all()).toEqual([{ p: otherEvent }]);
    const status = await app.inject({ url: `/meta/data-deletion/status?code=${body.confirmation_code}` });
    expect(status.statusCode).toBe(200);
    expect(status.body).toContain('Exclusão concluída');
  });
});
