// Melhorias progressivas do painel (ele funciona sem JS; isto só ajuda).
// Servido de /assets/app.js (CSP script-src 'self'): nada de JS inline.
(() => {
  const encoder = new TextEncoder();

  function setupByteCounters(root) {
    root.querySelectorAll('textarea[data-max-bytes]').forEach((field) => {
      const counter = root.querySelector(`[data-counter-for="${field.id}"]`);
      if (!counter) return;
      const max = Number(field.dataset.maxBytes);
      const update = () => {
        const used = encoder.encode(field.value).length;
        counter.textContent = `${used}/${max}`;
        counter.classList.toggle('text-destructive', used > max);
        counter.classList.toggle('font-medium', used > max);
      };
      field.addEventListener('input', update);
      update();
    });
  }

  let lastFocusedVariation = null;
  function setupInsertButtons(root) {
    root.querySelectorAll('textarea[name="variations"]').forEach((field) => {
      field.addEventListener('focus', () => {
        lastFocusedVariation = field;
      });
    });
    root.querySelectorAll('[data-insert-token]').forEach((button) => {
      button.addEventListener('click', () => {
        const field = lastFocusedVariation ?? root.querySelector('textarea[name="variations"]');
        if (!field) return;
        const token = button.dataset.insertToken;
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? field.value.length;
        field.setRangeText(token, start, end, 'end');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
      });
    });
  }

  // "Adicionar (mensagem automática)": acrescenta o rodapé recomendado ao Direct, sem duplicar.
  function setupAppendButtons(root) {
    root.querySelectorAll('[data-append-text]').forEach((button) => {
      const field = root.querySelector('#dmText');
      if (!field) return;
      const text = button.dataset.appendText;
      const sync = () => {
        button.disabled = field.value.toLowerCase().includes(text.toLowerCase());
      };
      button.addEventListener('click', () => {
        const base = field.value.replace(/\s+$/, '');
        field.value = base ? `${base}\n\n${text}` : text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      });
      field.addEventListener('input', sync);
      sync();
    });
  }

  // Mostra as palavras-chave como etiquetas enquanto ela digita (o campo continua sendo texto com vírgulas).
  function setupKeywordChips(root) {
    const field = root.querySelector('input[name="keywords"]');
    const chips = root.querySelector('[data-keyword-chips]');
    if (!field || !chips) return;
    const update = () => {
      const words = [...new Set(field.value.split(',').map((w) => w.trim()).filter(Boolean))];
      chips.replaceChildren(
        ...words.map((word) => {
          const chip = document.createElement('span');
          chip.className = 'inline-flex max-w-full items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium leading-5 text-secondary-foreground [overflow-wrap:anywhere]';
          chip.textContent = word;
          return chip;
        }),
      );
    };
    field.addEventListener('input', update);
    update();
  }

  function setupPreview(root) {
    const preview = root.querySelector('[data-reply-preview]');
    if (!preview) return;
    const fields = () => [...root.querySelectorAll('textarea[name="variations"]')];
    const update = () => {
      const first = fields().map((f) => f.value.trim()).find(Boolean);
      // Igual ao renderReply do servidor: preserva quebras de linha, só colapsa espaços/tabs repetidos.
      preview.textContent = first
        ? first.replace(/\{usuario\}/gi, '@maria').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
        : 'Escreva uma versão para ver a prévia.';
      preview.classList.toggle('text-muted-foreground', !first);
    };
    root.addEventListener('input', (event) => {
      if (event.target instanceof HTMLTextAreaElement && event.target.name === 'variations') update();
    });
    update();
  }

  // Interruptor das automações: muda na hora (otimista) e volta se o servidor recusar.
  // O card inteiro reage ao aria-checked via CSS; a resposta do htmx troca o card pelo estado real.
  function isSwitch(element) {
    return element instanceof Element && element.getAttribute('role') === 'switch';
  }
  function flip(element) {
    element.setAttribute('aria-checked', element.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  }
  document.addEventListener('htmx:beforeRequest', (event) => {
    if (isSwitch(event.detail.elt)) flip(event.detail.elt);
  });
  document.addEventListener('htmx:afterRequest', (event) => {
    const element = event.detail.elt;
    if (isSwitch(element) && !event.detail.successful && element.isConnected) flip(element);
  });

  function init(root) {
    setupByteCounters(root);
    setupInsertButtons(root);
    setupAppendButtons(root);
    setupKeywordChips(root);
    setupPreview(root);
  }

  document.addEventListener('DOMContentLoaded', () => init(document));
})();
