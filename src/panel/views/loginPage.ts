import { html, type SafeHtml } from '../../lib/html.js';
import { buttonClass, card, csrfInput, fieldError, inputClass } from './components.js';
import { brandLogo } from './layout.js';

export function loginPage(csrf: string, error?: string): SafeHtml {
  return html`<div class="mx-auto max-w-sm space-y-8 pt-[8vh]">
    <div class="flex flex-col items-center gap-4 text-center">
      ${brandLogo()}
      <div class="space-y-1.5">
        <h1 class="text-2xl font-semibold tracking-tight">Respostas automáticas</h1>
        <p class="text-sm text-muted-foreground">Entre para gerenciar as automações do Instagram.</p>
      </div>
    </div>
    ${card(html`<form method="post" action="/entrar" class="space-y-5 p-6">
      ${csrfInput(csrf)}
      <div class="space-y-2">
        <label for="email" class="text-sm font-medium">E-mail</label>
        <input id="email" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" required class="${inputClass()}">
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
