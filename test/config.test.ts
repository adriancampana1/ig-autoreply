import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

const baseEnv = {
  APP_BASE_URL: 'https://dm.adriancampana.cloud/',
  CONTACT_EMAIL: 'contato@adriancampana.cloud',
  IG_APP_ID: '123',
  IG_APP_SECRET: 'ig-secret',
  META_APP_SECRET: 'meta-secret',
  WEBHOOK_VERIFY_TOKEN: 'a-very-long-verify-token',
  ENCRYPTION_KEY: KEY,
  SESSION_SECRET: KEY,
};

describe('loadConfig', () => {
  it('aplica valores padrão e normaliza listas', () => {
    const config = loadConfig({ ...baseEnv, IG_ALLOWED_USERNAMES: ' @Loja.Um , loja_dois ,' });
    expect(config.APP_BASE_URL).toBe('https://dm.adriancampana.cloud');
    expect(config.GRAPH_API_VERSION).toBe('v26.0');
    expect(config.PORT).toBe(3000);
    expect(config.REVIEW_MODE).toBe(false);
    expect(config.MAX_ACTIONS_PER_HOUR).toBe(200);
    expect(config.IG_ALLOWED_USERNAMES).toEqual(['loja.um', 'loja_dois']);
  });

  it('usa os dois segredos para webhook quando META_WEBHOOK_SECRETS está vazio', () => {
    const config = loadConfig(baseEnv);
    expect(config.META_WEBHOOK_SECRETS).toEqual(['meta-secret', 'ig-secret']);
  });

  it('respeita META_WEBHOOK_SECRETS explícito sem alterar maiúsculas', () => {
    const config = loadConfig({ ...baseEnv, META_WEBHOOK_SECRETS: 'AbC' });
    expect(config.META_WEBHOOK_SECRETS).toEqual(['AbC']);
  });

  it('lança erro legível quando falta variável ou a chave tem tamanho errado', () => {
    expect(() => loadConfig({ ...baseEnv, IG_APP_ID: '' })).toThrow(/IG_APP_ID/);
    expect(() => loadConfig({ ...baseEnv, ENCRYPTION_KEY: 'curta' })).toThrow(/32 bytes/);
  });
});
