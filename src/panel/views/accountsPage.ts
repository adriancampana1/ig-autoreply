import type { Account } from '../../db/repos/accounts.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { badge, buttonClass, card, emptyState, formatDateTime, icon } from './components.js';
import { accountStatus } from './messages.js';

export function accountsPage(accounts: Account[], now: number): SafeHtml {
  const connect = html`<a href="/contas/conectar" class="${buttonClass('primary')}">${icon('Plus')}Conectar conta do Instagram</a>`;
  const list = accounts.map((account) => {
    const status = accountStatus(account, now);
    const needsReconnect = account.status === 'reconnect_required' || account.status === 'disconnected';
    return card(html`<div class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
      <div class="flex flex-1 items-center gap-3">
        <div class="grid size-11 place-items-center rounded-full bg-secondary text-sm font-semibold uppercase">${account.username.slice(0, 2)}</div>
        <div class="min-w-0 space-y-1">
          <p class="truncate font-medium">@${account.username}</p>
          ${badge(status.label, status.tone)}
          ${status.help ? html`<p class="text-sm text-muted-foreground">${status.help}</p>` : ''}
          ${account.tokenExpiresAt && account.status !== 'disconnected'
            ? html`<p class="text-xs text-muted-foreground">Acesso renovado automaticamente · válido até ${formatDateTime(account.tokenExpiresAt)}</p>`
            : ''}
        </div>
      </div>
      <div class="flex gap-2">
        ${needsReconnect ? html`<a href="/contas/conectar" class="${buttonClass('primary')}">${icon('RefreshCw')}Reconectar</a>` : ''}
        ${account.status !== 'disconnected'
          ? html`<button hx-post="/contas/${account.id}/desconectar" hx-confirm="Desconectar @${account.username}? As automações desta conta serão pausadas."
              class="${buttonClass('outline')}">${icon('Unlink')}Desconectar</button>`
          : ''}
      </div>
    </div>`);
  });
  return html`<div class="flex flex-wrap items-center justify-between gap-3">
      <div><h1 class="text-2xl font-semibold tracking-tight">Contas</h1><p class="text-sm text-muted-foreground">Contas do Instagram conectadas ao sistema.</p></div>
      ${accounts.length ? connect : ''}
    </div>
    ${accounts.length
      ? html`<div class="space-y-3">${list}</div>`
      : emptyState('Users', 'Nenhuma conta conectada', 'Conecte uma conta profissional do Instagram para começar a responder comentários.', connect)}`;
}
