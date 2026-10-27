import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAccountById } from '../src/db/repos/accounts.js';
import { buildTestApp, form } from './helpers/app.js';
import { seedAccount, seedAutomation, T0 } from './helpers/db.js';

const signedRequest = (userId: string, secret = 'ig-secret') => {
  const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: userId, issued_at: 1 })).toString('base64url');
  return `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
};

describe('rotas públicas', () => {
  it('/healthz: 200 com worker recente, 503 se o worker parou', async () => {
    const t = await buildTestApp();
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    t.now.value = T0 + 120_000;
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(503);
  });

  it('/privacidade é pública, em português e inglês, com cabeçalhos de segurança', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ url: '/privacidade' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Política de Privacidade');
    expect(res.body).toContain('Privacy Policy');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('/meta/deauthorize desconecta a conta do signed_request válido', async () => {
    const { app, db } = await buildTestApp();
    const account = seedAccount(db);
    seedAutomation(db, account.id);
    const bad = await app.inject({
      method: 'POST', url: '/meta/deauthorize', payload: form({ signed_request: signedRequest('APP-IG1', 'x') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({
      method: 'POST', url: '/meta/deauthorize', payload: form({ signed_request: signedRequest('APP-IG1') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(getAccountById(db, account.id)).toMatchObject({ status: 'disconnected', tokenEnc: null });
  });

  it('/meta/data-deletion apaga a conta e devolve url + confirmation_code consultável', async () => {
    const { app, db } = await buildTestApp();
    const account = seedAccount(db);
    const res = await app.inject({
      method: 'POST', url: '/meta/data-deletion', payload: form({ signed_request: signedRequest('IG1', 'meta-secret') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const body = res.json() as { url: string; confirmation_code: string };
    expect(body.url).toBe(`https://dm.example.com/meta/data-deletion/status?code=${body.confirmation_code}`);
    expect(getAccountById(db, account.id)).toBeUndefined();
    const status = await app.inject({ url: `/meta/data-deletion/status?code=${body.confirmation_code}` });
    expect(status.statusCode).toBe(200);
    expect(status.body).toContain('Exclusão concluída');
  });
});
