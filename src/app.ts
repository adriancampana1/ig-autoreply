import { fileURLToPath } from 'node:url';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import secureSession from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/database.js';
import type { Health } from './engine/scheduler.js';
import type { FetchFn, InstagramClient } from './instagram/client.js';
import type { InstagramOAuth } from './instagram/oauth.js';
import type { TokenCipher } from './lib/crypto.js';
import { registerPanel } from './panel/register.js';
import { registerPublicRoutes } from './public/routes.js';
import { publicPage } from './public/views.js';
import { html } from './lib/html.js';
import { registerWebhookRoutes } from './webhooks/routes.js';

export interface AppDeps {
  config: Config;
  db: DB;
  client: InstagramClient;
  oauth: InstagramOAuth;
  cipher: TokenCipher;
  health: Health;
  now: () => number;
  random: () => number;
  /** fetch usado pelo proxy de miniaturas (injeção para testes). */
  fetchImage?: FetchFn;
  logger?: FastifyServerOptions['logger'];
}

const SESSION_DAYS = 30;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // A porta só é publicada em 127.0.0.1 na VPS: apenas o Nginx do host alcança o app. Confia em exatamente
    // 1 salto (só a conexão direta, hop 0): o Nginx acrescenta o IP real do cliente como última entrada do X-Forwarded-For, e entradas
    // anteriores (forjáveis pelo cliente) são ignoradas. (`true` confiaria na primeira, burlando o limite de login;
    // 'loopback' juntaria todos num só IP, pois dentro do container a conexão vem da ponte do Docker.)
    trustProxy: (_address, hop) => hop < 1,
    logger: deps.logger ?? false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'", 'https://www.instagram.com'],
        frameAncestors: ["'none'"],
      },
    },
    // O redirect do OAuth volta do instagram.com: o Referer padrão "no-referrer" não atrapalha, mas mantemos explícito.
    referrerPolicy: { policy: 'same-origin' },
  });
  await app.register(formbody);
  await app.register(secureSession, {
    key: Buffer.from(deps.config.SESSION_SECRET, 'base64'),
    cookieName: 'sid',
    expiry: SESSION_DAYS * 86_400,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.config.NODE_ENV === 'production',
      maxAge: SESSION_DAYS * 86_400,
    },
  });
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public/assets', import.meta.url)),
    prefix: '/assets/',
    maxAge: '7d',
  });

  // 404 próprio: a resposta padrão do Fastify ecoa a URL (com a query, ex.: ?code=) no corpo e no log.
  app.setNotFoundHandler((request, reply) => {
    request.log.info({ method: request.method, path: request.url.split('?')[0] }, 'rota não encontrada');
    reply.code(404);
    if (request.headers.accept?.includes('text/html')) {
      return reply
        .type('text/html; charset=utf-8')
        .send(publicPage('Página não encontrada', html`<h1>Página não encontrada</h1><p><a href="/automacoes" class="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">Voltar ao início</a></p>`));
    }
    return reply.send({ error: 'Not Found', statusCode: 404 });
  });

  await app.register(registerWebhookRoutes, deps);
  await app.register(registerPublicRoutes, deps);
  await app.register(registerPanel, deps);
  return app;
}
