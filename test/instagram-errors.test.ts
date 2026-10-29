import { describe, expect, it } from 'vitest';
import { classifyError, GraphApiError } from '../src/instagram/errors.js';

const err = (code: number | undefined, message = 'x', status = 400, subcode?: number, regain?: number) =>
  new GraphApiError(message, status, code, subcode, regain);

describe('classifyError', () => {
  it('token inválido → auth', () => {
    expect(classifyError(err(190))).toMatchObject({ kind: 'auth', reason: 'token_invalid', code: '190' });
  });

  it('limites de chamada → rate_limit com espera da Meta ou 15 min', () => {
    expect(classifyError(err(80002, 'x', 400, undefined, 7))).toMatchObject({ kind: 'rate_limit', retryAfterMs: 7 * 60_000 });
    for (const code of [4, 17, 32, 613]) {
      expect(classifyError(err(code))).toMatchObject({ kind: 'rate_limit', retryAfterMs: 15 * 60_000 });
    }
  });

  it('bloqueio por abuso → abuse', () => {
    expect(classifyError(err(368))).toMatchObject({ kind: 'abuse', reason: 'abuse_blocked' });
    expect(classifyError(err(undefined, 'You are temporarily blocked'))).toMatchObject({ kind: 'abuse' });
  });

  it('DMs desativadas na conta → messaging_disabled', () => {
    const e = err(200, '(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.', 403);
    expect(classifyError(e)).toMatchObject({ kind: 'messaging_disabled' });
  });

  it('erros permanentes', () => {
    expect(classifyError(err(10, 'x', 400, 2534022))).toMatchObject({ kind: 'permanent', reason: 'window_expired' });
    expect(classifyError(err(100))).toMatchObject({ kind: 'permanent', reason: 'comment_unavailable' });
    expect(classifyError(err(10))).toMatchObject({ kind: 'permanent', reason: 'permission_denied' });
  });

  it('5xx e falhas de rede → transient com 5 tentativas; desconhecido → 2 tentativas', () => {
    expect(classifyError(err(undefined, 'x', 503))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
    expect(classifyError(new TypeError('fetch failed'))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
    expect(classifyError(err(99999))).toMatchObject({ kind: 'transient', reason: 'unknown_error', maxAttempts: 2 });
  });
});

describe('classifyError: falhas que não são GraphApiError', () => {
  it('timeout/abort e falhas de rede conhecidas → transient com 5 tentativas', () => {
    expect(classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
    expect(classifyError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
    expect(classifyError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
    expect(classifyError(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
  });

  it('outros erros não-Graph → unknown_error com 2 tentativas', () => {
    expect(classifyError(new TypeError("Cannot read properties of undefined"))).toMatchObject({ kind: 'transient', reason: 'unknown_error', maxAttempts: 2 });
    expect(classifyError(new Error('bug interno'))).toMatchObject({ kind: 'transient', reason: 'unknown_error', maxAttempts: 2 });
    expect(classifyError('boom')).toMatchObject({ kind: 'transient', reason: 'unknown_error', maxAttempts: 2 });
  });
});

describe('classifyError: bloqueio por abuso', () => {
  it('"You have been blocked from ..." → abuse', () => {
    expect(classifyError(err(undefined, 'You have been blocked from commenting on this media'))).toMatchObject({ kind: 'abuse' });
  });
});
