export interface LoggableRequest {
  method?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * Serializador de `req` do logger: registra só método, caminho (SEM query string) e IP.
 * A query carrega segredos (OAuth `code`/`state`, `hub.verify_token`) e os cabeçalhos carregam cookie e assinatura.
 */
export function serializeRequest(request: LoggableRequest): { method?: string; url?: string; remoteAddress?: string } {
  return {
    method: request.method,
    url: request.url?.split('?')[0],
    remoteAddress: request.ip ?? request.socket?.remoteAddress,
  };
}
