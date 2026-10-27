import { describe, expect, it } from 'vitest';
import { extractCommentEvents } from '../src/webhooks/parsePayload.js';

const value = {
  id: 'C1',
  from: { id: 'U1', username: 'ana' },
  text: 'EU QUERO',
  media: { id: 'M1', media_product_type: 'FEED' },
};

describe('extractCommentEvents', () => {
  it('lê o formato com changes[]', () => {
    const payload = { object: 'instagram', entry: [{ id: 'IG1', time: 1, changes: [{ field: 'comments', value }] }] };
    expect(extractCommentEvents(payload)).toEqual([
      { accountIgId: 'IG1', commentId: 'C1', fromId: 'U1', fromUsername: 'ana', isSelf: false, text: 'EU QUERO', mediaId: 'M1', parentId: undefined },
    ]);
  });

  it('lê o formato com field/value direto na entry e corpo em array', () => {
    const payload = [{ object: 'instagram', entry: [{ id: 'IG1', time: 1, field: 'comments', value }] }];
    expect(extractCommentEvents(payload)).toHaveLength(1);
  });

  it('marca comentários da própria conta (from.id igual ou self_ig_scoped_id)', () => {
    const own = { ...value, from: { id: 'IG1', username: 'loja' } };
    const self = { ...value, from: { id: 'X', username: 'loja', self_ig_scoped_id: 'S' } };
    const payload = {
      object: 'instagram',
      entry: [{ id: 'IG1', changes: [{ field: 'comments', value: own }, { field: 'comments', value: self }] }],
    };
    expect(extractCommentEvents(payload).map((e) => e.isSelf)).toEqual([true, true]);
  });

  it('aceita comment_id (formato Facebook Login) e parent_id', () => {
    const fb = { comment_id: 'C9', parent_id: 'C1', from: { id: 'U2' }, text: 'link', media: { id: 'M1' } };
    const payload = { object: 'instagram', entry: [{ id: 'IG1', changes: [{ field: 'comments', value: fb }] }] };
    expect(extractCommentEvents(payload)[0]).toMatchObject({ commentId: 'C9', parentId: 'C1' });
  });

  it('ignora outros campos, objetos não-instagram e eventos incompletos', () => {
    const payload = {
      object: 'instagram',
      entry: [
        { id: 'IG1', changes: [{ field: 'messages', value }] },
        { id: 'IG1', changes: [{ field: 'comments', value: { id: 'C2' } }] },
      ],
    };
    expect(extractCommentEvents(payload)).toEqual([]);
    expect(extractCommentEvents({ object: 'page', entry: [] })).toEqual([]);
    expect(extractCommentEvents('lixo')).toEqual([]);
  });
});
