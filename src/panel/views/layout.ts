import type { Flash } from '../../http/session.js';
import { assetUrl } from '../../http/assets.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { alertBox, buttonClass, csrfInput, FOCUS_RING, icon, type IconName } from './components.js';

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

function brandMark(size: 'sm' | 'lg'): SafeHtml {
  return size === 'sm'
    ? html`<span class="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">${icon('MessageCircleReply', 'size-4.5')}</span>`
    : html`<span class="grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">${icon('MessageCircleReply', 'size-6')}</span>`;
}

export function layout(props: LayoutProps): string {
  const navLink = (item: (typeof NAV)[number], mobile: boolean) => {
    const active = item.key === props.nav;
    const current = active ? html`aria-current="page"` : '';
    return mobile
      ? html`<a href="${item.href}" class="group flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${active ? 'text-foreground' : 'text-muted-foreground'}" ${current}>
          <span class="grid h-7 w-14 place-items-center rounded-full transition-colors duration-150 ease-out-quart ${active ? 'bg-primary/12 text-primary' : 'group-hover:bg-accent'}">${icon(item.icon, 'size-5')}</span>${item.label}</a>`
      : html`<a href="${item.href}" class="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors duration-150 ease-out-quart ${FOCUS_RING} ${active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}" ${current}>${icon(item.icon, `size-4 ${active ? 'text-primary' : ''}`)}${item.label}</a>`;
  };

  const page = html`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="htmx-config" content='{"includeIndicatorStyles": false}'>
  <title>${props.title} · Respostas automáticas</title>
  <link rel="preload" href="/assets/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="${assetUrl('app.css')}">
  <script src="${assetUrl('htmx.min.js')}" defer></script>
  <script src="${assetUrl('app.js')}" defer></script>
</head>
<body class="min-h-dvh bg-background font-sans text-foreground antialiased" hx-headers='{"x-csrf-token": "${props.csrf}"}'>
  ${props.nav
    ? html`<header class="sticky top-0 z-20 border-b border-border bg-background">
        <div class="mx-auto flex h-16 max-w-3xl items-center justify-between gap-2 px-4">
          <a href="/automacoes" class="-ml-1 flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg px-1 font-semibold tracking-tight ${FOCUS_RING}">${brandMark('sm')}<span class="truncate">Respostas automáticas</span></a>
          <nav class="hidden items-center gap-1 sm:flex" aria-label="Principal">${NAV.map((item) => navLink(item, false))}</nav>
          <form method="post" action="/sair" class="shrink-0">${csrfInput(props.csrf)}<button class="${buttonClass('ghost', 'min-w-11 px-0 text-muted-foreground hover:text-foreground sm:px-3')}" aria-label="Sair">${icon('LogOut')}<span class="hidden sm:inline">Sair</span></button></form>
        </div>
      </header>`
    : ''}
  <main class="mx-auto max-w-3xl space-y-6 px-4 ${props.nav ? 'pb-28 pt-6 sm:pb-16 sm:pt-8' : 'py-10'}">
    ${props.flash ? alertBox(props.flash.kind === 'success' ? 'success' : 'danger', props.flash.message) : ''}
    ${props.alerts ?? []}
    ${props.body}
  </main>
  ${props.nav
    ? html`<nav class="fixed inset-x-0 bottom-0 z-20 flex gap-1 border-t border-border bg-background px-2 pb-[env(safe-area-inset-bottom)] sm:hidden" aria-label="Principal">${NAV.map((item) => navLink(item, true))}</nav>`
    : ''}
</body>
</html>`;
  return page.value;
}

/** Marca grande usada na tela Entrar. */
export function brandLogo(): SafeHtml {
  return brandMark('lg');
}
