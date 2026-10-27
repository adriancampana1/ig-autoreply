import { describe, expect, it } from 'vitest';
import { createInstagramClient, readGraphResponse } from '../src/instagram/client.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { createFakeFetch } from './helpers/fakeFetch.js';

const build = (responses: Parameters<typeof createFakeFetch>[0]) => {
  const fake = createFakeFetch(responses);
  return { client: createInstagramClient({ version: 'v26.0', fetch: fake.fetch }), requests: fake.requests };
};

describe('createInstagramClient', () => {
  it('getProfile usa user_id como igId e id como appUserId', async () => {
    const { client, requests } = build([
      { json: { id: '999', user_id: 17841400000000000, username: 'loja', account_type: 'Business' } },
    ]);
    const profile = await client.getProfile('TOKEN');
    expect(profile).toMatchObject({ igId: '17841400000000000', appUserId: '999', username: 'loja' });
    expect(requests[0]!.url.pathname).toBe('/v26.0/me');
    expect(requests[0]!.headers.authorization).toBe('Bearer TOKEN');
  });

  it('replyToComment envia POST JSON para /{comment_id}/replies', async () => {
    const { client, requests } = build([{ json: { id: '178' } }]);
    await expect(client.replyToComment('T', 'C1', 'Oi @ana')).resolves.toEqual({ id: '178' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url.pathname).toBe('/v26.0/C1/replies');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ message: 'Oi @ana' });
  });

  it('sendPrivateReply usa recipient.comment_id', async () => {
    const { client, requests } = build([{ json: { recipient_id: 'R', message_id: 'M' } }]);
    await expect(client.sendPrivateReply('T', 'IG1', 'C1', 'Link: https://x.y')).resolves.toEqual({ messageId: 'M' });
    expect(requests[0]!.url.pathname).toBe('/v26.0/IG1/messages');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ recipient: { comment_id: 'C1' }, message: { text: 'Link: https://x.y' } });
  });

  it('listComments mapeia autor e cursor de paginação', async () => {
    const { client, requests } = build([
      {
        json: {
          data: [{ id: 'c1', text: 'eu quero', timestamp: '2026-10-27T10:00:00+0000', from: { id: 'u1', username: 'ana' } }],
          paging: { cursors: { after: 'CUR' }, next: 'https://graph.instagram.com/next' },
        },
      },
    ]);
    const page = await client.listComments('T', 'M1', 'PREV');
    expect(page).toEqual({
      comments: [{ id: 'c1', text: 'eu quero', timestamp: '2026-10-27T10:00:00+0000', fromId: 'u1', fromUsername: 'ana', hidden: undefined }],
      nextCursor: 'CUR',
    });
    expect(requests[0]!.url.searchParams.get('after')).toBe('PREV');
  });

  it('subscribeToComments assina apenas o campo comments', async () => {
    const { client, requests } = build([{ json: { success: true } }]);
    await client.subscribeToComments('T');
    expect(requests[0]!.url.pathname).toBe('/v26.0/me/subscribed_apps');
    expect(requests[0]!.url.searchParams.get('subscribed_fields')).toBe('comments');
  });

  it('converte erro da Graph API em GraphApiError com tempo de espera', async () => {
    const { client } = build([
      {
        status: 400,
        json: { error: { message: 'Too many calls', code: 80002, error_subcode: 2207051 } },
        headers: { 'x-business-use-case-usage': JSON.stringify({ '1': [{ type: 'instagram', estimated_time_to_regain_access: 12 }] }) },
      },
    ]);
    const error = await client.replyToComment('T', 'C', 'm').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(error).toMatchObject({ code: 80002, subcode: 2207051, httpStatus: 400, regainAccessMinutes: 12 });
  });
});

describe('readGraphResponse: formatos e corpos malformados', () => {
  it('IDs numéricos acima de 2^53 chegam como string exata (getProfile)', async () => {
    const raw = '{"id":"999","user_id":17841405793187219,"username":"loja"}';
    const client = createInstagramClient({ version: 'v26.0', fetch: (async () => new Response(raw, { status: 200 })) as typeof fetch });
    await expect(client.getProfile('T')).resolves.toMatchObject({ igId: '17841405793187219', appUserId: '999' });
  });

  it('IDs numéricos grandes chegam como string exata (readGraphResponse)', async () => {
    const body = await readGraphResponse<{ user_id: string; id: string }>(
      new Response('{"id":17841405793187219,"user_id":17841405793187219}', { status: 200 }),
    );
    expect(body.user_id).toBe('17841405793187219');
    expect(body.id).toBe('17841405793187219');
  });

  it('erro no formato do host OAuth ({error_type, code, error_message}) vira GraphApiError com mensagem e código', async () => {
    const response = new Response(JSON.stringify({ error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' }), { status: 400 });
    const error = await readGraphResponse(response).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(error).toMatchObject({ message: 'Invalid authorization code', code: 400, httpStatus: 400, errorType: 'OAuthException' });
  });

  it('2xx com corpo null, não-objeto ou não-JSON → GraphApiError (não TypeError)', async () => {
    for (const text of ['null', '42', '[1,2]', 'not json']) {
      const error = await readGraphResponse(new Response(text, { status: 200 })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GraphApiError);
    }
  });
});
