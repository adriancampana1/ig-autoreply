import { describe, expect, it } from 'vitest';
import { createInstagramOAuth, REQUIRED_SCOPES } from '../src/instagram/oauth.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { createFakeFetch } from './helpers/fakeFetch.js';

const opts = { appId: 'APP', appSecret: 'SECRET', redirectUri: 'https://dm.example.com/auth/instagram/callback' };

describe('createInstagramOAuth', () => {
  it('monta a URL de autorização com as 3 permissões e o state', () => {
    const url = new URL(createInstagramOAuth(opts).authorizeUrl('STATE123'));
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('APP');
    expect(url.searchParams.get('redirect_uri')).toBe(opts.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(REQUIRED_SCOPES.join(','));
    expect(url.searchParams.get('state')).toBe('STATE123');
  });

  it('troca o code (removendo #_) e aceita resposta envolvida em data[]', async () => {
    const fake = createFakeFetch([
      { json: { data: [{ access_token: 'SHORT', user_id: '1', permissions: 'instagram_business_basic,instagram_business_manage_comments' }] } },
    ]);
    const oauth = createInstagramOAuth({ ...opts, fetch: fake.fetch });
    await expect(oauth.exchangeCode('ABC#_')).resolves.toEqual({
      accessToken: 'SHORT',
      permissions: ['instagram_business_basic', 'instagram_business_manage_comments'],
    });
    const sent = new URLSearchParams(fake.requests[0]!.body);
    expect(fake.requests[0]!.url.toString()).toBe('https://api.instagram.com/oauth/access_token');
    expect(sent.get('code')).toBe('ABC');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_secret')).toBe('SECRET');
  });

  it('aceita resposta plana e permissões em array', async () => {
    const fake = createFakeFetch([{ json: { access_token: 'S', permissions: ['a', 'b'] } }]);
    await expect(createInstagramOAuth({ ...opts, fetch: fake.fetch }).exchangeCode('X')).resolves.toEqual({
      accessToken: 'S',
      permissions: ['a', 'b'],
    });
  });

  it('troca por token longo e renova', async () => {
    const fake = createFakeFetch([
      { json: { access_token: 'LONG', token_type: 'bearer', expires_in: 5183944 } },
      { json: { access_token: 'LONG2', token_type: 'bearer', expires_in: 5184000 } },
    ]);
    const oauth = createInstagramOAuth({ ...opts, fetch: fake.fetch });
    await expect(oauth.exchangeForLongLived('SHORT')).resolves.toEqual({ accessToken: 'LONG', expiresInSec: 5183944 });
    await expect(oauth.refresh('LONG')).resolves.toEqual({ accessToken: 'LONG2', expiresInSec: 5184000 });
    expect(fake.requests[0]!.url.pathname).toBe('/access_token');
    expect(fake.requests[0]!.url.searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(fake.requests[1]!.url.pathname).toBe('/refresh_access_token');
    expect(fake.requests[1]!.url.searchParams.get('grant_type')).toBe('ig_refresh_token');
  });
});

describe('createInstagramOAuth: erros e respostas malformadas', () => {
  it('exchangeCode com 400 no formato do host OAuth → GraphApiError com mensagem e código da Meta', async () => {
    const fake = createFakeFetch([
      { status: 400, json: { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' } },
    ]);
    const oauth = createInstagramOAuth({ ...opts, fetch: fake.fetch });
    await expect(oauth.exchangeCode('BAD')).rejects.toMatchObject({
      name: 'GraphApiError',
      message: 'Invalid authorization code',
      code: 400,
      httpStatus: 400,
    });
  });

  it('exchangeCode sem access_token → GraphApiError', async () => {
    const fake = createFakeFetch([{ json: { user_id: '1' } }]);
    const error = await createInstagramOAuth({ ...opts, fetch: fake.fetch }).exchangeCode('X').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphApiError);
  });

  it('exchangeForLongLived e refresh sem access_token → GraphApiError', async () => {
    const fake = createFakeFetch([{ json: { expires_in: 5 } }, { json: { expires_in: 5 } }]);
    const oauth = createInstagramOAuth({ ...opts, fetch: fake.fetch });
    await expect(oauth.exchangeForLongLived('S')).rejects.toBeInstanceOf(GraphApiError);
    await expect(oauth.refresh('L')).rejects.toBeInstanceOf(GraphApiError);
  });

  it('user_id numérico acima de 2^53 na troca do code não quebra a resposta', async () => {
    const fetchRaw = (async () =>
      new Response('{"access_token":"SHORT","user_id":17841405793187219,"permissions":"instagram_business_basic"}', { status: 200 })) as typeof fetch;
    await expect(createInstagramOAuth({ ...opts, fetch: fetchRaw }).exchangeCode('ABC')).resolves.toEqual({
      accessToken: 'SHORT',
      permissions: ['instagram_business_basic'],
    });
  });
});
