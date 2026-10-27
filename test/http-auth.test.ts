import { describe, expect, it } from 'vitest';
import { buildTestApp, cookieFrom, csrfFrom, form, login } from './helpers/app.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('login do painel', () => {
  it('redireciona para /entrar sem sessão', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ url: '/contas' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/entrar');
  });

  it('login correto dá acesso; sair encerra a sessão', async () => {
    const { app, db } = await buildTestApp();
    const session = await login(app, db);
    const page = await app.inject({ url: '/contas', headers: { cookie: session.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Conectar conta do Instagram');
    const out = await app.inject({ method: 'POST', url: '/sair', headers: { cookie: session.cookie, ...FORM }, payload: form({ _csrf: session.csrf }) });
    expect(out.headers.location).toBe('/entrar');
    const after = await app.inject({ url: '/contas', headers: { cookie: cookieFrom(out) } });
    expect(after.statusCode).toBe(302);
  });

  it('POST sem CSRF é recusado com 403', async () => {
    const { app, db } = await buildTestApp();
    const session = await login(app, db);
    const res = await app.inject({ method: 'POST', url: '/sair', headers: { cookie: session.cookie, ...FORM }, payload: '' });
    expect(res.statusCode).toBe(403);
  });

  it('senha errada mostra erro e bloqueia após 5 falhas', async () => {
    const { app } = await buildTestApp();
    const page = await app.inject({ url: '/entrar' });
    const cookie = cookieFrom(page);
    const attempt = () =>
      app.inject({ method: 'POST', url: '/entrar', headers: { cookie, ...FORM }, payload: form({ _csrf: csrfFrom(page.body), email: 'x@y.com', password: 'errada' }) });
    for (let i = 0; i < 5; i += 1) {
      const res = await attempt();
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('E-mail ou senha incorretos.');
    }
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain('Muitas tentativas');
  });
});
