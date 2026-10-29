import { parseKeywords, utf8ByteLength } from '../lib/text.js';
import type { AutomationFormValues, FormErrors } from './views/automationPages.js';

export const LIMITS = {
  maxKeywords: 10,
  maxKeywordLength: 50,
  minVariations: 3,
  maxVariations: 10,
  maxVariationLength: 300,
  maxDmBytes: 1000,
} as const;

export interface ValidAutomationInput {
  accountId: number;
  mediaId: string;
  keywords: string[];
  publicVariations: string[];
  dmText: string;
}

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];

/** Navegadores enviam quebras de linha de textarea como CRLF; guardamos só LF. */
const normalizeNewlines = (value: string): string => value.replace(/\r\n?/g, '\n');

/** Lê o corpo do formulário (como enviado pelo navegador) em valores para re-exibir. */
export function readAutomationForm(body: Record<string, unknown>): AutomationFormValues {
  const accountId = Number(body.accountId);
  return {
    accountId: Number.isInteger(accountId) && accountId > 0 ? accountId : undefined,
    mediaId: typeof body.mediaId === 'string' && /^\d+$/.test(body.mediaId) ? body.mediaId : undefined,
    keywords: typeof body.keywords === 'string' ? body.keywords : '',
    variations: asArray(body.variations).map(normalizeNewlines),
    dmText: typeof body.dmText === 'string' ? normalizeNewlines(body.dmText).trim() : '',
  };
}

/** Regras da spec §8.2: ≥ 1 palavra-chave, ≥ 3 variações, DM ≤ 1000 bytes. */
export function validateAutomationForm(
  values: AutomationFormValues,
): { ok: true; data: ValidAutomationInput } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const keywords = parseKeywords(values.keywords);
  const variations = values.variations.map((v) => normalizeNewlines(v).trim()).filter(Boolean);
  const dmText = normalizeNewlines(values.dmText);

  if (!values.accountId) errors.account = 'Escolha a conta.';
  if (!values.mediaId) errors.media = 'Escolha o post.';
  if (keywords.length === 0) errors.keywords = 'Informe pelo menos uma palavra-chave.';
  else if (keywords.length > LIMITS.maxKeywords) errors.keywords = `Use no máximo ${LIMITS.maxKeywords} palavras-chave.`;
  else if (keywords.some((k) => k.length > LIMITS.maxKeywordLength)) errors.keywords = 'Cada palavra-chave pode ter até 50 caracteres.';

  if (variations.length < LIMITS.minVariations) errors.variations = 'Escreva pelo menos 3 versões diferentes da resposta.';
  else if (variations.length > LIMITS.maxVariations) errors.variations = `Use no máximo ${LIMITS.maxVariations} versões.`;
  else if (new Set(variations.map((v) => v.toLowerCase())).size !== variations.length) errors.variations = 'As versões precisam ser diferentes entre si.';
  else if (variations.some((v) => v.length > LIMITS.maxVariationLength)) errors.variations = 'Cada versão pode ter até 300 caracteres.';

  if (!dmText) errors.dmText = 'Escreva a mensagem do Direct.';
  else if (utf8ByteLength(dmText) > LIMITS.maxDmBytes) errors.dmText = 'A mensagem do Direct está longa demais. Encurte um pouco.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: { accountId: values.accountId!, mediaId: values.mediaId!, keywords, publicVariations: variations, dmText },
  };
}
