// Captura as telas do painel (mobile claro + desktop escuro) para revisão visual.
// Uso: BASE_URL=http://localhost:3000 LOGIN_EMAIL=... LOGIN_PASSWORD=... node scripts/screenshots.mjs
// Requer: npm i -D playwright && npx playwright install chromium
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:3000';
const out = process.env.OUT_DIR ?? 'screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const problems = [];
for (const [name, viewport, colorScheme] of [
  ['mobile', { width: 390, height: 844 }, 'light'],
  ['desktop', { width: 1280, height: 860 }, 'dark'],
]) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  page.on('console', (msg) => msg.type() === 'error' && problems.push(`${name}: ${msg.text()}`));
  await page.goto(`${base}/entrar`);
  await page.screenshot({ path: `${out}/${name}-entrar.png` });
  await page.fill('#email', process.env.LOGIN_EMAIL ?? '');
  await page.fill('#password', process.env.LOGIN_PASSWORD ?? '');
  await page.click('button[type=submit], form[action="/entrar"] button');
  await page.waitForURL('**/automacoes');
  for (const path of ['/automacoes', '/automacoes/nova', '/atividade', '/contas']) {
    await page.goto(`${base}${path}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${name}${path.replaceAll('/', '-')}.png`, fullPage: true });
  }
  await context.close();
}
await browser.close();
console.log(`Screenshots em ${out}/`);
if (problems.length) console.log('Erros no console do navegador:\n' + problems.join('\n'));
