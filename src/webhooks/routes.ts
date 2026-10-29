import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { insertWebhookEvent } from '../db/repos/webhookEvents.js';
import { handleComment } from '../engine/matcher.js';
import { verifyHubSignature } from '../lib/crypto.js';
import { quoteLargeIds } from '../lib/json.js';
import { extractCommentEvents } from './parsePayload.js';

/** GET (verificação) e POST (eventos) em /webhooks/instagram — spec §6.1. */
export async function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Encapsulado neste plugin: o corpo JSON chega como Buffer bruto para validar a assinatura.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.get('/webhooks/instagram', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === deps.config.WEBHOOK_VERIFY_TOKEN) {
      return reply.type('text/plain').send(query['hub.challenge'] ?? '');
    }
    return reply.code(403).send('forbidden');
  });

  app.post('/webhooks/instagram', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const signature = request.headers['x-hub-signature-256'];
    // A assinatura é verificada sobre os bytes originais, antes de qualquer transformação do texto.
    if (!verifyHubSignature(raw, typeof signature === 'string' ? signature : undefined, deps.config.META_WEBHOOK_SECRETS)) {
      request.log.warn('webhook com assinatura inválida descartado');
      return reply.code(403).send('invalid signature');
    }

    let payload: unknown;
    try {
      // IDs numéricos acima de 2^53 viram string antes do parse para não perder dígitos.
      payload = JSON.parse(quoteLargeIds(raw.toString('utf8')));
    } catch {
      return reply.code(400).send('invalid json');
    }

    insertWebhookEvent(deps.db, raw.toString('utf8'), deps.now());
    for (const event of extractCommentEvents(payload)) {
      try {
        const outcome = handleComment(
          { db: deps.db, now: deps.now, random: deps.random },
          { ...event, source: 'webhook' },
        );
        request.log.info({ commentId: event.commentId, outcome }, 'comentário processado');
      } catch (error) {
        request.log.error({ err: error, commentId: event.commentId }, 'erro ao processar comentário');
      }
    }
    return reply.code(200).send('EVENT_RECEIVED');
  });
}
