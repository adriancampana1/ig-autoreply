import { verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { findUserByEmail } from '../../db/repos/users.js';
import { ensureCsrfToken } from '../../http/session.js';
import { createLoginThrottle } from '../loginThrottle.js';
import type { PanelContext } from '../context.js';
import { loginPage } from '../views/loginPage.js';

export async function registerAuthRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  const throttle = createLoginThrottle({ max: 5, windowMs: 15 * 60_000, now: ctx.now });

  app.get('/entrar', async (request, reply) => {
    if (request.session.get('userId')) return reply.redirect('/automacoes');
    return ctx.render(request, reply, { title: 'Entrar', body: loginPage(ensureCsrfToken(request)) });
  });

  app.post('/entrar', async (request, reply) => {
    const { email = '', password = '' } = request.body as { email?: string; password?: string };
    const key = request.ip;
    if (throttle.isBlocked(key)) {
      return ctx.render(request, reply, {
        title: 'Entrar',
        status: 429,
        body: loginPage(ensureCsrfToken(request), 'Muitas tentativas. Aguarde 15 minutos e tente de novo.'),
      });
    }
    const user = findUserByEmail(ctx.db, email.trim());
    const ok = user ? await verify(user.passwordHash, password) : false;
    if (!user || !ok) {
      throttle.registerFailure(key);
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
