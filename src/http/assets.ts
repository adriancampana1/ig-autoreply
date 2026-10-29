import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ASSETS_DIR = new URL('../../public/assets/', import.meta.url);
const VERSIONED_FILES = ['app.css', 'app.js', 'htmx.min.js'];

/**
 * Versão dos arquivos estáticos, calculada uma vez ao subir: hash do conteúdo de CSS/JS. Muda a cada build que
 * altera os arquivos, então o navegador busca a versão nova mesmo com o cache de 7 dias.
 */
function computeAssetVersion(): string {
  const hash = createHash('sha256');
  for (const file of VERSIONED_FILES) {
    try {
      hash.update(readFileSync(new URL(file, ASSETS_DIR)));
    } catch {
      hash.update(`ausente:${file}`); // ex.: CSS ainda não gerado no desenvolvimento
    }
  }
  return hash.digest('hex').slice(0, 10);
}

export const ASSET_VERSION = computeAssetVersion();

/** URL de um arquivo em /assets com a versão para cache-busting (ex.: /assets/app.css?v=1a2b3c4d5e). */
export function assetUrl(file: string): string {
  return `/assets/${file}?v=${ASSET_VERSION}`;
}
