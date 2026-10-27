import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { listAccounts } from '../db/repos/accounts.js';
import { findUserById } from '../db/repos/users.js';
import { ensureCsrfToken, takeFlash, verifyCsrf } from '../http/session.js';
import { createThumbnailService } from '../media/thumbnails.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAuthRoutes } from './routes/auth.js';
import type { PanelContext } from './context.js';
import { alertBox } from './views/components.js';
import { layout } from './views/layout.js';
import { accountStatus } from './views/messages.js';

async function requireUser(request: FastifyRequest, reply: FastifyReply, deps: AppDeps): Promise<void> {
  const userId = request.session.get('userId');
  if (userId && findUserById(deps.db, userId)) return;
  if (userId) request.session.delete(); // usuário removido: evita laço entre /entrar e as telas
  if (request.headers['hx-request']) {
    await reply.header('HX-Redirect', '/entrar').code(401).send();
    return;
  }
  await reply.redirect('/entrar');
}

/** Painel: telas com login, CSRF em todo POST e layout comum (spec §8). */
export async function registerPanel(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: PanelContext = {
    ...deps,
    thumbnails: createThumbnailService({ client: deps.client, fetch: deps.fetchImage, now: deps.now }),
    render(request, reply, page) {
      const accounts = page.nav ? listAccounts(deps.db) : [];
      const now = deps.now();
      const alerts = accounts
        .filter((account) => account.status !== 'disconnected')
        .map((account) => ({ account, status: accountStatus(account, now) }))
        .filter(({ status }) => status.tone === 'danger' || status.tone === 'warning')
        .map(({ account, status }) => alertBox(status.tone === 'danger' ? 'danger' : 'warning', `@${account.username}: ${status.label}`, status.help));
      return reply
        .code(page.status ?? 200)
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(layout({ ...page, csrf: ensureCsrfToken(request), flash: takeFlash(request), alerts }));
    },
  };

  app.addHook('preHandler', verifyCsrf);

  await app.register(async (open) => {
    await registerAuthRoutes(open, ctx);
  });

  await app.register(async (protectedScope) => {
    protectedScope.addHook('preHandler', (request, reply) => requireUser(request, reply, deps));
    protectedScope.get('/', async (_request, reply) => reply.redirect('/automacoes'));
    await registerAccountRoutes(protectedScope, ctx);
  });
}
