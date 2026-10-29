import type { Account } from '../../db/repos/accounts.js';
import type { AutomationSummary } from '../../db/repos/automations.js';
import type { MediaItem } from '../../instagram/client.js';
import { html, type SafeHtml } from '../../lib/html.js';
import {
  alertBox,
  badge,
  buttonClass,
  card,
  csrfInput,
  emptyState,
  fieldError,
  FOCUS_RING,
  icon,
  inputClass,
  pageHeader,
  textareaClass,
} from './components.js';

export function automationsPage(items: AutomationSummary[], hasAccounts: boolean): SafeHtml {
  const create = html`<a href="/automacoes/nova" class="${buttonClass('primary')}">${icon('Plus')}Nova automação</a>`;
  if (!items.length) {
    return html`${pageHeader('Automações')}
      ${hasAccounts
        ? emptyState('Zap', 'Nenhuma automação ainda', 'Escolha um post, as palavras-chave e as respostas. O resto é automático.', create)
        : emptyState('Users', 'Conecte uma conta primeiro', 'Para criar automações, conecte uma conta do Instagram.', html`<a href="/contas" class="${buttonClass('primary')}">Ir para Contas</a>`)}`;
  }
  return html`${pageHeader('Automações', 'Cada automação responde aos comentários de um post.', create)}
    <div class="space-y-3">${items.map((item) => automationCard(item))}</div>`;
}

/** Nome estável do interruptor (o estado fica em aria-checked): conta + trecho da legenda. */
function postLabel(item: AutomationSummary): string {
  const caption = item.mediaCaption?.trim();
  return `de @${item.accountUsername}${caption ? `: ${caption.slice(0, 40)}` : ' (sem legenda)'}`;
}

// O visual do card segue o aria-checked do interruptor (via :has), então a troca otimista feita em app.js
// já atualiza trilho, rótulo e miniatura antes de o servidor responder.
// As classes ficam escritas por extenso porque o Tailwind só gera o que encontra literalmente no código.
const PAUSED_THUMB = 'group-has-[[role=switch][aria-checked=false]]/auto:opacity-50 group-has-[[role=switch][aria-checked=false]]/auto:grayscale';
const PAUSED_HIDE = 'group-has-[[role=switch][aria-checked=false]]/auto:hidden';
const PAUSED_SHOW = 'group-has-[[role=switch][aria-checked=false]]/auto:inline';

export function automationCard(item: AutomationSummary): SafeHtml {
  return html`<div id="automacao-${item.id}" class="group/auto">${card(html`<div class="flex gap-3 p-3 sm:gap-4 sm:p-4">
    <img src="/midia/${item.accountId}/${item.mediaId}" alt="" loading="lazy" class="size-16 shrink-0 rounded-lg bg-secondary object-cover transition-[opacity,filter] duration-200 ease-out-quart sm:size-20 ${PAUSED_THUMB}">
    <div class="min-w-0 flex-1">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1 space-y-0.5 pt-0.5">
          <p class="truncate text-xs text-muted-foreground">@${item.accountUsername}</p>
          <p class="line-clamp-2 text-sm font-medium leading-snug [overflow-wrap:anywhere]">${item.mediaCaption || 'Post sem legenda'}</p>
        </div>
        <div class="-mr-1 -mt-1 flex shrink-0 items-center gap-1">
          <span class="text-xs font-medium" aria-hidden="true"><span class="text-primary ${PAUSED_HIDE}">Ativa</span><span class="hidden text-muted-foreground ${PAUSED_SHOW}">Pausada</span></span>
          <button id="interruptor-${item.id}" hx-post="/automacoes/${item.id}/${item.isActive ? 'pausar' : 'ativar'}" hx-target="#automacao-${item.id}" hx-swap="outerHTML" hx-sync="this:drop"
            role="switch" aria-checked="${item.isActive ? 'true' : 'false'}" aria-label="Automação do post ${postLabel(item)}"
            class="group/switch inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <span class="relative inline-flex h-6 w-11 items-center rounded-full bg-control transition-colors duration-200 ease-out-quart group-aria-checked/switch:bg-primary group-[.htmx-request]/switch:opacity-70">
              <span class="inline-block size-5 translate-x-0.5 rounded-full bg-thumb shadow-sm transition-[translate,background-color] duration-200 ease-out-quart group-aria-checked/switch:translate-x-5.5 group-aria-checked/switch:bg-primary-foreground"></span>
            </span>
          </button>
        </div>
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">${item.keywords.map((keyword) => badge(keyword, 'neutral'))}</div>
      <div class="mt-1 flex items-center justify-between gap-2">
        <p class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">${icon('MessageCircle', 'size-3.5')}<span class="sr-only">Respostas:</span><span class="truncate">${item.repliesToday} hoje · ${item.repliesTotal} no total</span></p>
        <a href="/automacoes/${item.id}/editar" class="${buttonClass('ghost', '-mr-2 px-3')}">Editar${icon('ChevronRight', 'size-4 text-muted-foreground')}</a>
      </div>
    </div>
  </div>`)}</div>`;
}

export interface AutomationFormValues {
  accountId?: number;
  mediaId?: string;
  mediaPermalink?: string;
  mediaCaption?: string;
  mediaType?: string;
  keywords: string;
  variations: string[];
  dmText: string;
}

export type FormErrors = Partial<Record<'account' | 'media' | 'keywords' | 'variations' | 'dmText' | 'general', string>>;

/** Bloco numerado do formulário: o passo, o título (que também rotula o campo) e uma linha de ajuda. */
function formSection(step: number, titleId: string, title: string, help: string | SafeHtml, content: SafeHtml): SafeHtml {
  return card(html`<div class="space-y-4 p-4 sm:p-6">
    <div class="flex gap-3">
      <span class="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums" aria-hidden="true">${step}</span>
      <div class="min-w-0 space-y-1">
        <h2 id="${titleId}" class="font-semibold leading-6">${title}</h2>
        <p class="text-sm text-muted-foreground text-pretty">${help}</p>
      </div>
    </div>
    ${content}
  </div>`);
}

const VARIATION_EXAMPLES = [
  'Ex.: Oi {usuario}, te mandei no direct! 💌',
  'Ex.: Prontinho {usuario}, olha o direct!',
  'Ex.: Enviado, {usuario}! Confere sua caixa de mensagens.',
];

function postSkeleton(): SafeHtml {
  const tiles = Array.from({ length: 12 }, () => html`<div class="aspect-square animate-pulse rounded-lg bg-secondary"></div>`);
  return html`<span class="sr-only">Carregando posts…</span><div class="grid grid-cols-3 gap-1.5 sm:grid-cols-4 sm:gap-2" aria-hidden="true">${tiles}</div>`;
}

export function automationFormPage(input: {
  csrf: string;
  accounts: Account[];
  values: AutomationFormValues;
  errors: FormErrors;
  editingId?: number;
}): SafeHtml {
  const { values, errors, editingId } = input;
  const variations = values.variations.length >= 3 ? values.variations : [...values.variations, '', '', ''].slice(0, 3);
  const action = editingId ? `/automacoes/${editingId}` : '/automacoes';
  const step = (n: number) => (editingId ? n - 1 : n);
  const editingAccount = editingId ? input.accounts.find((a) => a.id === values.accountId) : undefined;
  return html`<div class="space-y-1">
      <a href="/automacoes" class="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:text-foreground ${FOCUS_RING}">${icon('ChevronLeft')}Automações</a>
      <h1 class="text-2xl font-semibold tracking-tight">${editingId ? 'Editar automação' : 'Nova automação'}</h1>
    </div>
    ${errors.general ? alertBox('danger', errors.general) : ''}
    <form method="post" action="${action}" class="space-y-4">
      ${csrfInput(input.csrf)}
      ${editingId
        ? html`<input type="hidden" name="accountId" value="${values.accountId}"><input type="hidden" name="mediaId" value="${values.mediaId}">
          <div class="flex items-center gap-3 rounded-xl border border-border bg-secondary/50 p-3">
            <img src="/midia/${values.accountId}/${values.mediaId}" alt="" class="size-12 shrink-0 rounded-md bg-secondary object-cover">
            <div class="min-w-0 text-sm">
              <p class="font-medium">Post${editingAccount ? html` de @${editingAccount.username}` : ''}</p>
              <p class="text-muted-foreground text-pretty">O post não muda. Para usar outro post, crie uma nova automação.</p>
            </div>
          </div>`
        : formSection(1, 'post-title', 'Conta e post', 'Escolha a conta e toque no post que vai ter respostas automáticas.', html`
            <div class="space-y-2">
              <label for="accountId" class="text-sm font-medium">Conta</label>
              <select id="accountId" name="accountId" class="${inputClass('truncate pr-10')}" ${errors.account ? html`aria-invalid="true" aria-describedby="account-error"` : ''} hx-get="/automacoes/posts" hx-target="#post-picker" hx-trigger="change, load" hx-indicator="#post-picker"
                hx-vals='{"selected": "${values.mediaId ?? ''}"}'>
                ${input.accounts.map((a) => html`<option value="${a.id}" ${a.id === values.accountId ? 'selected' : ''}>@${a.username}</option>`)}
              </select>
              ${fieldError(errors.account, 'account-error')}
            </div>
            <fieldset class="space-y-2" ${errors.media ? html`aria-describedby="media-error"` : ''}>
              <legend class="mb-2 text-sm font-medium">Post</legend>
              ${fieldError(errors.media, 'media-error')}
              <div id="post-picker" class="min-h-24" aria-busy="true">${postSkeleton()}</div>
              <p id="post-picker-status" class="sr-only" role="status" aria-live="polite"></p>
            </fieldset>`)}
      ${formSection(step(2), 'keywords-title', 'Palavras-chave', 'Separe por vírgula. Maiúsculas e acentos não importam. Ex.: EU QUERO, link', html`
        <div class="space-y-2">
          <input id="keywords" name="keywords" value="${values.keywords}" class="${inputClass()}" aria-labelledby="keywords-title" autocomplete="off" autocapitalize="none" placeholder="EU QUERO, link" ${errors.keywords ? html`aria-invalid="true" aria-describedby="keywords-error"` : ''} required>
          <div data-keyword-chips class="flex flex-wrap gap-1.5 empty:hidden" aria-hidden="true"></div>
          ${fieldError(errors.keywords, 'keywords-error')}
        </div>`)}
      ${formSection(step(3), 'variations-title', 'Resposta no comentário', 'Escreva 3 versões ou mais: o sistema sorteia uma a cada resposta. Use {usuario} para mencionar a pessoa.', html`
        <div id="variations" class="space-y-2">
          ${variations.map((value, index) => html`<textarea name="variations" rows="2" maxlength="300" class="${textareaClass('min-h-16 field-sizing-content')}" aria-label="Versão ${index + 1}" ${errors.variations ? html`aria-invalid="true" aria-describedby="variations-error"` : ''} placeholder="${VARIATION_EXAMPLES[index] ?? VARIATION_EXAMPLES[0]}">${value}</textarea>`)}
        </div>
        ${fieldError(errors.variations, 'variations-error')}
        <button type="button" data-insert-token="{usuario}" class="${buttonClass('secondary', 'px-3')}">${icon('AtSign')}Inserir {usuario}</button>
        <div class="rounded-lg border border-border bg-background p-3">
          <p class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">${icon('Eye', 'size-3.5')}Prévia da resposta</p>
          <div class="flex gap-2.5">
            <span class="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden="true">${icon('MessageCircleReply', 'size-3.5')}</span>
            <p data-reply-preview class="whitespace-pre-line min-w-0 pt-0.5 text-sm leading-relaxed [overflow-wrap:anywhere]" aria-live="polite"></p>
          </div>
        </div>`)}
      ${formSection(step(4), 'dm-title', 'Mensagem no Direct', 'Enviada uma vez para quem comentou. Pode ter link. A Meta recomenda terminar com "(mensagem automática)". Limite: 1000 caracteres simples; emojis e acentos contam mais.', html`
        <div class="space-y-2">
          <textarea id="dmText" name="dmText" rows="5" data-max-bytes="1000" class="${textareaClass('field-sizing-content min-h-32')}" aria-labelledby="dm-title" placeholder="Ex.: Oi! Aqui está o link: https://… (mensagem automática)" required ${errors.dmText ? html`aria-invalid="true" aria-describedby="dm-error"` : ''}>${values.dmText}</textarea>
          ${fieldError(errors.dmText, 'dm-error')}
          <div class="flex flex-wrap items-center justify-between gap-2">
            <button type="button" data-append-text="(mensagem automática)" class="${buttonClass('secondary', 'px-3')}">${icon('Plus')}Adicionar “(mensagem automática)”</button>
            <p class="ml-auto text-xs text-muted-foreground tabular-nums" data-counter-for="dmText" aria-live="polite"></p>
          </div>
        </div>`)}
      <div class="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <a href="/automacoes" class="${buttonClass('outline')}">Cancelar</a>
        <button class="${buttonClass('primary', 'sm:min-w-40')}">${editingId ? 'Salvar alterações' : 'Criar automação'}</button>
      </div>
    </form>
    ${editingId
      ? html`<div class="border-t border-border pt-6">
          <button hx-post="/automacoes/${editingId}/excluir" hx-confirm="Excluir esta automação? Esta ação não pode ser desfeita."
            class="${buttonClass('ghost', 'w-full text-destructive hover:bg-destructive/10 sm:w-auto')}">${icon('Trash2')}Excluir automação</button>
        </div>`
      : ''}`;
}

export function mediaPicker(accountId: number, media: MediaItem[], takenMediaIds: Set<string>, selected?: string): SafeHtml {
  if (!media.length) {
    return html`<p class="rounded-lg border border-dashed border-outline px-4 py-8 text-center text-sm text-muted-foreground">Nenhum post encontrado nesta conta.</p>`;
  }
  return html`<div class="grid grid-cols-3 gap-1.5 sm:grid-cols-4 sm:gap-2">
    ${media.map((item) => {
      const taken = takenMediaIds.has(item.id);
      const isVideo = item.mediaType === 'VIDEO' || item.mediaProductType === 'REELS';
      return html`<label class="group/tile relative block aspect-square overflow-hidden rounded-lg bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-card ${taken ? 'cursor-not-allowed' : 'cursor-pointer'}">
        <input type="radio" name="mediaId" value="${item.id}" class="peer sr-only" ${taken ? 'disabled' : ''} ${item.id === selected ? 'checked' : ''} required>
        <img src="/midia/${accountId}/${item.id}" alt="${item.caption?.slice(0, 80) ?? 'Post'}" loading="lazy" class="size-full object-cover transition-[opacity,scale] duration-200 ease-out-quart ${taken ? 'opacity-40 grayscale' : 'group-hover/tile:scale-[1.03]'}">
        <span class="pointer-events-none absolute inset-0 rounded-lg ring-3 ring-inset ring-primary opacity-0 transition-opacity duration-150 ease-out-quart peer-checked:opacity-100"></span>
        <span class="pointer-events-none absolute right-1.5 top-1.5 grid size-6 scale-50 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm transition-[opacity,scale] duration-150 ease-out-quart peer-checked:scale-100 peer-checked:opacity-100">${icon('Check', 'size-3.5')}</span>
        ${isVideo ? html`<span class="pointer-events-none absolute left-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-background/85 text-foreground">${icon('Play', 'size-3')}<span class="sr-only">Vídeo</span></span>` : ''}
        ${taken ? html`<span class="absolute inset-x-1 bottom-1 rounded-md bg-background/90 px-1 py-0.5 text-center text-[11px] font-medium leading-tight text-foreground">Já tem automação</span>` : ''}
      </label>`;
    })}
  </div>`;
}
