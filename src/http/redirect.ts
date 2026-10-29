import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Redireciona após uma ação. Em requisições htmx usa o cabeçalho HX-Redirect (um 302 seria seguido
 * pelo XHR e a página inteira seria trocada dentro do botão).
 */
export function redirectAfterAction(request: FastifyRequest, reply: FastifyReply, url: string): FastifyReply {
  if (request.headers['hx-request']) return reply.header('HX-Redirect', url).code(204).send();
  return reply.redirect(url);
}
