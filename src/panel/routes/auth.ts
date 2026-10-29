import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { findUserByEmail, findUserById } from '../../db/repos/users.js';
import { ensureCsrfToken } from '../../http/session.js';
import { createLoginThrottle } from '../loginThrottle.js';
import type { PanelContext } from '../context.js';
import { loginPage } from '../views/loginPage.js';

export async function registerAuthRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  const throttle = createLoginThrottle({ max: 5, windowMs: 15 * 60_000, now: ctx.now });
  // Hash fixo para gastar o mesmo tempo de argon2 quando o e-mail não existe (evita enumerar usuários pelo tempo).
  const dummyHash = await hash('senha-inexistente');

  app.get('/entrar', async (request, reply) => {
    const userId = request.session.get('userId');
    if (userId && findUserById(ctx.db, userId)) return reply.redirect('/automacoes');
    if (userId) request.session.set('userId', undefined); // sessão de usuário que não existe mais
    return ctx.render(request, reply, { title: 'Entrar', body: loginPage(ensureCsrfToken(request)) });
  });

  app.post('/entrar', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: unknown; password?: unknown };
    const key = request.ip;
    if (throttle.isBlocked(key)) {
      return ctx.render(request, reply, {
        title: 'Entrar',
        status: 429,
        body: loginPage(ensureCsrfToken(request), 'Muitas tentativas. Aguarde 15 minutos e tente de novo.'),
      });
    }
    // Conta toda tentativa ANTES do argon2 (assíncrono): senão um lote paralelo passaria pelo limite.
    throttle.registerFailure(key);
    const credentials = typeof email === 'string' && typeof password === 'string' ? { email, password } : null;
    const user = credentials ? findUserByEmail(ctx.db, credentials.email.trim()) : undefined;
    const ok = credentials ? await verify(user?.passwordHash ?? dummyHash, credentials.password).catch(() => false) : false;
    if (!user || !ok) {
      return ctx.render(request, reply, {
        title: 'Entrar',
        status: 401,
        body: loginPage(ensureCsrfToken(request), 'E-mail ou senha incorretos.'),
      });
    }
    throttle.reset(key);
    request.session.regenerate();
    request.session.set('userId', user.id);
    return reply.redirect('/automacoes');
  });

  app.post('/sair', async (request, reply) => {
    request.session.delete();
    return reply.redirect('/entrar');
  });
}
