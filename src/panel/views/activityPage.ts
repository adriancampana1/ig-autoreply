import type { Account } from '../../db/repos/accounts.js';
import type { ActivityRow, InteractionStatus } from '../../db/repos/interactions.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { buttonClass, emptyState, formatDateTime, icon, type IconName, inputClass, pageHeader, statusBadge } from './components.js';
import { FAIL_REASON_TEXT, JOB_STATUS, SKIP_REASON_TEXT } from './messages.js';

const JOB_ICONS: Record<string, IconName> = {
  done: 'Check',
  pending: 'Clock',
  running: 'LoaderCircle',
  failed: 'X',
  cancelled: 'Minus',
};

function jobStatus(label: string, status: string | null, reason: string | null): SafeHtml {
  if (!status) return html``;
  const info = JOB_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return html`<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
    <span class="w-20 shrink-0 text-muted-foreground">${label}</span>${statusBadge(info.label, info.tone, JOB_ICONS[status] ?? 'Minus')}
    ${status === 'failed' || status === 'cancelled'
      ? html`<p class="basis-full pl-22 text-muted-foreground text-pretty">${FAIL_REASON_TEXT[reason ?? ''] ?? 'Não foi possível enviar'}</p>`
      : ''}
  </div>`;
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
  return html`${pageHeader('Atividade', 'Comentários com palavra-chave e o que foi enviado para cada pessoa.')}
    <form method="get" action="/atividade" class="grid grid-cols-2 gap-2 sm:flex"
      hx-get="/atividade" hx-trigger="change" hx-target="body" hx-push-url="true">
      <select name="conta" class="${inputClass('min-w-0 truncate sm:w-56')}" aria-label="Conta">
        <option value="">Todas as contas</option>
        ${input.accounts.map((a) => html`<option value="${a.id}" ${a.id === filter.accountId ? 'selected' : ''}>@${a.username}</option>`)}
      </select>
      <select name="status" class="${inputClass('min-w-0 sm:w-44')}" aria-label="Situação">
        ${STATUS_FILTERS.map((s) => html`<option value="${s.value}" ${s.value === (filter.status ?? '') ? 'selected' : ''}>${s.label}</option>`)}
      </select>
      <noscript><button class="${buttonClass('outline')}">Filtrar</button></noscript>
    </form>
    ${rows.length
      ? html`<ul class="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">${rows.map((row) => html`<li class="space-y-3 p-4">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-baseline gap-x-2 text-sm"><span class="font-medium [overflow-wrap:anywhere]">@${row.commenterUsername ?? 'usuário'}</span><time class="text-xs text-muted-foreground tabular-nums">${formatDateTime(row.createdAt)}</time></p>
              <p class="truncate text-xs text-muted-foreground">no post de @${row.accountUsername}</p>
            </div>
            ${row.mediaPermalink ? html`<a href="${row.mediaPermalink}" target="_blank" rel="noopener noreferrer" class="${buttonClass('ghost', '-mr-2 -mt-2 min-w-11 px-0 text-muted-foreground hover:text-foreground')}" aria-label="Abrir post no Instagram (nova aba)">${icon('ExternalLink')}</a>` : ''}
          </div>
          <blockquote class="break-words rounded-lg bg-secondary px-3 py-2 text-sm [overflow-wrap:anywhere]">“${row.commentText ?? ''}”</blockquote>
          ${row.status === 'skipped'
            ? html`<p class="flex items-center gap-1.5 text-xs text-muted-foreground">${icon('CircleSlash', 'size-3.5')}${SKIP_REASON_TEXT[row.skipReason ?? ''] ?? 'Ignorado'}</p>`
            : html`<div class="space-y-1.5">${jobStatus('Comentário', row.publicStatus, row.publicFailReason)}${jobStatus('Direct', row.dmStatus, row.dmFailReason)}</div>`}
        </li>`)}</ul>`
      : emptyState('Activity', 'Nada por aqui ainda', 'Quando alguém comentar uma palavra-chave, a resposta aparece aqui.')}
    ${filter.page > 1 || input.hasNext
      ? html`<nav class="flex justify-between gap-2" aria-label="Páginas">
          ${filter.page > 1 ? html`<a href="/atividade?${query(filter.page - 1)}" class="${buttonClass('outline', 'pl-3 pr-4')}">${icon('ChevronLeft')}Mais recentes</a>` : html`<span></span>`}
          ${input.hasNext ? html`<a href="/atividade?${query(filter.page + 1)}" class="${buttonClass('outline', 'pl-4 pr-3')}">Mais antigas${icon('ChevronRight')}</a>` : ''}
        </nav>`
      : ''}`;
}
