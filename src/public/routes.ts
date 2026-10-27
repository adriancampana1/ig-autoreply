import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { deleteAccount, disconnectAccount, findAccountsByAnyUserId } from '../db/repos/accounts.js';
import { findDeletionRequest, insertDeletionRequest } from '../db/repos/deletionRequests.js';
import { deleteWebhookEventsMentioning } from '../db/repos/webhookEvents.js';
import { html } from '../lib/html.js';
import { parseSignedRequest, randomToken } from '../lib/crypto.js';
import { privacyPolicy, publicPage } from './views.js';

const HEALTH_MAX_WORKER_SILENCE_MS = 60_000;

/** Rotas públicas exigidas pela Meta (spec §12) + healthcheck. */
export async function registerPublicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const secrets = [deps.config.IG_APP_SECRET, deps.config.META_APP_SECRET];

  app.get('/healthz', async (_request, reply) => {
    deps.db.prepare('SELECT 1').get();
    const last = deps.health.lastWorkerTickAt;
    const workerOk = last !== null && deps.now() - last < HEALTH_MAX_WORKER_SILENCE_MS;
    return reply.code(workerOk ? 200 : 503).send({ status: workerOk ? 'ok' : 'worker_stalled' });
  });

  app.get('/privacidade', async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(publicPage('Política de Privacidade', privacyPolicy({ contactEmail: deps.config.CONTACT_EMAIL, updatedAt: '27/10/2026' }))),
  );

  app.post('/meta/deauthorize', async (request, reply) => {
    const payload = parseSignedRequest(String((request.body as { signed_request?: string })?.signed_request ?? ''), secrets);
    if (!payload) return reply.code(400).send({ error: 'invalid signed_request' });
    for (const account of findAccountsByAnyUserId(deps.db, payload.user_id)) disconnectAccount(deps.db, account.id, deps.now());
    return reply.send({ success: true });
  });

  app.post('/meta/data-deletion', async (request, reply) => {
    const payload = parseSignedRequest(String((request.body as { signed_request?: string })?.signed_request ?? ''), secrets);
    if (!payload) return reply.code(400).send({ error: 'invalid signed_request' });
    const code = randomToken(12);
    deps.db.transaction(() => {
      for (const account of findAccountsByAnyUserId(deps.db, payload.user_id)) {
        deleteAccount(deps.db, account.id);
        deleteWebhookEventsMentioning(deps.db, account.igId);
      }
      insertDeletionRequest(deps.db, code, payload.user_id, deps.now());
    })();
    return reply.send({ url: `${deps.config.APP_BASE_URL}/meta/data-deletion/status?code=${code}`, confirmation_code: code });
  });

  app.get('/meta/data-deletion/status', async (request, reply) => {
    const code = String((request.query as { code?: string }).code ?? '');
    const found = code ? findDeletionRequest(deps.db, code) : undefined;
    const body = found
      ? html`<h1>Exclusão concluída</h1><p>Solicitação <code>${found.code}</code>: os dados da conta foram excluídos em
          ${new Date(found.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.</p>`
      : html`<h1>Solicitação não encontrada</h1><p>Verifique o código informado.</p>`;
    return reply.code(found ? 200 : 404).type('text/html; charset=utf-8').send(publicPage('Exclusão de dados', body));
  });
}
