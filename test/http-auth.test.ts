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

  it('X-Forwarded-For forjado à esquerda não burla o limite (só a última entrada, do Nginx, vale)', async () => {
    const { app } = await buildTestApp();
    const page = await app.inject({ url: '/entrar' });
    const cookie = cookieFrom(page);
    const attempt = (spoofed: string) =>
      app.inject({
        method: 'POST', url: '/entrar',
        headers: { cookie, ...FORM, 'x-forwarded-for': `${spoofed}, 203.0.113.7` },
        payload: form({ _csrf: csrfFrom(page.body), email: 'x@y.com', password: 'errada' }),
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt(`10.0.0.${i}`)).statusCode).toBe(401);
    expect((await attempt('10.0.0.99')).statusCode).toBe(429);
  });

  it('lote paralelo de senhas erradas também é limitado', async () => {
    const { app } = await buildTestApp();
    const page = await app.inject({ url: '/entrar' });
    const cookie = cookieFrom(page);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({ method: 'POST', url: '/entrar', headers: { cookie, ...FORM }, payload: form({ _csrf: csrfFrom(page.body), email: 'x@y.com', password: 'errada' }) }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
  });

  it('login bem-sucedido zera as falhas anteriores', async () => {
    const { app, db } = await buildTestApp();
    await login(app, db); // cria o usuário
    const page = await app.inject({ url: '/entrar' });
    const cookie = cookieFrom(page);
    const post = (password: string) =>
      app.inject({ method: 'POST', url: '/entrar', headers: { cookie, ...FORM }, payload: form({ _csrf: csrfFrom(page.body), email: 'esposa@example.com', password }) });
    for (let i = 0; i < 4; i += 1) expect((await post('errada')).statusCode).toBe(401);
    expect((await post('senha-forte')).statusCode).toBe(302);
    for (let i = 0; i < 4; i += 1) expect((await post('errada')).statusCode).toBe(401);
  });

  it('sessão de usuário removido volta para /entrar sem laço de redirecionamento', async () => {
    const { app, db } = await buildTestApp();
    const session = await login(app, db);
    db.prepare('DELETE FROM users').run();
    const protectedRes = await app.inject({ url: '/contas', headers: { cookie: session.cookie } });
    expect(protectedRes.statusCode).toBe(302);
    expect(protectedRes.headers.location).toBe('/entrar');
    // mesmo reutilizando o cookie antigo, /entrar mostra o formulário em vez de redirecionar
    const entrar = await app.inject({ url: '/entrar', headers: { cookie: session.cookie } });
    expect(entrar.statusCode).toBe(200);
    expect(entrar.body).toContain('name="password"');
  });

  it('formulário de login malformado dá 401, não 500', async () => {
    const { app } = await buildTestApp();
    const page = await app.inject({ url: '/entrar' });
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(page.body);
    const arrays = await app.inject({ method: 'POST', url: '/entrar', headers: { cookie, ...FORM }, payload: form({ _csrf: csrf, email: ['a@b.com', 'c@d.com'], password: ['x', 'y'] }) });
    expect(arrays.statusCode).toBe(401);
    const missing = await app.inject({ method: 'POST', url: '/entrar', headers: { cookie, ...FORM }, payload: form({ _csrf: csrf }) });
    expect(missing.statusCode).toBe(401);
    expect(missing.body).toContain('E-mail ou senha incorretos.');
  });
});
