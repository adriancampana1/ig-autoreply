export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeResponse {
  status?: number;
  json: unknown;
  headers?: Record<string, string>;
}

/** fetch falso: responde em ordem às respostas enfileiradas e grava as requisições feitas. */
export function createFakeFetch(responses: FakeResponse[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    requests.push({ url, method: init?.method ?? 'GET', headers, body });
    const next = queue.shift();
    if (!next) throw new Error(`Requisição inesperada: ${url}`);
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200, headers: next.headers });
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}
