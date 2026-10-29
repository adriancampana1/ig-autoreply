import type { FastifyInstance } from 'fastify';
import { ConnectError, completeConnection } from '../../accounts/connect.js';
import { disconnectAccount, getAccountById, listAccounts } from '../../db/repos/accounts.js';
import { redirectAfterAction } from '../../http/redirect.js';
import { setFlash } from '../../http/session.js';
import { randomToken } from '../../lib/crypto.js';
import type { PanelContext } from '../context.js';
import { accountsPage } from '../views/accountsPage.js';

export const OAUTH_CALLBACK_PATH = '/auth/instagram/callback';

// Mostrado quando a miniatura não pode ser carregada (sem <img onerror>, que a CSP bloqueia).
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#857c88" fill-opacity=".12"/>' +
  '<path d="M30 62l12-14 9 10 7-8 8 12z" fill="#857c88" fill-opacity=".55"/><circle cx="38" cy="36" r="5" fill="#857c88" fill-opacity=".55"/></svg>';

export async function registerAccountRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  app.get('/contas', async (request, reply) =>
    ctx.render(request, reply, { title: 'Contas', nav: 'contas', body: accountsPage(listAccounts(ctx.db), ctx.now()) }),
  );

  app.get('/contas/conectar', async (request, reply) => {
    const state = randomToken();
    request.session.set('oauthState', state);
    return reply.redirect(ctx.oauth.authorizeUrl(state));
  });

  app.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const expected = request.session.get('oauthState');
    request.session.set('oauthState', undefined);
    if (query.error) {
      setFlash(request, { kind: 'error', message: 'Conexão cancelada no Instagram. Nenhuma alteração foi feita.' });
      return reply.redirect('/contas');
    }
    if (!query.code || !query.state || query.state !== expected) {
      setFlash(request, { kind: 'error', message: 'Link de conexão expirado. Tente conectar de novo.' });
      return reply.redirect('/contas');
    }
    try {
      const account = await completeConnection({ ...ctx, log: request.log }, query.code);
      setFlash(request, { kind: 'success', message: `Conta @${account.username} conectada!` });
    } catch (error) {
      request.log.warn({ err: error }, 'falha ao conectar conta');
      const message = error instanceof ConnectError ? error.message : 'Não foi possível conectar a conta agora. Tente de novo em alguns minutos.';
      setFlash(request, { kind: 'error', message });
    }
    return reply.redirect('/contas');
  });

  app.post('/contas/:id/desconectar', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const account = getAccountById(ctx.db, id);
    if (account) {
      disconnectAccount(ctx.db, id, ctx.now());
      setFlash(request, { kind: 'success', message: `Conta @${account.username} desconectada. As automações dela foram pausadas.` });
    }
    return redirectAfterAction(request, reply, '/contas');
  });

  app.get('/midia/:accountId/:mediaId', async (request, reply) => {
    const { accountId, mediaId } = request.params as { accountId: string; mediaId: string };
    const placeholder = () => reply.type('image/svg+xml').header('Cache-Control', 'private, max-age=300').send(PLACEHOLDER_SVG);
    const account = getAccountById(ctx.db, Number(accountId));
    if (!account?.tokenEnc || !/^\d+$/.test(mediaId)) return placeholder();
    try {
      const image = await ctx.thumbnails.fetchImage(ctx.cipher.decrypt(account.tokenEnc), mediaId);
      if (!image) return placeholder();
      return reply.type(image.contentType).header('Cache-Control', 'private, max-age=3600').send(Buffer.from(image.body));
    } catch (error) {
      request.log.warn({ err: error, mediaId }, 'falha ao carregar miniatura');
      return placeholder();
    }
  });
}
