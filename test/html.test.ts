import { describe, expect, it } from 'vitest';
import { html, raw } from '../src/lib/html.js';

describe('html', () => {
  it('escapa interpolações por padrão', () => {
    const name = '<script>alert("x")</script>';
    expect(html`<p>${name}</p>`.value).toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  });

  it('não reescapa fragmentos html, junta arrays e omite null/undefined/false', () => {
    const items = ['a', 'b'].map((item) => html`<li>${item}</li>`);
    expect(html`<ul>${items}</ul>${null}${undefined}${false}${0}`.value).toBe('<ul><li>a</li><li>b</li></ul>0');
  });

  it('raw insere conteúdo confiável sem escapar', () => {
    expect(html`<i>${raw('<svg></svg>')}</i>`.value).toBe('<i><svg></svg></i>');
  });
});
