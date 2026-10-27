import { describe, expect, it, vi } from 'vitest';
import { getAccountByIgId } from '../src/db/repos/accounts.js';
import { buildTestApp, cookieFrom, form, login } from './helpers/app.js';
import { seedAccount } from './helpers/db.js';

async function startConnect(t: Awaited<ReturnType<typeof buildTestApp>>) {
  const session = await login(t.app, t.db);
  const res = await t.app.inject({ url: '/contas/conectar', headers: { cookie: session.cookie } });
  const state = new URL(String(res.headers.location)).searchParams.get('state')!;
  return { cookie: cookieFrom(res) || session.cookie, state, csrf: session.csrf };
}

describe('contas', () => {
  it('conecta a conta: troca tokens, assina comments e salva token criptografado', async () => {
    const t = await buildTestApp();
    t.client.getProfile.mockResolvedValue({ igId: 'IG9', appUserId: 'APP9', username: 'Loja', accountType: 'Business' });
    const { cookie, state } = await startConnect(t);
    const res = await t.app.inject({ url: `/auth/instagram/callback?code=abc&state=${state}`, headers: { cookie } });
    expect(res.headers.location).toBe('/contas');
    expect(t.client.subscribeToComments).toHaveBeenCalledWith('LONG');
    const account = getAccountByIgId(t.db, 'IG9')!;
    expect(account.tokenEnc).not.toBe('LONG');
    expect(t.cipher.decrypt(account.tokenEnc!)).toBe('LONG');
    const page = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(res) || cookie } });
    expect(page.body).toContain('Conta @Loja conectada!');
    expect(page.body).toContain('válido até');
  });

  it('recusa state inválido, conta fora da allowlist e permissões faltando', async () => {
    const t = await buildTestApp({ oauth: { exchangeCode: async () => ({ accessToken: 'S', permissions: ['instagram_business_basic'] }) } });
    const { cookie, state } = await startConnect(t);
    const wrongState = await t.app.inject({ url: '/auth/instagram/callback?code=abc&state=outro', headers: { cookie } });
    const page1 = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(wrongState) || cookie } });
    expect(page1.body).toContain('Link de conexão expirado');

    const again = await startConnect(t);
    const missing = await t.app.inject({ url: `/auth/instagram/callback?code=abc&state=${again.state}`, headers: { cookie: again.cookie } });
    const page2 = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(missing) || again.cookie } });
    expect(page2.body).toContain('Faltou autorizar todas as permissões');
    expect(state).toBeTruthy();
  });

  it('recusa conta que não está na allowlist (exceto em REVIEW_MODE)', async () => {
    const t = await buildTestApp();
    t.client.getProfile.mockResolvedValue({ igId: 'IGX', appUserId: 'APPX', username: 'estranha', accountType: 'Business' });
    const { cookie, state } = await startConnect(t);
    const res = await t.app.inject({ url: `/auth/instagram/callback?code=abc&state=${state}`, headers: { cookie } });
    const page = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(res) || cookie } });
    expect(page.body).toContain('não está autorizada');
    expect(getAccountByIgId(t.db, 'IGX')).toBeUndefined();
  });

  it('desconectar via htmx responde HX-Redirect e apaga o token', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db);
    const session = await login(t.app, t.db);
    const res = await t.app.inject({
      method: 'POST', url: `/contas/${account.id}/desconectar`,
      headers: { cookie: session.cookie, 'hx-request': 'true', 'x-csrf-token': session.csrf, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({}),
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['hx-redirect']).toBe('/contas');
    expect(getAccountByIgId(t.db, 'IG1')).toMatchObject({ status: 'disconnected', tokenEnc: null });
  });

  it('proxy de miniatura só busca hosts do CDN do Instagram e usa placeholder nos demais casos', async () => {
    const images: string[] = [];
    const fetchImage = (async (url: string | URL | Request) => {
      images.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const t = await buildTestApp({ fetchImage });
    const account = seedAccount(t.db, { tokenEnc: '' });
    t.db.prepare('UPDATE ig_accounts SET token_enc = ? WHERE id = ?').run(t.cipher.encrypt('TOKEN'), account.id);
    const session = await login(t.app, t.db);
    t.client.getMedia.mockResolvedValueOnce({ id: '111', mediaType: 'IMAGE', permalink: 'p', timestamp: 't', mediaUrl: 'https://scontent.cdninstagram.com/a.jpg' });
    const ok = await t.app.inject({ url: `/midia/${account.id}/111`, headers: { cookie: session.cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    t.client.getMedia.mockResolvedValueOnce({ id: '222', mediaType: 'IMAGE', permalink: 'p', timestamp: 't', mediaUrl: 'https://evil.example.com/a.jpg' });
    const blocked = await t.app.inject({ url: `/midia/${account.id}/222`, headers: { cookie: session.cookie } });
    expect(blocked.headers['content-type']).toContain('image/svg+xml'); // placeholder, sem buscar o host desconhecido
    expect(images).toEqual(['https://scontent.cdninstagram.com/a.jpg']);
  });

  it('state errado ou ausente nunca troca o code por token', async () => {
    const exchangeCode = vi.fn();
    const t = await buildTestApp({ oauth: { exchangeCode } });
    const { cookie } = await startConnect(t);
    const wrong = await t.app.inject({ url: '/auth/instagram/callback?code=abc&state=falso', headers: { cookie } });
    expect(wrong.headers.location).toBe('/contas');
    const again = await startConnect(t);
    const missing = await t.app.inject({ url: '/auth/instagram/callback?code=abc', headers: { cookie: again.cookie } });
    expect(missing.headers.location).toBe('/contas');
    const page = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(missing) || again.cookie } });
    expect(page.body).toContain('Link de conexão expirado');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('usuária que cancela no Instagram vê mensagem amigável e nada é conectado', async () => {
    const exchangeCode = vi.fn();
    const t = await buildTestApp({ oauth: { exchangeCode } });
    const { cookie, state } = await startConnect(t);
    const res = await t.app.inject({ url: `/auth/instagram/callback?error=access_denied&state=${state}`, headers: { cookie } });
    expect(res.headers.location).toBe('/contas');
    const page = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(res) || cookie } });
    expect(page.body).toContain('Conexão cancelada no Instagram');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('miniatura: recusa http:, redirecionamento e imagens acima de 5 MB (placeholder)', async () => {
    const images: Array<{ url: string; redirect: unknown }> = [];
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const fetchImage = (async (url: string | URL | Request, init?: RequestInit) => {
      images.push({ url: String(url), redirect: init?.redirect });
      if (String(url).includes('declared')) {
        return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg', 'content-length': String(big.length) } });
      }
      return new Response(big, { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const t = await buildTestApp({ fetchImage });
    const account = seedAccount(t.db, { tokenEnc: '' });
    t.db.prepare('UPDATE ig_accounts SET token_enc = ? WHERE id = ?').run(t.cipher.encrypt('TOKEN'), account.id);
    const session = await login(t.app, t.db);
    const media = (id: string, mediaUrl: string) => ({ id, mediaType: 'IMAGE', permalink: 'p', timestamp: 't', mediaUrl });
    const get = (id: string) => t.app.inject({ url: `/midia/${account.id}/${id}`, headers: { cookie: session.cookie } });

    t.client.getMedia.mockResolvedValueOnce(media('301', 'http://scontent.cdninstagram.com/a.jpg'));
    expect((await get('301')).headers['content-type']).toContain('image/svg+xml');
    expect(images).toHaveLength(0); // http: nem chega a ser buscado

    t.client.getMedia.mockResolvedValueOnce(media('302', 'https://scontent.cdninstagram.com/declared.jpg'));
    expect((await get('302')).headers['content-type']).toContain('image/svg+xml');

    t.client.getMedia.mockResolvedValueOnce(media('303', 'https://scontent.cdninstagram.com/actual.jpg'));
    expect((await get('303')).headers['content-type']).toContain('image/svg+xml');

    expect(images.map((i) => i.redirect)).toEqual(['error', 'error']);
  });
});
