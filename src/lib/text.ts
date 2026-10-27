/** Minúsculas, sem acentos e com espaços colapsados. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Retorna a primeira palavra-chave (no formato original) encontrada no texto como palavra ou frase inteira,
 * ignorando maiúsculas e acentos. Ex.: "link" casa com "Me manda o LINK!" mas não com "linkedin".
 */
export function findMatchingKeyword(text: string, keywords: readonly string[]): string | null {
  const haystack = normalizeText(text);
  for (const keyword of keywords) {
    const needle = normalizeText(keyword);
    if (!needle) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}_])`, 'u');
    if (pattern.test(haystack)) return keyword;
  }
  return null;
}

/** Substitui {usuario} por @username (ou remove o marcador se o username for desconhecido). */
export function renderReply(template: string, username: string | null | undefined): string {
  const mention = username ? `@${username}` : '';
  return template.replace(/\{usuario\}/gi, mention).replace(/\s{2,}/g, ' ').trim();
}

/** Sorteia um índice diferente do último usado (quando houver mais de uma opção). */
export function pickVariationIndex(count: number, lastIndex: number | null, random: () => number): number {
  if (count <= 0) throw new Error('Nenhuma variação cadastrada');
  if (count === 1) return 0;
  const candidates = [...Array(count).keys()].filter((index) => index !== lastIndex);
  return candidates[Math.floor(random() * candidates.length)] ?? 0;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Divide palavras-chave digitadas separadas por vírgula ou quebra de linha, sem duplicatas. */
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw.split(/[,\n]/)) {
    const keyword = item.trim().replace(/\s+/g, ' ');
    const key = normalizeText(keyword);
    if (keyword && !seen.has(key)) {
      seen.add(key);
      result.push(keyword);
    }
  }
  return result;
}
