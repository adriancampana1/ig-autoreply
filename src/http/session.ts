import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomToken } from '../lib/crypto.js';

export interface Flash {
  kind: 'success' | 'error';
  message: string;
}

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: number;
    csrf: string;
    oauthState: string;
    flash: Flash;
  }
}

export function ensureCsrfToken(request: FastifyRequest): string {
  let token = request.session.get('csrf');
  if (!token) {
    token = randomToken();
    request.session.set('csrf', token);
  }
  return token;
}

/** Hook de POST do painel: exige o token CSRF da sessão no campo `_csrf` ou no cabeçalho `x-csrf-token` (htmx). */
export async function verifyCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method !== 'POST') return;
  const expected = request.session.get('csrf');
  const body = (request.body ?? {}) as Record<string, unknown>;
  const received = (typeof body._csrf === 'string' ? body._csrf : undefined) ?? request.headers['x-csrf-token'];
  if (!expected || received !== expected) {
    await reply.code(403).type('text/plain; charset=utf-8').send('Sessão expirada. Recarregue a página e tente de novo.');
  }
}

export function setFlash(request: FastifyRequest, flash: Flash): void {
  request.session.set('flash', flash);
}

export function takeFlash(request: FastifyRequest): Flash | null {
  const flash = request.session.get('flash') ?? null;
  if (flash) request.session.set('flash', undefined);
  return flash;
}
