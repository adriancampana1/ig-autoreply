import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createUser, findUserByEmail } from '../../src/db/repos/users.js';
import type { InstagramOAuth } from '../../src/instagram/oauth.js';
import { createTokenCipher } from '../../src/lib/crypto.js';
import { makeDb, T0 } from './db.js';
import { createFakeInstagram } from './fakeInstagram.js';

const KEY = Buffer.alloc(32, 9).toString('base64');

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://dm.example.com',
    CONTACT_EMAIL: 'contato@example.com',
    IG_APP_ID: 'IGAPP',
    IG_APP_SECRET: 'ig-secret',
    META_APP_SECRET: 'meta-secret',
    WEBHOOK_VERIFY_TOKEN: 'verify-token-1234567890',
    ENCRYPTION_KEY: KEY,
    SESSION_SECRET: KEY,
    IG_ALLOWED_USERNAMES: 'loja',
    ...overrides,
  });
}

export function fakeOAuth(overrides: Partial<InstagramOAuth> = {}): InstagramOAuth {
  return {
    authorizeUrl: (state) => `https://www.instagram.com/oauth/authorize?state=${state}`,
    exchangeCode: async () => ({
      accessToken: 'SHORT',
      permissions: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages'],
    }),
    exchangeForLongLived: async () => ({ accessToken: 'LONG', expiresInSec: 60 * 86_400 }),
    refresh: async () => ({ accessToken: 'LONG2', expiresInSec: 60 * 86_400 }),
    ...overrides,
  };
}

export async function buildTestApp(options: { config?: Record<string, string>; oauth?: Partial<InstagramOAuth>; fetchImage?: typeof fetch } = {}) {
  const db = makeDb();
  const client = createFakeInstagram();
  const config = testConfig(options.config);
  const cipher = createTokenCipher(config.ENCRYPTION_KEY);
  const now = { value: T0 };
  const app = await buildApp({
    config,
    db,
    client,
    oauth: fakeOAuth(options.oauth),
    cipher,
    health: { lastWorkerTickAt: T0 },
    now: () => now.value,
    random: () => 0,
    fetchImage: options.fetchImage,
  });
  return { app, db, client, cipher, config, now };
}

export function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(first ?? '').split(';')[0] ?? '';
}

export function csrfFrom(body: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(body) ?? /"x-csrf-token": "([^"]+)"/.exec(body);
  if (!match?.[1]) throw new Error('CSRF não encontrado na página');
  return match[1];
}

/** Cria o usuário, faz login e devolve cookie + CSRF prontos para as próximas requisições. */
export async function login(app: FastifyInstance, db: ReturnType<typeof makeDb>): Promise<{ cookie: string; csrf: string }> {
  if (!findUserByEmail(db, 'esposa@example.com')) createUser(db, 'esposa@example.com', await hash('senha-forte'), T0);
  const page = await app.inject({ method: 'GET', url: '/entrar' });
  const res = await app.inject({
    method: 'POST',
    url: '/entrar',
    headers: { cookie: cookieFrom(page), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ _csrf: csrfFrom(page.body), email: 'esposa@example.com', password: 'senha-forte' }).toString(),
  });
  if (res.statusCode !== 302) throw new Error(`login falhou: ${res.statusCode}`);
  const cookie = cookieFrom(res);
  const home = await app.inject({ method: 'GET', url: '/contas', headers: { cookie } });
  return { cookie: cookieFrom(home) || cookie, csrf: csrfFrom(home.body) };
}

export const form = (data: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) for (const v of [value].flat()) params.append(key, v);
  return params.toString();
};
