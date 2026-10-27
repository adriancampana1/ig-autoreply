import type { FastifyInstance } from 'fastify';
import { listAccounts } from '../../db/repos/accounts.js';
import { listActivity, type InteractionStatus } from '../../db/repos/interactions.js';
import type { PanelContext } from '../context.js';
import { activityPage } from '../views/activityPage.js';

const PAGE_SIZE = 20;
const MAX_PAGE = 10_000;
const STATUSES: InteractionStatus[] = ['queued', 'done', 'partial', 'failed', 'skipped'];

export async function registerActivityRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  app.get('/atividade', async (request, reply) => {
    const query = request.query as { conta?: string; status?: string; pagina?: string };
    const accountId = Number(query.conta) || undefined;
    const status = STATUSES.find((s) => s === query.status);
    const parsed = Number.parseInt(query.pagina ?? '', 10);
    const page = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE) : 1;
    const rows = listActivity(ctx.db, { accountId, status, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
    return ctx.render(request, reply, {
      title: 'Atividade',
      nav: 'atividade',
      body: activityPage({
        rows: rows.slice(0, PAGE_SIZE),
        accounts: listAccounts(ctx.db),
        filter: { accountId, status, page },
        hasNext: rows.length > PAGE_SIZE,
      }),
    });
  });
}
