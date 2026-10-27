import type { Account } from '../../db/repos/accounts.js';
import type { AutomationSummary } from '../../db/repos/automations.js';
import type { MediaItem } from '../../instagram/client.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { badge, buttonClass, card, csrfInput, emptyState, fieldError, icon, inputClass, textareaClass } from './components.js';

export function automationsPage(items: AutomationSummary[], hasAccounts: boolean): SafeHtml {
  const create = html`<a href="/automacoes/nova" class="${buttonClass('primary')}">${icon('Plus')}Nova automação</a>`;
  if (!items.length) {
    return html`<h1 class="text-2xl font-semibold tracking-tight">Automações</h1>
      ${hasAccounts
        ? emptyState('Zap', 'Nenhuma automação ainda', 'Escolha um post, as palavras-chave e as respostas. O resto é automático.', create)
        : emptyState('Users', 'Conecte uma conta primeiro', 'Para criar automações, conecte uma conta do Instagram.', html`<a href="/contas" class="${buttonClass('primary')}">Ir para Contas</a>`)}`;
  }
  return html`<div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Automações</h1>${create}
    </div>
    <div class="space-y-3">${items.map((item) => automationCard(item))}</div>`;
}

export function automationCard(item: AutomationSummary): SafeHtml {
  return html`<div id="automacao-${item.id}">${card(html`<div class="flex gap-4 p-4">
    <img src="/midia/${item.accountId}/${item.mediaId}" alt="" loading="lazy" class="size-20 shrink-0 rounded-lg bg-secondary object-cover">
    <div class="min-w-0 flex-1 space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="truncate text-sm text-muted-foreground">@${item.accountUsername}</p>
          <p class="line-clamp-2 text-sm">${item.mediaCaption || 'Post sem legenda'}</p>
        </div>
        <button hx-post="/automacoes/${item.id}/${item.isActive ? 'pausar' : 'ativar'}" hx-target="#automacao-${item.id}" hx-swap="outerHTML"
          role="switch" aria-checked="${item.isActive ? 'true' : 'false'}" aria-label="${item.isActive ? 'Pausar automação' : 'Ativar automação'}"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${item.isActive ? 'bg-primary' : 'bg-input'}">
          <span class="inline-block size-5 rounded-full bg-background shadow transition-transform ${item.isActive ? 'translate-x-5' : 'translate-x-0.5'}"></span>
        </button>
      </div>
      <div class="flex flex-wrap gap-1">${item.keywords.map((keyword) => badge(keyword, 'info'))}</div>
      <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>${item.repliesToday} hoje · ${item.repliesTotal} no total</span>
        <a href="/automacoes/${item.id}/editar" class="${buttonClass('ghost', 'min-h-9 px-2')}">Editar${icon('ChevronRight')}</a>
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
  return html`<div class="space-y-1">
      <a href="/automacoes" class="text-sm text-muted-foreground hover:text-foreground">← Automações</a>
      <h1 class="text-2xl font-semibold tracking-tight">${editingId ? 'Editar automação' : 'Nova automação'}</h1>
    </div>
    ${errors.general ? html`<p class="text-sm text-destructive">${errors.general}</p>` : ''}
    <form method="post" action="${action}" class="space-y-6">
      ${csrfInput(input.csrf)}
      ${editingId
        ? html`<input type="hidden" name="accountId" value="${values.accountId}"><input type="hidden" name="mediaId" value="${values.mediaId}">`
        : card(html`<div class="space-y-4 p-4">
            <h2 class="font-medium">1. Conta e post</h2>
            <div class="space-y-2">
              <label for="accountId" class="text-sm font-medium">Conta</label>
              <select id="accountId" name="accountId" class="${inputClass()}" hx-get="/automacoes/posts" hx-target="#post-picker" hx-trigger="change, load"
                hx-vals='{"selected": "${values.mediaId ?? ''}"}'>
                ${input.accounts.map((a) => html`<option value="${a.id}" ${a.id === values.accountId ? 'selected' : ''}>@${a.username}</option>`)}
              </select>
              ${fieldError(errors.account, 'account-error')}
            </div>
            <fieldset class="space-y-2">
              <legend class="text-sm font-medium">Post</legend>
              <div id="post-picker" class="min-h-24 text-sm text-muted-foreground">Carregando posts…</div>
              ${fieldError(errors.media, 'media-error')}
            </fieldset>
          </div>`)}
      ${card(html`<div class="space-y-2 p-4">
        <h2 class="font-medium">${editingId ? '1' : '2'}. Palavras-chave</h2>
        <p class="text-sm text-muted-foreground">Separe por vírgula. Não importa maiúscula ou acento. Ex.: EU QUERO, link</p>
        <input name="keywords" value="${values.keywords}" class="${inputClass()}" ${errors.keywords ? html`aria-invalid="true"` : ''} required>
        ${fieldError(errors.keywords, 'keywords-error')}
      </div>`)}
      ${card(html`<div class="space-y-3 p-4">
        <h2 class="font-medium">${editingId ? '2' : '3'}. Resposta no comentário</h2>
        <p class="text-sm text-muted-foreground">Escreva pelo menos 3 versões — o sistema sorteia uma a cada resposta. Use {usuario} para mencionar a pessoa.</p>
        <div id="variations" class="space-y-2">
          ${variations.map((value, index) => html`<textarea name="variations" rows="2" maxlength="300" class="${textareaClass('min-h-16')}" aria-label="Versão ${index + 1}" placeholder="Ex.: Oi {usuario}, te mandei no direct! 💌">${value}</textarea>`)}
        </div>
        <button type="button" data-insert-token="{usuario}" class="${buttonClass('outline', 'min-h-9 px-3 text-xs')}">${icon('AtSign')}Inserir {usuario}</button>
        ${fieldError(errors.variations, 'variations-error')}
        <div class="rounded-md bg-secondary px-3 py-2 text-sm">
          <p class="text-xs text-muted-foreground">Prévia</p>
          <p data-reply-preview class="whitespace-pre-line" aria-live="polite"></p>
        </div>
      </div>`)}
      ${card(html`<div class="space-y-2 p-4">
        <h2 class="font-medium">${editingId ? '3' : '4'}. Mensagem no Direct</h2>
        <p class="text-sm text-muted-foreground">Enviada uma vez para quem comentou. Pode incluir link. Termine com "(mensagem automática)" — é o recomendado pela Meta. Limite: 1000 caracteres simples (emojis e acentos contam mais).</p>
        <textarea id="dmText" name="dmText" rows="5" data-max-bytes="1000" class="${textareaClass()}" placeholder="Ex.: Oi! Aqui está o link: https://… (mensagem automática)" required ${errors.dmText ? html`aria-invalid="true"` : ''}>${values.dmText}</textarea>
        <p class="text-right text-xs text-muted-foreground" data-counter-for="dmText" aria-live="polite"></p>
        ${fieldError(errors.dmText, 'dm-error')}
      </div>`)}
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <a href="/automacoes" class="${buttonClass('outline')}">Cancelar</a>
        <button class="${buttonClass('primary')}">${editingId ? 'Salvar alterações' : 'Criar automação'}</button>
      </div>
    </form>
    ${editingId
      ? html`<div class="flex justify-end">
          <button hx-post="/automacoes/${editingId}/excluir" hx-confirm="Excluir esta automação? Esta ação não pode ser desfeita."
            class="${buttonClass('ghost', 'text-destructive')}">${icon('Trash2')}Excluir automação</button>
        </div>`
      : ''}`;
}

export function mediaPicker(accountId: number, media: MediaItem[], takenMediaIds: Set<string>, selected?: string): SafeHtml {
  if (!media.length) return html`<p class="text-sm text-muted-foreground">Nenhum post encontrado nesta conta.</p>`;
  return html`<div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
    ${media.map((item) => {
      const taken = takenMediaIds.has(item.id);
      return html`<label class="group relative block aspect-square overflow-hidden rounded-lg border-2 border-transparent has-[:checked]:border-primary ${taken ? 'opacity-40' : 'cursor-pointer'}">
        <input type="radio" name="mediaId" value="${item.id}" class="peer sr-only" ${taken ? 'disabled' : ''} ${item.id === selected ? 'checked' : ''} required>
        <img src="/midia/${accountId}/${item.id}" alt="${item.caption?.slice(0, 80) ?? 'Post'}" loading="lazy" class="size-full bg-secondary object-cover">
        <span class="absolute right-1 top-1 hidden rounded-full bg-primary p-0.5 text-primary-foreground peer-checked:block">${icon('Check', 'size-3')}</span>
        ${taken ? html`<span class="absolute inset-x-1 bottom-1 rounded bg-background/90 px-1 text-[10px]">Já tem automação</span>` : ''}
      </label>`;
    })}
  </div>`;
}
