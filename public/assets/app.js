// Melhorias progressivas do formulário de automação (o painel funciona sem JS; isto só ajuda).
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
    };
    root.addEventListener('input', (event) => {
      if (event.target instanceof HTMLTextAreaElement && event.target.name === 'variations') update();
    });
    update();
  }

  function init(root) {
    setupByteCounters(root);
    setupInsertButtons(root);
    setupPreview(root);
  }

  document.addEventListener('DOMContentLoaded', () => init(document));
})();
