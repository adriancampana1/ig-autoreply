import type { FetchFn, InstagramClient, MediaItem } from '../instagram/client.js';

const ALLOWED_HOSTS = [/\.cdninstagram\.com$/, /\.fbcdn\.net$/];
const URL_TTL_MS = 60 * 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Busca a miniatura de um post no servidor e a devolve ao navegador, evitando bloqueios de
 * Cross-Origin-Resource-Policy do CDN e mantendo a CSP do painel em img-src 'self'.
 */
export function createThumbnailService(deps: { client: InstagramClient; fetch?: FetchFn; now: () => number }) {
  const doFetch = deps.fetch ?? fetch;
  const urls = new Map<string, { url: string; at: number }>();

  const imageUrl = (media: MediaItem) => media.thumbnailUrl ?? media.mediaUrl;

  return {
    /** Guarda as URLs já obtidas numa listagem (evita uma chamada à API por miniatura). */
    remember(media: MediaItem[]): void {
      for (const item of media) {
        const url = imageUrl(item);
        if (url) urls.set(item.id, { url, at: deps.now() });
      }
    },

    async fetchImage(token: string, mediaId: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
      let cached = urls.get(mediaId);
      if (!cached || deps.now() - cached.at > URL_TTL_MS) {
        const url = imageUrl(await deps.client.getMedia(token, mediaId));
        if (!url) return null;
        cached = { url, at: deps.now() };
        urls.set(mediaId, cached);
      }
      const target = new URL(cached.url);
      if (target.protocol !== 'https:' || !ALLOWED_HOSTS.some((pattern) => pattern.test(target.hostname))) return null;
      // redirect: 'error' — um redirecionamento poderia levar a um host fora da lista.
      const response = await doFetch(cached.url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.startsWith('image/') || Number(response.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) {
        urls.delete(mediaId);
        return null;
      }
      const body = await response.arrayBuffer();
      if (body.byteLength > MAX_IMAGE_BYTES) {
        urls.delete(mediaId);
        return null;
      }
      return { body, contentType };
    },
  };
}

export type ThumbnailService = ReturnType<typeof createThumbnailService>;
