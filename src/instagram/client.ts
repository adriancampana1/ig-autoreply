import { GraphApiError } from './errors.js';
import { quoteLargeIds } from '../lib/json.js';

export type FetchFn = typeof fetch;

export interface InstagramProfile {
  /** ID da conta profissional — o mesmo `entry.id` dos webhooks. */
  igId: string;
  /** ID escopado do app (campo `id`), usado em signed_request. */
  appUserId: string;
  username: string;
  name?: string;
  profilePictureUrl?: string;
  accountType?: string;
}

export interface MediaItem {
  id: string;
  caption?: string;
  mediaType: string;
  mediaProductType?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink: string;
  timestamp: string;
}

export interface CommentItem {
  id: string;
  text: string;
  timestamp: string;
  fromId?: string;
  fromUsername?: string;
  hidden?: boolean;
}

export interface InstagramClient {
  getProfile(token: string): Promise<InstagramProfile>;
  listMedia(token: string, limit?: number): Promise<MediaItem[]>;
  getMedia(token: string, mediaId: string): Promise<MediaItem>;
  listComments(token: string, mediaId: string, after?: string): Promise<{ comments: CommentItem[]; nextCursor?: string }>;
  /** O comentário foi ocultado pela dona da conta? (conferido antes de responder em público) */
  isCommentHidden(token: string, commentId: string): Promise<boolean>;
  replyToComment(token: string, commentId: string, message: string): Promise<{ id: string }>;
  sendPrivateReply(token: string, igId: string, commentId: string, text: string): Promise<{ messageId: string }>;
  subscribeToComments(token: string): Promise<void>;
}

export interface InstagramClientOptions {
  version: string;
  fetch?: FetchFn;
  baseUrl?: string;
  timeoutMs?: number;
}

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp';

interface RawMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink: string;
  timestamp: string;
}

function toMedia(raw: RawMedia): MediaItem {
  return {
    id: raw.id,
    caption: raw.caption,
    mediaType: raw.media_type,
    mediaProductType: raw.media_product_type,
    mediaUrl: raw.media_url,
    thumbnailUrl: raw.thumbnail_url,
    permalink: raw.permalink,
    timestamp: raw.timestamp,
  };
}

function regainMinutes(header: string | null): number | undefined {
  if (!header) return undefined;
  try {
    const usage = JSON.parse(header) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
    const minutes = Object.values(usage)
      .flat()
      .map((entry) => entry.estimated_time_to_regain_access ?? 0);
    const max = Math.max(0, ...minutes);
    return max > 0 ? max : undefined;
  } catch {
    return undefined;
  }
}

interface ErrorBody {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
}

/** Formatos: Graph API `{ error: { message, code, error_subcode, type } }` e host OAuth `{ error_type, code, error_message }`. */
function extractError(body: Record<string, unknown>): ErrorBody | undefined {
  const graph = body.error as ErrorBody | undefined;
  if (graph) {
    return { message: graph.message, code: graph.code, error_subcode: graph.error_subcode, type: graph.type };
  }
  if (body.error_message !== undefined || body.error_type !== undefined) {
    return {
      message: body.error_message as string | undefined,
      code: body.code as number | undefined,
      type: body.error_type as string | undefined,
    };
  }
  return undefined;
}

export async function readGraphResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = {};
  let parsed = true;
  if (text) {
    try {
      body = JSON.parse(quoteLargeIds(text));
    } catch {
      parsed = false;
    }
  }
  const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
  const err = isObject ? extractError(body as Record<string, unknown>) : undefined;

  if (!response.ok || err) {
    const message = err?.message ?? (parsed ? undefined : text.slice(0, 200)) ?? `HTTP ${response.status}`;
    throw new GraphApiError(
      message,
      response.status,
      err?.code,
      err?.error_subcode,
      regainMinutes(response.headers.get('x-business-use-case-usage')),
      err?.type,
    );
  }
  if (!parsed || !isObject) {
    throw new GraphApiError(`Resposta inesperada da Meta (HTTP ${response.status})`, response.status);
  }
  return body as T;
}

export function createInstagramClient(options: InstagramClientOptions): InstagramClient {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.baseUrl ?? 'https://graph.instagram.com'}/${options.version}`;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string> = {},
    json?: unknown,
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return readGraphResponse<T>(response);
  }

  return {
    async getProfile(token) {
      const raw = await call<{
        id: string;
        user_id: string | number;
        username: string;
        name?: string;
        profile_picture_url?: string;
        account_type?: string;
      }>(token, 'GET', '/me', { fields: 'id,user_id,username,name,profile_picture_url,account_type' });
      return {
        igId: String(raw.user_id),
        appUserId: String(raw.id),
        username: raw.username,
        name: raw.name,
        profilePictureUrl: raw.profile_picture_url,
        accountType: raw.account_type,
      };
    },

    async listMedia(token, limit = 24) {
      const raw = await call<{ data: RawMedia[] }>(token, 'GET', '/me/media', {
        fields: MEDIA_FIELDS,
        limit: String(limit),
      });
      return raw.data.map(toMedia);
    },

    async getMedia(token, mediaId) {
      return toMedia(await call<RawMedia>(token, 'GET', `/${mediaId}`, { fields: MEDIA_FIELDS }));
    },

    async listComments(token, mediaId, after) {
      const raw = await call<{
        data: Array<{ id: string; text?: string; timestamp: string; hidden?: boolean; from?: { id: string; username?: string } }>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(token, 'GET', `/${mediaId}/comments`, {
        fields: 'id,text,timestamp,hidden,from{id,username}',
        limit: '50',
        ...(after ? { after } : {}),
      });
      return {
        comments: raw.data.map((c) => ({
          id: c.id,
          text: c.text ?? '',
          timestamp: c.timestamp,
          fromId: c.from?.id,
          fromUsername: c.from?.username,
          hidden: c.hidden,
        })),
        nextCursor: raw.paging?.next ? raw.paging.cursors?.after : undefined,
      };
    },

    async isCommentHidden(token, commentId) {
      const raw = await call<{ hidden?: boolean }>(token, 'GET', `/${commentId}`, { fields: 'hidden' });
      return raw.hidden === true;
    },

    async replyToComment(token, commentId, message) {
      return call<{ id: string }>(token, 'POST', `/${commentId}/replies`, {}, { message });
    },

    async sendPrivateReply(token, igId, commentId, text) {
      const raw = await call<{ message_id: string }>(token, 'POST', `/${igId}/messages`, {}, {
        recipient: { comment_id: commentId },
        message: { text },
      });
      return { messageId: raw.message_id };
    },

    async subscribeToComments(token) {
      await call<{ success: boolean }>(token, 'POST', '/me/subscribed_apps', { subscribed_fields: 'comments' });
    },
  };
}
