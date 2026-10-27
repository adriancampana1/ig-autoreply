import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import type { SafeHtml } from '../lib/html.js';
import type { ThumbnailService } from '../media/thumbnails.js';
import type { NavKey } from './views/layout.js';

export interface RenderPage {
  title: string;
  body: SafeHtml;
  nav?: NavKey;
  status?: number;
}

/** Dependências compartilhadas pelas rotas do painel. */
export interface PanelContext extends AppDeps {
  thumbnails: ThumbnailService;
  render: (request: FastifyRequest, reply: FastifyReply, page: RenderPage) => FastifyReply;
}
