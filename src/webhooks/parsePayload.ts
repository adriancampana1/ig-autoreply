export interface CommentEvent {
  accountIgId: string;
  commentId: string;
  fromId: string;
  fromUsername?: string;
  /** true quando o comentário é da própria conta (inclui as respostas que o app publica). */
  isSelf: boolean;
  text: string;
  mediaId: string;
  parentId?: string;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

function toCommentEvent(accountIgId: string, value: Obj): CommentEvent | null {
  const from = isObj(value.from) ? value.from : {};
  const media = isObj(value.media) ? value.media : {};
  const commentId = str(value.id) ?? str(value.comment_id);
  const fromId = str(from.id);
  const mediaId = str(media.id);
  if (!commentId || !fromId || !mediaId) return null;
  return {
    accountIgId,
    commentId,
    fromId,
    fromUsername: str(from.username),
    isSelf: fromId === accountIgId || from.self_ig_scoped_id !== undefined,
    text: str(value.text) ?? '',
    mediaId,
    parentId: str(value.parent_id),
  };
}

/**
 * Extrai eventos do campo `comments` (spec §4.6). Aceita o corpo como objeto ou array, e cada entry
 * com `changes[]` ou com `field`/`value` direto — a documentação da Meta mostra os dois formatos.
 */
export function extractCommentEvents(payload: unknown): CommentEvent[] {
  const bodies = Array.isArray(payload) ? payload : [payload];
  const events: CommentEvent[] = [];
  for (const body of bodies) {
    if (!isObj(body) || body.object !== 'instagram' || !Array.isArray(body.entry)) continue;
    for (const entry of body.entry) {
      if (!isObj(entry)) continue;
      const accountIgId = str(entry.id);
      if (!accountIgId) continue;
      const changes = Array.isArray(entry.changes) ? entry.changes : [entry];
      for (const change of changes) {
        if (!isObj(change) || change.field !== 'comments' || !isObj(change.value)) continue;
        const event = toCommentEvent(accountIgId, change.value);
        if (event) events.push(event);
      }
    }
  }
  return events;
}
