import { GraphApiError } from './errors.js';
import { readGraphResponse, type FetchFn } from './client.js';

export const REQUIRED_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
] as const;

export interface OAuthOptions {
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetch?: FetchFn;
}

export interface ShortLivedToken {
  accessToken: string;
  /** Ausente quando a Meta não informa as permissões na resposta (a checagem de escopos é pulada). */
  permissions?: string[];
}

export interface LongLivedToken {
  accessToken: string;
  expiresInSec: number;
}

export interface InstagramOAuth {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<ShortLivedToken>;
  exchangeForLongLived(shortToken: string): Promise<LongLivedToken>;
  refresh(longToken: string): Promise<LongLivedToken>;
}

function toPermissions(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

/** Resposta de token sem access_token é malformada: erro de Graph API, não falha de rede. */
function toLongLived(raw: { access_token?: string; expires_in: number }, status: number): LongLivedToken {
  if (!raw.access_token) throw new GraphApiError('Resposta da Meta sem access_token', status);
  return { accessToken: raw.access_token, expiresInSec: raw.expires_in };
}

export function createInstagramOAuth(options: OAuthOptions): InstagramOAuth {
  const doFetch = options.fetch ?? fetch;

  return {
    authorizeUrl(state) {
      const url = new URL('https://www.instagram.com/oauth/authorize');
      url.searchParams.set('client_id', options.appId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', REQUIRED_SCOPES.join(','));
      url.searchParams.set('state', state);
      // Pede usuário/senha da conta certa (útil com várias contas) e esconde a opção "entrar com Facebook".
      url.searchParams.set('force_reauth', 'true');
      url.searchParams.set('enable_fb_login', 'false');
      return url.toString();
    },

    async exchangeCode(code) {
      const body = new URLSearchParams({
        client_id: options.appId,
        client_secret: options.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: options.redirectUri,
        code: code.replace(/#_$/, ''),
      });
      const response = await doFetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await readGraphResponse<
        { access_token?: string; permissions?: unknown; data?: Array<{ access_token: string; permissions?: unknown }> }
      >(response);
      const entry = raw.data?.[0] ?? raw;
      if (!entry.access_token) throw new GraphApiError('Resposta da Meta sem access_token', response.status);
      const permissions = toPermissions(entry.permissions);
      return permissions ? { accessToken: entry.access_token, permissions } : { accessToken: entry.access_token };
    },

    async exchangeForLongLived(shortToken) {
      const url = new URL('https://graph.instagram.com/access_token');
      url.searchParams.set('grant_type', 'ig_exchange_token');
      url.searchParams.set('client_secret', options.appSecret);
      url.searchParams.set('access_token', shortToken);
      const response = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
      const raw = await readGraphResponse<{ access_token?: string; expires_in: number }>(response);
      return toLongLived(raw, response.status);
    },

    async refresh(longToken) {
      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', longToken);
      const response = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
      const raw = await readGraphResponse<{ access_token?: string; expires_in: number }>(response);
      return toLongLived(raw, response.status);
    },
  };
}
