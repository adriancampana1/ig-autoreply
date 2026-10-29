import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seedAccount, seedAutomation } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';

const payload = JSON.stringify({
  object: 'instagram',
  entry: [{ id: 'IG1', time: 1, changes: [{ field: 'comments', value: { id: 'C1', from: { id: 'U1', username: 'ana' }, text: 'Eu quero!', media: { id: 'M1' } } }] }],
});
const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('/webhooks/instagram', () => {
  it('GET responde o hub.challenge com o verify token certo e 403 caso contrário', async () => {
    const { app } = await buildTestApp();
    const ok = await app.inject({ url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-token-1234567890&hub.challenge=1158201444' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    const bad = await app.inject({ url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('POST com assinatura inválida é rejeitado e nada é gravado', async () => {
    const { app, db } = await buildTestApp();
    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram', payload,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload, 'outro') },
    });
    expect(res.statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get()).toEqual({ n: 0 });
  });

  it('POST válido grava o evento, cria a interação e responde 200; reentrega não duplica', async () => {
    const { app, db } = await buildTestApp();
    seedAutomation(db, seedAccount(db).id);
    for (const secret of ['ig-secret', 'meta-secret']) {
      const res = await app.inject({
        method: 'POST', url: '/webhooks/instagram', payload,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload, secret) },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM interactions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 });
  });

  it('IDs numéricos acima de 2^53 no JSON bruto chegam como string exata (assinatura sobre os bytes originais)', async () => {
    const { app, db } = await buildTestApp();
    seedAutomation(db, seedAccount(db, { igId: '17841405793187219' }).id);
    // Escrito à mão: JSON.stringify não produz inteiros imprecisos como a Meta envia.
    const raw =
      '{"object":"instagram","entry":[{"id":17841405793187219,"time":1,"changes":[{"field":"comments","value":' +
      '{"id":18012345678901234567,"from":{"id":17841405793187221,"username":"ana"},"text":"Eu quero!","media":{"id":"M1"}}}]}]}';
    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, 'ig-secret') },
    });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT comment_id, commenter_igsid FROM interactions').get()).toEqual({
      comment_id: '18012345678901234567',
      commenter_igsid: '17841405793187221',
    });
    expect(db.prepare('SELECT payload_json FROM webhook_events').get()).toEqual({ payload_json: raw });
  });
});
