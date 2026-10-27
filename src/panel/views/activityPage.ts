import type { Account } from '../../db/repos/accounts.js';
import type { ActivityRow, InteractionStatus } from '../../db/repos/interactions.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { badge, buttonClass, card, emptyState, formatDateTime, icon, inputClass } from './components.js';
import { FAIL_REASON_TEXT, JOB_STATUS, SKIP_REASON_TEXT } from './messages.js';

function jobBadge(label: string, status: string | null, reason: string | null): SafeHtml {
  if (!status) return html``;
  const info = JOB_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return html`<div class="space-y-0.5"><div class="flex items-center gap-2 text-xs"><span class="text-muted-foreground">${label}</span>${badge(info.label, info.tone)}</div>
    ${status === 'failed' || status === 'cancelled' ? html`<p class="text-xs text-muted-foreground">${FAIL_REASON_TEXT[reason ?? ''] ?? 'Não foi possível enviar'}</p>` : ''}</div>`;
}

const STATUS_FILTERS: Array<{ value: '' | InteractionStatus; label: string }> = [
  { value: '', label: 'Tudo' },
  { value: 'done', label: 'Enviadas' },
  { value: 'queued', label: 'Na fila' },
  { value: 'partial', label: 'Parciais' },
  { value: 'failed', label: 'Falhas' },
  { value: 'skipped', label: 'Ignoradas' },
];

export function activityPage(input: {
  rows: ActivityRow[];
  accounts: Account[];
  filter: { accountId?: number; status?: InteractionStatus; page: number };
  hasNext: boolean;
}): SafeHtml {
  const { rows, filter } = input;
  const query = (page: number) =>
    new URLSearchParams({
      ...(filter.accountId ? { conta: String(filter.accountId) } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      pagina: String(page),
    }).toString();
  return html`<h1 class="text-2xl font-semibold tracking-tight">Atividade</h1>
    <form method="get" action="/atividade" class="flex flex-wrap gap-2"
      hx-get="/atividade" hx-trigger="change" hx-target="body" hx-push-url="true">
      <select name="conta" class="${inputClass('w-auto')}" aria-label="Conta">
        <option value="">Todas as contas</option>
        ${input.accounts.map((a) => html`<option value="${a.id}" ${a.id === filter.accountId ? 'selected' : ''}>@${a.username}</option>`)}
      </select>
      <select name="status" class="${inputClass('w-auto')}" aria-label="Situação">
        ${STATUS_FILTERS.map((s) => html`<option value="${s.value}" ${s.value === (filter.status ?? '') ? 'selected' : ''}>${s.label}</option>`)}
      </select>
      <noscript><button class="${buttonClass('outline')}">Filtrar</button></noscript>
    </form>
    ${rows.length
      ? html`<ul class="space-y-3">${rows.map((row) => html`<li>${card(html`<div class="space-y-3 p-4">
          <div class="flex items-start justify-between gap-2 text-sm">
            <div class="min-w-0"><p class="font-medium">@${row.commenterUsername ?? 'usuário'}</p><p class="truncate text-muted-foreground">em @${row.accountUsername} · ${formatDateTime(row.createdAt)}</p></div>
            ${row.mediaPermalink ? html`<a href="${row.mediaPermalink}" target="_blank" rel="noopener" class="${buttonClass('ghost', 'min-w-11 px-2')}" aria-label="Abrir post">${icon('ExternalLink')}</a>` : ''}
          </div>
          <blockquote class="rounded-md bg-secondary px-3 py-2 text-sm">“${row.commentText ?? ''}”</blockquote>
          ${row.status === 'skipped'
            ? html`<p class="text-xs text-muted-foreground">${SKIP_REASON_TEXT[row.skipReason ?? ''] ?? 'Ignorado'}</p>`
            : html`<div class="flex flex-wrap gap-4">${jobBadge('Comentário', row.publicStatus, row.publicFailReason)}${jobBadge('Direct', row.dmStatus, row.dmFailReason)}</div>`}
        </div>`)}</li>`)}</ul>`
      : emptyState('Activity', 'Nada por aqui ainda', 'Quando alguém comentar uma palavra-chave, a resposta aparece aqui.')}
    <div class="flex justify-between">
      ${filter.page > 1 ? html`<a href="/atividade?${query(filter.page - 1)}" class="${buttonClass('outline')}">Anteriores</a>` : html`<span></span>`}
      ${input.hasNext ? html`<a href="/atividade?${query(filter.page + 1)}" class="${buttonClass('outline')}">Mais antigas</a>` : ''}
    </div>`;
}
