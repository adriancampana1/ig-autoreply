import type { Flash } from '../../http/session.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { alertBox, buttonClass, csrfInput, icon, type IconName } from './components.js';

export type NavKey = 'automacoes' | 'contas' | 'atividade';

export interface LayoutProps {
  title: string;
  body: SafeHtml;
  csrf: string;
  /** Ausente nas telas sem login (ex.: Entrar). */
  nav?: NavKey;
  flash?: Flash | null;
  /** Avisos persistentes (ex.: conta precisa reconectar). */
  alerts?: SafeHtml[];
}

const NAV: Array<{ key: NavKey; href: string; label: string; icon: IconName }> = [
  { key: 'automacoes', href: '/automacoes', label: 'Automações', icon: 'Zap' },
  { key: 'atividade', href: '/atividade', label: 'Atividade', icon: 'Activity' },
  { key: 'contas', href: '/contas', label: 'Contas', icon: 'Users' },
];

export function layout(props: LayoutProps): string {
  const navLink = (item: (typeof NAV)[number], mobile: boolean) => {
    const active = item.key === props.nav;
    return mobile
      ? html`<a href="${item.href}" class="flex flex-1 flex-col items-center gap-1 py-2 text-xs ${active ? 'text-foreground font-medium' : 'text-muted-foreground'}" ${active ? html`aria-current="page"` : ''}>${icon(item.icon, 'size-5')}${item.label}</a>`
      : html`<a href="${item.href}" class="rounded-md px-3 py-2 text-sm ${active ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}" ${active ? html`aria-current="page"` : ''}>${item.label}</a>`;
  };

  const page = html`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="htmx-config" content='{"includeIndicatorStyles": false}'>
  <title>${props.title} · Respostas automáticas</title>
  <link rel="stylesheet" href="/assets/app.css">
  <script src="/assets/htmx.min.js" defer></script>
  <script src="/assets/app.js" defer></script>
</head>
<body class="min-h-dvh bg-background text-foreground antialiased" hx-headers='{"x-csrf-token": "${props.csrf}"}'>
  ${props.nav
    ? html`<header class="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
        <div class="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-4">
          <a href="/automacoes" class="flex items-center gap-2 font-semibold">${icon('MessageCircleReply', 'size-5')}<span>Respostas automáticas</span></a>
          <nav class="hidden gap-1 sm:flex" aria-label="Principal">${NAV.map((item) => navLink(item, false))}</nav>
          <form method="post" action="/sair">${csrfInput(props.csrf)}<button class="${buttonClass('ghost', 'px-3')}" aria-label="Sair">${icon('LogOut')}</button></form>
        </div>
      </header>`
    : ''}
  <main class="mx-auto max-w-3xl space-y-6 px-4 pb-28 pt-6 sm:pb-12">
    ${props.flash ? alertBox(props.flash.kind === 'success' ? 'success' : 'danger', props.flash.message) : ''}
    ${props.alerts ?? []}
    ${props.body}
  </main>
  ${props.nav
    ? html`<nav class="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden" aria-label="Principal">${NAV.map((item) => navLink(item, true))}</nav>`
    : ''}
</body>
</html>`;
  return page.value;
}
