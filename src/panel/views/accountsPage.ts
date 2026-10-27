import type { Account } from '../../db/repos/accounts.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { buttonClass, card, emptyState, formatDateTime, icon, type IconName, pageHeader, statusBadge, type Tone } from './components.js';
import { accountStatus } from './messages.js';

const STATUS_ICONS: Record<Tone, IconName> = {
  success: 'CircleCheck',
  warning: 'TriangleAlert',
  danger: 'CircleAlert',
  info: 'Info',
  neutral: 'CircleMinus',
};

export function accountsPage(accounts: Account[], now: number): SafeHtml {
  const connectLabel = html`${icon('Plus')}Conectar conta do Instagram`;
  const list = accounts.map((account) => {
    const status = accountStatus(account, now);
    const needsReconnect = account.status === 'reconnect_required' || account.status === 'disconnected';
    return card(html`<div class="space-y-4 p-4 sm:p-5">
      <div class="flex items-start gap-3">
        <div class="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold uppercase text-primary" aria-hidden="true">${account.username.slice(0, 2)}</div>
        <div class="min-w-0 flex-1 space-y-1.5">
          <p class="truncate font-medium leading-6">@${account.username}</p>
          ${statusBadge(status.label, status.tone, STATUS_ICONS[status.tone])}
        </div>
      </div>
      ${status.help ? html`<p class="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground text-pretty">${status.help}</p>` : ''}
      <div class="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        ${account.tokenExpiresAt && account.status !== 'disconnected'
          ? html`<p class="flex items-start gap-1.5 text-xs text-muted-foreground">${icon('ShieldCheck', 'size-3.5 mt-px')}<span>Acesso renovado automaticamente · válido até <span class="tabular-nums">${formatDateTime(account.tokenExpiresAt)}</span></span></p>`
          : html`<span></span>`}
        <div class="flex gap-2">
          ${needsReconnect ? html`<a href="/contas/conectar" class="${buttonClass('primary', 'flex-1 sm:flex-none')}">${icon('RefreshCw')}Reconectar</a>` : ''}
          ${account.status !== 'disconnected'
            ? html`<button hx-post="/contas/${account.id}/desconectar" hx-confirm="Desconectar @${account.username}? As automações desta conta serão pausadas."
                class="${buttonClass('outline', 'flex-1 sm:flex-none')}">${icon('Unlink')}Desconectar</button>`
            : ''}
        </div>
      </div>
    </div>`);
  });
  return html`${pageHeader(
      'Contas',
      'Contas do Instagram conectadas ao sistema.',
      accounts.length ? html`<a href="/contas/conectar" class="${buttonClass('outline')}">${connectLabel}</a>` : undefined,
    )}
    ${accounts.length
      ? html`<div class="space-y-3">${list}</div>`
      : emptyState(
          'Users',
          'Nenhuma conta conectada',
          'Conecte uma conta profissional do Instagram para começar a responder comentários.',
          html`<a href="/contas/conectar" class="${buttonClass('primary')}">${connectLabel}</a>`,
        )}`;
}
