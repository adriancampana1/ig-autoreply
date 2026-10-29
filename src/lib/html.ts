/** HTML já seguro (escapado ou confiável). */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(String(value));
}

/** Template seguro: toda interpolação é escapada, exceto SafeHtml (ex.: outro `html`), arrays são concatenados. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += renderValue(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** Use apenas para conteúdo confiável (ex.: SVG de ícones do próprio projeto). */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}
