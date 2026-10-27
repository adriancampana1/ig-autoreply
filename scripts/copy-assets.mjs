import { copyFileSync, mkdirSync } from 'node:fs';

// Copia o htmx para ser servido pelo próprio app (CSP 'self', sem CDN).
mkdirSync('public/assets', { recursive: true });
copyFileSync('node_modules/htmx.org/dist/htmx.min.js', 'public/assets/htmx.min.js');
console.log('assets copiados');
