import { describe, expect, it } from 'vitest';
import { serializeRequest } from '../src/http/logSerializers.js';

const request = (url: string) => ({
  method: 'GET',
  url,
  headers: { cookie: 'sid=segredo', 'x-hub-signature-256': 'sha256=segredo' },
  ip: '203.0.113.7',
  socket: { remoteAddress: '10.0.0.2' },
});

describe('serializeRequest', () => {
  it('omite a query string do callback OAuth (code/state)', () => {
    const out = serializeRequest(request('/auth/instagram/callback?code=CODIGO&state=ESTADO'));
    expect(out).toEqual({ method: 'GET', url: '/auth/instagram/callback', remoteAddress: '203.0.113.7' });
    expect(JSON.stringify(out)).not.toMatch(/CODIGO|ESTADO/);
  });

  it('omite o verify token do webhook e não registra cabeçalhos', () => {
    const out = serializeRequest(request('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=TOKEN&hub.challenge=1'));
    expect(out.url).toBe('/webhooks/instagram');
    expect(JSON.stringify(out)).not.toMatch(/TOKEN|segredo/);
  });

  it('mantém caminhos sem query intactos e cai para o socket sem ip', () => {
    expect(serializeRequest({ method: 'POST', url: '/healthz', socket: { remoteAddress: '10.0.0.2' } })).toEqual({
      method: 'POST',
      url: '/healthz',
      remoteAddress: '10.0.0.2',
    });
  });
});
