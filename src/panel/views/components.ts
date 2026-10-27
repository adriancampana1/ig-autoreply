import * as lucide from 'lucide-static';
import { html, raw, type SafeHtml } from '../../lib/html.js';

// Componentes base no estilo shadcn/ui (polidos na Task 15 com a skill impeccable).
// Os nomes e parâmetros destas funções são o contrato usado pelas páginas.

export type IconName = keyof typeof lucide;

export function icon(name: IconName, className = 'size-4'): SafeHtml {
  const svg = String(lucide[name])
    .replace(/\swidth="24"/, '')
    .replace(/\sheight="24"/, '')
    .replace(/class="([^"]*)"/, `class="$1 ${className} shrink-0" aria-hidden="true"`);
  return raw(svg);
}

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';

/** Anel de foco único do painel (botões, links, cards clicáveis). */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const BUTTON_BASE =
  'inline-flex min-h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ' +
  'transition-[color,background-color,border-color,box-shadow,scale] duration-150 ease-out-quart active:scale-[0.98] ' +
  `${FOCUS_RING} disabled:pointer-events-none disabled:opacity-50`;

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
  outline: 'border border-input bg-card shadow-xs hover:bg-accent',
  ghost: 'hover:bg-accent',
  destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
};

/**
 * Classes de botão. outline/ghost herdam a cor do texto, então `extra` pode trocá-la (ex.: text-destructive).
 * O preenchimento horizontal padrão (px-4) só entra se `extra` não trouxer o seu (px-/p-). */
export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  const padding = /(^|\s)([\w-]+:)*p[xlr]?-/.test(extra) ? '' : 'px-4';
  return `${BUTTON_BASE} ${padding} ${BUTTON_VARIANTS[variant]} ${extra}`.replace(/\s+/g, ' ').trim();
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-destructive/12 text-destructive',
  info: 'bg-primary/10 text-primary',
};

const BADGE_BASE = 'inline-flex max-w-full items-center gap-1 rounded-full py-0.5 text-xs font-medium leading-5';

export function badge(text: string, tone: Tone = 'neutral'): SafeHtml {
  return html`<span class="${BADGE_BASE} px-2.5 ${BADGE_TONES[tone]}">${text}</span>`;
}

/** Badge de situação com ícone: o estado nunca depende só da cor. */
export function statusBadge(text: string, tone: Tone, iconName: IconName): SafeHtml {
  return html`<span class="${BADGE_BASE} pl-2 pr-2.5 ${BADGE_TONES[tone]}">${icon(iconName, 'size-3.5')}${text}</span>`;
}

export function card(content: SafeHtml | SafeHtml[], extra = ''): SafeHtml {
  return html`<section class="rounded-xl border border-border bg-card text-card-foreground shadow-xs ${extra}">${content}</section>`;
}

/** Cabeçalho de página: título, uma linha de apoio opcional e a ação principal à direita. */
export function pageHeader(title: string, description?: string, action?: SafeHtml): SafeHtml {
  return html`<div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
    <div class="min-w-0 space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight text-balance">${title}</h1>
      ${description ? html`<p class="text-sm text-muted-foreground text-pretty">${description}</p>` : ''}
    </div>
    ${action ?? ''}
  </div>`;
}

const ALERT_TONES: Record<Exclude<Tone, 'neutral'>, string> = {
  success: 'border-success/25 bg-success/8 text-success',
  warning: 'border-warning/30 bg-warning/8 text-warning',
  danger: 'border-destructive/30 bg-destructive/8 text-destructive',
  info: 'border-primary/25 bg-primary/6 text-primary',
};

export function alertBox(tone: Exclude<Tone, 'neutral'>, title: string, body?: SafeHtml | string): SafeHtml {
  const icons: Record<typeof tone, IconName> = { success: 'CircleCheck', warning: 'TriangleAlert', danger: 'CircleAlert', info: 'Info' };
  return html`<div role="${tone === 'danger' ? 'alert' : 'status'}" class="flex gap-3 rounded-xl border px-4 py-3 text-sm ${ALERT_TONES[tone]}">
    ${icon(icons[tone], 'size-4.5 mt-0.5')}
    <div class="min-w-0 space-y-0.5"><p class="font-medium">${title}</p>${body ? html`<div class="text-pretty">${body}</div>` : ''}</div>
  </div>`;
}

export function emptyState(iconName: IconName, title: string, text: string, action?: SafeHtml): SafeHtml {
  return html`<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-input px-6 py-14 text-center">
    <div class="mb-2 grid size-12 place-items-center rounded-full bg-secondary text-muted-foreground">${icon(iconName, 'size-5')}</div>
    <h2 class="text-base font-semibold">${title}</h2>
    <p class="max-w-xs text-sm text-muted-foreground text-pretty">${text}</p>
    ${action ? html`<div class="mt-3">${action}</div>` : ''}
  </div>`;
}

const INPUT_CLASS =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground shadow-xs sm:text-sm ' +
  'transition-[border-color,box-shadow] duration-150 ease-out-quart placeholder:text-muted-foreground ' +
  'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 ' +
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export function inputClass(extra = ''): string {
  return `${INPUT_CLASS} min-h-11 ${extra}`.trim();
}

/** Altura mínima padrão de 96 px, a menos que `extra` traga a sua (min-h-*). */
export function textareaClass(extra = ''): string {
  const minHeight = /(^|\s)min-h-/.test(extra) ? '' : 'min-h-24';
  return `${INPUT_CLASS} ${minHeight} leading-relaxed ${extra}`.replace(/\s+/g, ' ').trim();
}

export function fieldError(message: string | undefined, id: string): SafeHtml {
  return message
    ? html`<p id="${id}" class="flex items-start gap-1.5 text-sm text-destructive">${icon('CircleAlert', 'size-4 mt-0.5')}<span>${message}</span></p>`
    : html``;
}

export function csrfInput(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

export function formatDateTime(epochMs: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(epochMs);
}
