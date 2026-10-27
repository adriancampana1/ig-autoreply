import { html, type SafeHtml } from '../../lib/html.js';
import { buttonClass, card, csrfInput, fieldError, icon, inputClass } from './components.js';

export function loginPage(csrf: string, error?: string): SafeHtml {
  return html`<div class="mx-auto mt-10 max-w-sm space-y-6">
    <div class="space-y-2 text-center">
      <div class="mx-auto w-fit rounded-xl bg-primary p-3 text-primary-foreground">${icon('MessageCircleReply', 'size-6')}</div>
      <h1 class="text-2xl font-semibold tracking-tight">Respostas automáticas</h1>
      <p class="text-sm text-muted-foreground">Entre para gerenciar as automações do Instagram.</p>
    </div>
    ${card(html`<form method="post" action="/entrar" class="space-y-4 p-6">
      ${csrfInput(csrf)}
      <div class="space-y-2">
        <label for="email" class="text-sm font-medium">E-mail</label>
        <input id="email" name="email" type="email" autocomplete="username" required class="${inputClass()}">
      </div>
      <div class="space-y-2">
        <label for="password" class="text-sm font-medium">Senha</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required class="${inputClass()}" ${error ? html`aria-invalid="true" aria-describedby="login-error"` : ''}>
        ${fieldError(error, 'login-error')}
      </div>
      <button class="${buttonClass('primary', 'w-full')}">Entrar</button>
    </form>`)}
  </div>`;
}
