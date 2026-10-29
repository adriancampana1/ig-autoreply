import type { FastifyInstance } from 'fastify';
import { getAccountById, listAccounts } from '../../db/repos/accounts.js';
import {
  createAutomation,
  deleteAutomation,
  DuplicateAutomationError,
  getAutomation,
  listAutomationSummaries,
  setAutomationActive,
  updateAutomationContent,
} from '../../db/repos/automations.js';
import { redirectAfterAction } from '../../http/redirect.js';
import { setFlash } from '../../http/session.js';
import { html } from '../../lib/html.js';
import { readAutomationForm, validateAutomationForm } from '../automationForm.js';
import type { PanelContext } from '../context.js';
import { automationCard, automationFormPage, automationsPage, mediaPicker, type AutomationFormValues } from '../views/automationPages.js';

function startOfTodayInSaoPaulo(now: number): number {
  const offset = 3 * 60 * 60_000; // America/Sao_Paulo é UTC-3 (sem horário de verão desde 2019)
  return Math.floor((now - offset) / 86_400_000) * 86_400_000 + offset;
}

export async function registerAutomationRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  const connectedAccounts = () => listAccounts(ctx.db).filter((a) => a.status !== 'disconnected');
  const summary = (id: number) => listAutomationSummaries(ctx.db, startOfTodayInSaoPaulo(ctx.now())).find((a) => a.id === id);

  app.get('/automacoes', async (request, reply) =>
    ctx.render(request, reply, {
      title: 'Automações',
      nav: 'automacoes',
      body: automationsPage(listAutomationSummaries(ctx.db, startOfTodayInSaoPaulo(ctx.now())), connectedAccounts().length > 0),
    }),
  );

  const renderForm = (
    request: Parameters<PanelContext['render']>[0],
    reply: Parameters<PanelContext['render']>[1],
    values: AutomationFormValues,
    errors = {},
    editingId?: number,
  ) =>
    ctx.render(request, reply, {
      title: editingId ? 'Editar automação' : 'Nova automação',
      nav: 'automacoes',
      status: Object.keys(errors).length ? 422 : 200,
      body: automationFormPage({ csrf: request.session.get('csrf') ?? '', accounts: connectedAccounts(), values, errors, editingId }),
    });

  app.get('/automacoes/nova', async (request, reply) => {
    if (connectedAccounts().length === 0) return reply.redirect('/contas');
    return renderForm(request, reply, { keywords: '', variations: [], dmText: '' });
  });

  /** Parcial htmx: grade com os posts recentes da conta escolhida. */
  app.get('/automacoes/posts', async (request, reply) => {
    const { accountId, selected } = request.query as { accountId?: string; selected?: string };
    const account = getAccountById(ctx.db, Number(accountId));
    if (!account?.tokenEnc) return reply.type('text/html').send(html`<p class="text-sm text-destructive">Conta indisponível. Reconecte em Contas.</p>`.value);
    try {
      const media = await ctx.client.listMedia(ctx.cipher.decrypt(account.tokenEnc), 24);
      ctx.thumbnails.remember(media);
      const taken = new Set(listAutomationSummaries(ctx.db, 0).filter((a) => a.accountId === account.id).map((a) => a.mediaId));
      return reply.type('text/html').send(mediaPicker(account.id, media, taken, selected).value);
    } catch (error) {
      request.log.warn({ err: error }, 'falha ao listar posts');
      return reply.type('text/html').send(html`<p class="text-sm text-destructive">Não foi possível carregar os posts agora. Tente de novo.</p>`.value);
    }
  });

  app.post('/automacoes', async (request, reply) => {
    const values = readAutomationForm(request.body as Record<string, unknown>);
    const result = validateAutomationForm(values);
    if (!result.ok) return renderForm(request, reply, values, result.errors);
    const account = getAccountById(ctx.db, result.data.accountId);
    if (!account?.tokenEnc) return renderForm(request, reply, values, { account: 'Conta indisponível. Reconecte em Contas.' });
    let media;
    try {
      media = await ctx.client.getMedia(ctx.cipher.decrypt(account.tokenEnc), result.data.mediaId);
    } catch (error) {
      request.log.warn({ err: error }, 'falha ao confirmar o post');
      return renderForm(request, reply, values, { general: 'Não foi possível confirmar o post no Instagram. Tente de novo.' });
    }
    try {
      createAutomation(
        ctx.db,
        { ...result.data, mediaType: media.mediaType, mediaPermalink: media.permalink, mediaCaption: media.caption?.slice(0, 300) },
        ctx.now(),
      );
    } catch (error) {
      if (error instanceof DuplicateAutomationError) return renderForm(request, reply, values, { media: 'Este post já tem uma automação.' });
      request.log.error({ err: error }, 'falha ao salvar automação');
      return renderForm(request, reply, values, { general: 'Não foi possível salvar. Tente de novo.' });
    }
    setFlash(request, { kind: 'success', message: 'Automação criada e ativa!' });
    return reply.redirect('/automacoes');
  });

  app.get('/automacoes/:id/editar', async (request, reply) => {
    const automation = getAutomation(ctx.db, Number((request.params as { id: string }).id));
    if (!automation) return reply.redirect('/automacoes');
    return renderForm(
      request,
      reply,
      {
        accountId: automation.accountId,
        mediaId: automation.mediaId,
        keywords: automation.keywords.join(', '),
        variations: automation.publicVariations,
        dmText: automation.dmText,
      },
      {},
      automation.id,
    );
  });

  app.post('/automacoes/:id', async (request, reply) => {
    const automation = getAutomation(ctx.db, Number((request.params as { id: string }).id));
    if (!automation) return reply.redirect('/automacoes');
    const values = { ...readAutomationForm(request.body as Record<string, unknown>), accountId: automation.accountId, mediaId: automation.mediaId };
    const result = validateAutomationForm(values);
    if (!result.ok) return renderForm(request, reply, values, result.errors, automation.id);
    updateAutomationContent(ctx.db, automation.id, result.data, ctx.now());
    setFlash(request, { kind: 'success', message: 'Automação atualizada.' });
    return reply.redirect('/automacoes');
  });

  for (const [action, active] of [['ativar', true], ['pausar', false]] as const) {
    app.post(`/automacoes/:id/${action}`, async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      const automation = getAutomation(ctx.db, id);
      if (!automation) return reply.code(404).send();
      if (active) {
        const account = getAccountById(ctx.db, automation.accountId);
        if (!account || !account.tokenEnc || account.status === 'disconnected' || account.status === 'reconnect_required') {
          setFlash(request, { kind: 'error', message: 'Reconecte a conta do Instagram antes de ativar esta automação.' });
          return redirectAfterAction(request, reply, '/automacoes');
        }
      }
      setAutomationActive(ctx.db, id, active, ctx.now());
      const item = summary(id)!;
      if (request.headers['hx-request']) return reply.type('text/html').send(automationCard(item).value);
      return reply.redirect('/automacoes');
    });
  }

  app.post('/automacoes/:id/excluir', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (getAutomation(ctx.db, id)) {
      deleteAutomation(ctx.db, id);
      setFlash(request, { kind: 'success', message: 'Automação excluída.' });
    }
    return redirectAfterAction(request, reply, '/automacoes');
  });
}
