import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTokenCipher, parseSignedRequest, randomToken, verifyHubSignature } from '../src/lib/crypto.js';

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('createTokenCipher', () => {
  it('criptografa e descriptografa (ida e volta) com IV aleatório', () => {
    const cipher = createTokenCipher(KEY);
    const a = cipher.encrypt('IGQVJ-token');
    const b = cipher.encrypt('IGQVJ-token');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('IGQVJ-token');
  });

  it('rejeita texto adulterado', () => {
    const cipher = createTokenCipher(KEY);
    const data = Buffer.from(cipher.encrypt('segredo'), 'base64');
    data[data.length - 1] = data[data.length - 1]! ^ 0xff;
    expect(() => cipher.decrypt(data.toString('base64'))).toThrow();
  });
});

describe('verifyHubSignature', () => {
  const body = Buffer.from('{"object":"instagram","entry":[]}');
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('aceita assinatura feita com qualquer segredo da lista', () => {
    expect(verifyHubSignature(body, sign('s2'), ['s1', 's2'])).toBe(true);
  });

  it('rejeita assinatura inválida, ausente ou mal formatada', () => {
    expect(verifyHubSignature(body, sign('outro'), ['s1'])).toBe(false);
    expect(verifyHubSignature(body, undefined, ['s1'])).toBe(false);
    expect(verifyHubSignature(body, 'sha1=abc', ['s1'])).toBe(false);
    expect(verifyHubSignature(body, 'sha256=zz', ['s1'])).toBe(false);
  });
});

describe('parseSignedRequest', () => {
  const make = (payload: object, secret: string) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${sig}.${encoded}`;
  };

  it('decodifica um signed_request válido', () => {
    const req = make({ algorithm: 'HMAC-SHA256', user_id: 12345, issued_at: 1 }, 'app-secret');
    expect(parseSignedRequest(req, ['x', 'app-secret'])).toMatchObject({ user_id: '12345' });
  });

  it('retorna null com assinatura errada ou formato inválido', () => {
    expect(parseSignedRequest(make({ algorithm: 'HMAC-SHA256', user_id: 1 }, 'a'), ['b'])).toBeNull();
    expect(parseSignedRequest('sem-ponto', ['b'])).toBeNull();
  });
});

describe('randomToken', () => {
  it('gera valores url-safe distintos', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});
