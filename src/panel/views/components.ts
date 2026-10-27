import * as lucide from 'lucide-static';
import { html, raw, type SafeHtml } from '../../lib/html.js';

// Componentes base no estilo shadcn/ui. A Task de design (skill impeccable) refina tokens e detalhes visuais;
// os nomes e parâmetros destas funções são o contrato usado pelas páginas.

export type IconName = keyof typeof lucide;

export function icon(name: IconName, className = 'size-4'): SafeHtml {
  const svg = String(lucide[name])
    .replace(/\swidth="24"/, '')
    .replace(/\sheight="24"/, '')
    .replace(/class="([^"]*)"/, `class="$1 ${className} shrink-0" aria-hidden="true"`);
  return raw(svg);
}

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 min-h-11 px-4';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
};

export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${extra}`.trim();
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  info: 'bg-primary/10 text-primary',
};

export function badge(text: string, tone: Tone = 'neutral'): SafeHtml {
  return html`<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}">${text}</span>`;
}

export function card(content: SafeHtml | SafeHtml[], extra = ''): SafeHtml {
  return html`<section class="rounded-xl border border-border bg-card text-card-foreground shadow-sm ${extra}">${content}</section>`;
}

export function alertBox(tone: Exclude<Tone, 'neutral'>, title: string, body?: SafeHtml | string): SafeHtml {
  const icons: Record<typeof tone, IconName> = { success: 'CircleCheck', warning: 'TriangleAlert', danger: 'CircleAlert', info: 'Info' };
  return html`<div role="${tone === 'danger' ? 'alert' : 'status'}" class="flex gap-3 rounded-lg border p-4 text-sm ${BADGE_TONES[tone]} border-current/20">
    ${icon(icons[tone], 'size-5 mt-0.5')}
    <div class="space-y-1"><p class="font-medium">${title}</p>${body ? html`<div class="opacity-90">${body}</div>` : ''}</div>
  </div>`;
}

export function emptyState(iconName: IconName, title: string, text: string, action?: SafeHtml): SafeHtml {
  return html`<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
    <div class="rounded-full bg-secondary p-3 text-muted-foreground">${icon(iconName, 'size-6')}</div>
    <h2 class="text-base font-semibold">${title}</h2>
    <p class="max-w-sm text-sm text-muted-foreground">${text}</p>
    ${action ?? ''}
  </div>`;
}

const INPUT_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm shadow-xs placeholder:text-muted-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive';

export function inputClass(extra = ''): string {
  return `${INPUT_CLASS} min-h-11 ${extra}`.trim();
}

export function textareaClass(extra = ''): string {
  return `${INPUT_CLASS} min-h-24 ${extra}`.trim();
}

export function fieldError(message: string | undefined, id: string): SafeHtml {
  return message ? html`<p id="${id}" class="text-sm text-destructive">${message}</p>` : html``;
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
