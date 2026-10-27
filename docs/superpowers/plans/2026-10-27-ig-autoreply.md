# ig-autoreply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automação própria (sem Manychat) que responde comentários com palavra-chave nos posts das contas Instagram do casal — resposta pública com variações + uma DM (*private reply*) — seguindo a documentação oficial da Meta (Graph API v26.0), com um painel simples, mobile-first, para uma usuária não técnica.

**Architecture:** Um único serviço Node.js 24 + TypeScript (Fastify) em um container Docker atrás do Nginx da VPS. Webhooks `comments` (assinatura HMAC) e um reconciliador periódico alimentam um *matcher* que grava interações e jobs no SQLite; um worker executa os jobs com ritmo humano, retentativas e disjuntor de segurança. O painel é renderizado no servidor (templates `html` com escape + htmx + Tailwind no estilo shadcn/ui).

**Tech Stack:** Node.js 24 LTS · TypeScript 7 · Fastify 5 (+ @fastify/helmet, formbody, secure-session, static) · better-sqlite3 · zod 4 · @node-rs/argon2 · htmx 2 · Tailwind CSS 4 · lucide-static · Vitest 5 · Docker Compose · Nginx + Certbot.

**Spec:** `docs/superpowers/specs/2026-10-27-ig-autoreply-design.md` (leia antes de começar; este plano a implementa).

> **Validação deste plano:** todo o código abaixo foi executado antes de ser escrito aqui. O estado acumulado após **cada** task compila (`tsc` com `strict`, `noUnusedLocals`) e passa nos testes; o build de produção sobe, responde ao healthcheck e foi exercitado no navegador (Playwright, CSP ativa); a imagem Docker foi construída e executada (Node 24.22, root read-only).

## Global Constraints

- Graph API: host `https://graph.instagram.com`, versão em `GRAPH_API_VERSION` (padrão `v26.0`), token em `Authorization: Bearer`; `/access_token` e `/refresh_access_token` sem prefixo de versão.
- Permissões: somente `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`. Webhook: somente o campo `comments`.
- Regras da Meta: 1 *private reply* por comentário, em até 7 dias; não responder comentário oculto; ignorar comentários da própria conta; sem follow-ups/DMs não solicitadas.
- Anti-spam: resposta pública 15–90 s após o comentário; DM 3–10 s depois; ≥ 8 s entre ações da mesma conta; teto `MAX_ACTIONS_PER_HOUR` (200); ≥ 3 variações; 1 resposta + 1 DM por pessoa por post; pausa de 24 h ao sinal de abuso (código 368).
- Segurança: HMAC `X-Hub-Signature-256` sobre o corpo **bruto**; CSRF em todo POST do painel; tokens com AES-256-GCM; argon2id; CSP `default-src 'self'` — **sem JS/CSS inline nem CDNs** (htmx e app.js servidos de `/assets`).
- Retenção: `webhook_events` 30 dias; `interactions`/`jobs` 90 dias.
- Node ≥ 24; ESM (`"type": "module"`), imports relativos com sufixo `.js`; TypeScript `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`.
- UI: em português simples, mobile-first (390 px), alvos de toque ≥ 44 px, contraste AA nos temas claro/escuro, estilo shadcn/ui; **o polimento visual é obrigatoriamente feito com a skill `impeccable`** (Task 15).
- Datas exibidas em `America/Sao_Paulo`.

## Desvios conscientes da spec (decididos durante a validação do código)

| Spec | Neste plano | Motivo |
|---|---|---|
| §5.2 `@fastify/rate-limit` no login | Limitador próprio (`src/panel/loginThrottle.ts`, 5 falhas/15 min por IP) | Conta só falhas e permite mostrar a mensagem na própria tela de login; uma dependência a menos |
| §5.2 `@kitajs/html` | Template `html` próprio com escape automático (`src/lib/html.ts`) | Escape por padrão (no KitaJS é opt-in por atributo, fácil de esquecer → XSS) |
| §7 `status` único com `messaging_disabled` | Flag `messaging_disabled` separada do `status` | Com DMs bloqueadas a conta continua respondendo em público |
| §7 `webhook_events.signature_ok` | Removido | Eventos com assinatura inválida são rejeitados (403) e não são gravados |
| §7/§8.2 miniatura e foto do perfil | Proxy `/midia/:conta/:post` com cache de URL em memória; avatar com iniciais | URLs do CDN do Instagram expiram e podem ter CORP restritivo; mantém a CSP em `img-src 'self'` |
| §13 build com toolchain de compilação | `npm ci --ignore-scripts` sem toolchain | Os módulos nativos já trazem binários; não executar scripts de instalação reduz risco de supply chain (validado em Node 24.22) |

## Estrutura de arquivos

```
ig-autoreply/
├── package.json · tsconfig.json · tsconfig.build.json · vitest.config.ts · .env.example · .gitignore · .dockerignore
├── Dockerfile · docker-compose.yml
├── deploy/nginx/dm.adriancampana.cloud.conf · deploy/backup.sh
├── docs/DEPLOY.md · docs/APP_REVIEW.md · docs/GUIA_DE_USO.md · docs/superpowers/{specs,plans}/
├── public/assets/app.js            (fonte: melhorias progressivas do formulário)
├── public/assets/{app.css,htmx.min.js}   (gerados no build — ignorados no git)
├── scripts/copy-assets.mjs · scripts/seed-demo.mjs · scripts/screenshots.mjs
├── src/
│   ├── config.ts                   validação do .env (zod)
│   ├── server.ts                   composição: banco, cliente, app, agendador, shutdown
│   ├── app.ts                      Fastify + plugins + registro das áreas
│   ├── cli/users.ts                criar/resetar usuário do painel (senha gerada)
│   ├── db/database.ts · db/migrations.ts
│   ├── db/repos/                   accounts · automations · interactions · jobs · users · webhookEvents · deletionRequests
│   ├── lib/                        crypto (AES-GCM, HMAC, signed_request) · text (palavras-chave) · html (escape)
│   ├── instagram/                  client (Graph API) · oauth (Business Login) · errors (tabela §9)
│   ├── webhooks/                   parsePayload · routes (GET verify / POST eventos)
│   ├── engine/                     pacing · matcher · worker · reconciler · maintenance · scheduler
│   ├── http/                       session (CSRF/flash) · redirect (htmx)
│   ├── accounts/connect.ts         conclusão do Business Login
│   ├── media/thumbnails.ts         proxy de miniaturas (CDN do Instagram)
│   ├── public/                     privacidade · desautorização · exclusão de dados · healthz
│   └── panel/                      context · register · loginThrottle · automationForm · styles.css · routes/* · views/*
└── test/                           *.test.ts + helpers/ (db, app, fakeFetch, fakeInstagram)
```

## Visão geral

| Task | Quem | Entrega | Depende de |
|---|---|---|---|
| 0 | vocês | Burocracia Meta e DNS iniciados (**começar hoje**) | — |
| 1–9 | dev | Núcleo testado: config, banco, utilitários, cliente Meta, repositórios, parser, matcher, worker, reconciliação/manutenção | — |
| 10–13 | dev | HTTP: webhook + páginas públicas; painel (login/contas, automações, atividade) | 1–9 |
| 14 | dev | Servidor executável + CLI de usuários (smoke test local) | 10–13 |
| 15 | dev | Polimento visual com a skill **impeccable** | 14 |
| 16 | dev | Docker + deploy em `dm.adriancampana.cloud` | 14 |
| 17 | vocês + dev | App configurado na Meta + testes reais em modo Desenvolvimento | 0, 16 |
| 18 | vocês + dev | Verificação de Negócio concluída + App Review | 17 |
| 19 | vocês + dev | Go-live (app Live) + entrega do guia à usuária | 18 |

---

### Task 0: Pré-requisitos na Meta e DNS (humanos — começar hoje, em paralelo)

A Verificação de Negócio é o caminho crítico (pode levar dias). Nada aqui depende de código.

- [ ] **Step 1: Portfólio empresarial + Verificação de Negócio** — em https://business.facebook.com crie (ou use) o portfólio com o **CNPJ**. Em *Configurações do negócio › Central de segurança*, inicie a **Verificação de Negócio** (cartão CNPJ, comprovante de endereço/telefone em nome da empresa). Recomendado: **verificar o domínio** `adriancampana.cloud` (registro DNS TXT) no mesmo portfólio.
- [ ] **Step 2: Conta de desenvolvedor** — em https://developers.facebook.com registre-se como desenvolvedor (mesma conta do Facebook que administra o portfólio).
- [ ] **Step 3: Criar o app** — *Create App* › caso de uso **Other** › tipo **Business** › nome (ex.: "Respostas Automáticas") › conecte ao portfólio (*App settings › Basic*). Adicione o produto **Instagram** › *API setup with Instagram login*.
- [ ] **Step 4: Contas como testers** — em *Instagram › API setup with Instagram login › Generate access tokens › Add account*, adicione cada conta (devem ser **profissionais e públicas**) e aceite o convite.
- [ ] **Step 5: DMs liberadas** — em cada conta, no app do Instagram: *Configurações › Mensagens e respostas a stories › Ferramentas conectadas › Permitir acesso a mensagens* = ligado.
- [ ] **Step 6: DNS** — registro `A` de `dm.adriancampana.cloud` para o IP da VPS (detalhes em `docs/DEPLOY.md`, Task 16).

---

### Task 1: Fundação do projeto e configuração (.env validado)

**Objetivo:** Criar o repositório, instalar dependências e validar o `.env` com zod: o app recusa subir com configuração inválida.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Test: `test/config.test.ts`
- Create: `src/config.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` e `type Config` (`src/config.ts`). Campos: `NODE_ENV`, `PORT`, `APP_BASE_URL` (sem `/` final), `CONTACT_EMAIL`, `DATABASE_PATH`, `IG_APP_ID`, `IG_APP_SECRET`, `META_APP_SECRET`, `META_WEBHOOK_SECRETS: string[]` (padrão: `[META_APP_SECRET, IG_APP_SECRET]`), `WEBHOOK_VERIFY_TOKEN`, `GRAPH_API_VERSION` (`v26.0`), `ENCRYPTION_KEY`/`SESSION_SECRET` (base64 de 32 bytes), `IG_ALLOWED_USERNAMES: string[]` (minúsculas, sem @), `REVIEW_MODE: boolean`, `MAX_ACTIONS_PER_HOUR: number` (200).

- [ ] **Step 0: Criar o repositório e instalar dependências**

```bash
mkdir -p ~/ig-autoreply && cd ~/ig-autoreply && git init
# copie a spec e este plano para docs/superpowers/ (se ainda não estiverem aqui)
```

Crie os arquivos de configuração abaixo (`package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`, `.env.example`) e rode:

```bash
npm install
npx tsc --version   # Version 7.x
```

`package.json`:

```json
{
  "name": "ig-autoreply",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "dev": "tsx watch --env-file=.env src/server.ts",
    "dev:css": "tailwindcss -i src/panel/styles.css -o public/assets/app.css --watch",
    "build": "npm run build:css && npm run build:assets && tsc -p tsconfig.build.json",
    "build:css": "tailwindcss -i src/panel/styles.css -o public/assets/app.css --minify",
    "build:assets": "node scripts/copy-assets.mjs",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "user:create": "node dist/cli/users.js create",
    "user:reset-password": "node dist/cli/users.js reset-password"
  },
  "dependencies": {
    "@fastify/formbody": "^9.0.1",
    "@fastify/helmet": "^13.2.0",
    "@fastify/secure-session": "^8.4.1",
    "@fastify/static": "^10.1.8",
    "@node-rs/argon2": "^2.2.2",
    "better-sqlite3": "^13.0.3",
    "fastify": "^5.12.7",
    "htmx.org": "^2.0.11",
    "lucide-static": "^1.62.0",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@tailwindcss/cli": "^4.3.3",
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^24.19.2",
    "tailwindcss": "^4.3.3",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2",
    "vitest": "^5.0.5"
  }
}
```


`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test", "scripts", "vitest.config.ts"]
}
```


`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src"]
}
```


`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```


`.gitignore`:

```
node_modules/
dist/
data/
data-demo/
screenshots/
public/assets/app.css
public/assets/htmx.min.js
.env
.env.*
!.env.example
```


`.env.example`:

```bash
# Copie para .env (chmod 600) e preencha. Nunca faça commit do .env.
APP_BASE_URL=https://dm.adriancampana.cloud
CONTACT_EMAIL=contato@adriancampana.cloud

# App Dashboard › Instagram › API setup with Instagram login › Business login settings
IG_APP_ID=
IG_APP_SECRET=
# App Dashboard › App settings › Basic › App secret
META_APP_SECRET=
# Opcional: segredos aceitos na assinatura do webhook (vírgula). Vazio = META_APP_SECRET e IG_APP_SECRET.
# Depois de confirmar qual assina (botão "Test" no painel da Meta), deixe só o correto.
META_WEBHOOK_SECRETS=
# String aleatória (openssl rand -hex 24) — a mesma vai no campo "Verify token" do painel da Meta
WEBHOOK_VERIFY_TOKEN=

GRAPH_API_VERSION=v26.0
# Gere cada uma com: openssl rand -base64 32
ENCRYPTION_KEY=
SESSION_SECRET=

# Contas que podem ser conectadas (sem @, separadas por vírgula)
IG_ALLOWED_USERNAMES=
# true SOMENTE durante o App Review (libera a conta de teste do revisor)
REVIEW_MODE=false
MAX_ACTIONS_PER_HOUR=200
```


- [ ] **Step 1: Escrever os testes (falhando)**

`test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

const baseEnv = {
  APP_BASE_URL: 'https://dm.adriancampana.cloud/',
  CONTACT_EMAIL: 'contato@adriancampana.cloud',
  IG_APP_ID: '123',
  IG_APP_SECRET: 'ig-secret',
  META_APP_SECRET: 'meta-secret',
  WEBHOOK_VERIFY_TOKEN: 'a-very-long-verify-token',
  ENCRYPTION_KEY: KEY,
  SESSION_SECRET: KEY,
};

describe('loadConfig', () => {
  it('aplica valores padrão e normaliza listas', () => {
    const config = loadConfig({ ...baseEnv, IG_ALLOWED_USERNAMES: ' @Loja.Um , loja_dois ,' });
    expect(config.APP_BASE_URL).toBe('https://dm.adriancampana.cloud');
    expect(config.GRAPH_API_VERSION).toBe('v26.0');
    expect(config.PORT).toBe(3000);
    expect(config.REVIEW_MODE).toBe(false);
    expect(config.MAX_ACTIONS_PER_HOUR).toBe(200);
    expect(config.IG_ALLOWED_USERNAMES).toEqual(['loja.um', 'loja_dois']);
  });

  it('usa os dois segredos para webhook quando META_WEBHOOK_SECRETS está vazio', () => {
    const config = loadConfig(baseEnv);
    expect(config.META_WEBHOOK_SECRETS).toEqual(['meta-secret', 'ig-secret']);
  });

  it('respeita META_WEBHOOK_SECRETS explícito sem alterar maiúsculas', () => {
    const config = loadConfig({ ...baseEnv, META_WEBHOOK_SECRETS: 'AbC' });
    expect(config.META_WEBHOOK_SECRETS).toEqual(['AbC']);
  });

  it('lança erro legível quando falta variável ou a chave tem tamanho errado', () => {
    expect(() => loadConfig({ ...baseEnv, IG_APP_ID: '' })).toThrow(/IG_APP_ID/);
    expect(() => loadConfig({ ...baseEnv, ENCRYPTION_KEY: 'curta' })).toThrow(/32 bytes/);
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/config.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/config.ts`:

```ts
import { z } from 'zod';

const list = (lowercase: boolean) =>
  z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .map((item) => (lowercase ? item.replace(/^@/, '').toLowerCase() : item))
        .filter((item) => item.length > 0),
    );

const key32 = z
  .string()
  .refine((value) => Buffer.from(value, 'base64').length === 32, {
    message: 'deve ter exatamente 32 bytes codificados em base64 (gere com: openssl rand -base64 32)',
  });

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.url().transform((value) => value.replace(/\/+$/, '')),
  CONTACT_EMAIL: z.email(),
  DATABASE_PATH: z.string().min(1).default('./data/app.db'),
  IG_APP_ID: z.string().min(1),
  IG_APP_SECRET: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_WEBHOOK_SECRETS: list(false),
  WEBHOOK_VERIFY_TOKEN: z.string().min(16),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  ENCRYPTION_KEY: key32,
  SESSION_SECRET: key32,
  IG_ALLOWED_USERNAMES: list(true),
  REVIEW_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MAX_ACTIONS_PER_HOUR: z.coerce.number().int().positive().default(200),
});

export type Config = z.output<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuração inválida no .env:\n${problems}`);
  }
  const config = parsed.data;
  if (config.META_WEBHOOK_SECRETS.length === 0) {
    // A doc da Meta diz apenas "App Secret"; aceitamos os dois até confirmar qual assina (spec §15).
    config.META_WEBHOOK_SECRETS = [config.META_APP_SECRET, config.IG_APP_SECRET];
  }
  return config;
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  4 passed (4)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore .env.example test/config.test.ts src/config.ts package-lock.json
git commit -m "chore: base do projeto e validação do .env"
```

---

### Task 2: Banco SQLite e migrações

**Objetivo:** Abrir o SQLite (WAL, foreign keys) e aplicar migrações versionadas de forma idempotente.

**Files:**
- Test: `test/db.test.ts`
- Create: `src/db/migrations.ts`
- Create: `src/db/database.ts`

**Interfaces:**
- Produces: `type DB`, `openDatabase(path: string): DB` (aceita `':memory:'`), `migrate(db: DB): void`.
- Tabelas: `users`, `ig_accounts`, `automations`, `webhook_events`, `interactions`, `jobs`, `deletion_requests`, `schema_migrations`.
- Refinamentos em relação à spec §7: `ig_accounts.messaging_disabled` é uma flag separada (a conta continua respondendo em público); `app_user_id` guarda o ID escopado do app (usado no `signed_request`); `automations.last_reconciled_at` para o reconciler; sem coluna de miniatura (as URLs do CDN expiram — ver Task 11).

- [ ] **Step 1: Escrever os testes (falhando)**

`test/db.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database.js';

describe('database', () => {
  it('aplica as migrações e é idempotente', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(['users', 'ig_accounts', 'automations', 'webhook_events', 'interactions', 'jobs', 'deletion_requests']),
    );
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(versions.n).toBe(1);
  });

  it('liga as chaves estrangeiras', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/db.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/db/migrations.ts`:

```ts
// Migrações versionadas. Nunca edite uma migração já aplicada em produção: crie uma nova.
export const migrations: readonly string[] = [
  /* 001 — esquema inicial */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE ig_accounts (
    id INTEGER PRIMARY KEY,
    ig_id TEXT NOT NULL UNIQUE,
    app_user_id TEXT,
    username TEXT NOT NULL,
    profile_picture_url TEXT,
    token_enc TEXT,
    token_expires_at INTEGER,
    token_refreshed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'ok'
      CHECK (status IN ('ok', 'reconnect_required', 'paused_by_safety', 'disconnected')),
    messaging_disabled INTEGER NOT NULL DEFAULT 0,
    paused_until INTEGER,
    last_error TEXT,
    connected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE automations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    media_type TEXT,
    media_permalink TEXT,
    media_caption TEXT,
    keywords_json TEXT NOT NULL,
    public_variations_json TEXT NOT NULL,
    dm_text TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_variation_index INTEGER,
    last_reconciled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (account_id, media_id)
  );

  CREATE TABLE webhook_events (
    id INTEGER PRIMARY KEY,
    received_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX idx_webhook_events_received ON webhook_events(received_at);

  CREATE TABLE interactions (
    id INTEGER PRIMARY KEY,
    automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    comment_id TEXT NOT NULL UNIQUE,
    commenter_igsid TEXT NOT NULL,
    commenter_username TEXT,
    comment_text TEXT,
    matched_keyword TEXT,
    source TEXT NOT NULL CHECK (source IN ('webhook', 'reconciler')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'done', 'partial', 'failed', 'skipped')),
    skip_reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_interactions_person ON interactions(automation_id, commenter_igsid);
  CREATE INDEX idx_interactions_created ON interactions(created_at);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('public_reply', 'private_reply')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_at INTEGER NOT NULL,
    fail_reason TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    result_id TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (interaction_id, type)
  );
  CREATE INDEX idx_jobs_due ON jobs(status, run_at);
  CREATE INDEX idx_jobs_account ON jobs(account_id, status, updated_at);

  CREATE TABLE deletion_requests (
    code TEXT PRIMARY KEY,
    app_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];
```


`src/db/database.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  migrations.forEach((sql, index) => {
    const version = index + 1;
    if (version <= applied.v) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    })();
  });
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  6 passed (6)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/db.test.ts src/db/migrations.ts src/db/database.ts
git commit -m "feat(db): esquema inicial e migrações"
```

---

### Task 3: Utilitários: criptografia, texto e HTML seguro

**Objetivo:** Funções puras: AES-256-GCM para tokens, validação de assinaturas da Meta, normalização/casamento de palavras-chave e template HTML com escape automático.

**Files:**
- Test: `test/crypto.test.ts`
- Test: `test/text.test.ts`
- Test: `test/html.test.ts`
- Create: `src/lib/crypto.ts`
- Create: `src/lib/text.ts`
- Create: `src/lib/html.ts`

**Interfaces:**
- Produces (`src/lib/crypto.ts`): `createTokenCipher(base64Key): TokenCipher` (`encrypt/decrypt`), `verifyHubSignature(rawBody: Buffer, header: string|undefined, secrets: readonly string[]): boolean`, `parseSignedRequest(signedRequest: string, secrets: readonly string[]): SignedRequestPayload|null` (`user_id` sempre string), `randomToken(bytes = 32): string`.
- Produces (`src/lib/text.ts`): `normalizeText`, `findMatchingKeyword(text, keywords): string|null`, `renderReply(template, username)`, `pickVariationIndex(count, lastIndex, random)`, `utf8ByteLength`, `parseKeywords(raw): string[]`.
- Produces (`src/lib/html.ts`): `class SafeHtml`, `html` (tagged template com escape), `raw(value)`, `escapeHtml`.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/crypto.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTokenCipher, parseSignedRequest, randomToken, verifyHubSignature } from '../src/lib/crypto.js';

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('createTokenCipher', () => {
  it('criptografa e descriptografa (ida e volta) com IV aleatório', () => {
    const cipher = createTokenCipher(KEY);
    const a = cipher.encrypt('IGQVJ-token');
    const b = cipher.encrypt('IGQVJ-token');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('IGQVJ-token');
  });

  it('rejeita texto adulterado', () => {
    const cipher = createTokenCipher(KEY);
    const data = Buffer.from(cipher.encrypt('segredo'), 'base64');
    data[data.length - 1] = data[data.length - 1]! ^ 0xff;
    expect(() => cipher.decrypt(data.toString('base64'))).toThrow();
  });
});

describe('verifyHubSignature', () => {
  const body = Buffer.from('{"object":"instagram","entry":[]}');
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('aceita assinatura feita com qualquer segredo da lista', () => {
    expect(verifyHubSignature(body, sign('s2'), ['s1', 's2'])).toBe(true);
  });

  it('rejeita assinatura inválida, ausente ou mal formatada', () => {
    expect(verifyHubSignature(body, sign('outro'), ['s1'])).toBe(false);
    expect(verifyHubSignature(body, undefined, ['s1'])).toBe(false);
    expect(verifyHubSignature(body, 'sha1=abc', ['s1'])).toBe(false);
    expect(verifyHubSignature(body, 'sha256=zz', ['s1'])).toBe(false);
  });
});

describe('parseSignedRequest', () => {
  const make = (payload: object, secret: string) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${sig}.${encoded}`;
  };

  it('decodifica um signed_request válido', () => {
    const req = make({ algorithm: 'HMAC-SHA256', user_id: 12345, issued_at: 1 }, 'app-secret');
    expect(parseSignedRequest(req, ['x', 'app-secret'])).toMatchObject({ user_id: '12345' });
  });

  it('retorna null com assinatura errada ou formato inválido', () => {
    expect(parseSignedRequest(make({ algorithm: 'HMAC-SHA256', user_id: 1 }, 'a'), ['b'])).toBeNull();
    expect(parseSignedRequest('sem-ponto', ['b'])).toBeNull();
  });
});

describe('randomToken', () => {
  it('gera valores url-safe distintos', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});
```


`test/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  findMatchingKeyword,
  normalizeText,
  parseKeywords,
  pickVariationIndex,
  renderReply,
  utf8ByteLength,
} from '../src/lib/text.js';

describe('normalizeText', () => {
  it('remove acentos, baixa caixa e colapsa espaços', () => {
    expect(normalizeText('  Eu   QUERO  Promoção ')).toBe('eu quero promocao');
  });
});

describe('findMatchingKeyword', () => {
  const keywords = ['EU QUERO', 'link', 'preço'];

  it('casa frase inteira ignorando acentos e caixa', () => {
    expect(findMatchingKeyword('eu quero!!! 😍', keywords)).toBe('EU QUERO');
    expect(findMatchingKeyword('Qual o PRECO?', keywords)).toBe('preço');
    expect(findMatchingKeyword('me manda o Link', keywords)).toBe('link');
  });

  it('não casa dentro de outra palavra', () => {
    expect(findMatchingKeyword('me segue no linkedin', keywords)).toBeNull();
    expect(findMatchingKeyword('preçoso', keywords)).toBeNull();
  });

  it('ignora palavras-chave vazias e texto sem correspondência', () => {
    expect(findMatchingKeyword('lindo post', ['', '  '])).toBeNull();
    expect(findMatchingKeyword('lindo post', keywords)).toBeNull();
  });
});

describe('renderReply', () => {
  it('substitui {usuario} pela menção', () => {
    expect(renderReply('Oi {usuario}, te mandei no direct!', 'maria')).toBe('Oi @maria, te mandei no direct!');
  });

  it('remove o marcador quando não há username', () => {
    expect(renderReply('Oi {usuario} te mandei no direct!', null)).toBe('Oi te mandei no direct!');
  });
});

describe('pickVariationIndex', () => {
  it('nunca repete a última variação quando há alternativas', () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(pickVariationIndex(3, 1, () => r)).not.toBe(1);
    }
  });

  it('retorna 0 quando há apenas uma variação e falha sem variações', () => {
    expect(pickVariationIndex(1, 0, () => 0.5)).toBe(0);
    expect(() => pickVariationIndex(0, null, () => 0.5)).toThrow();
  });
});

describe('utf8ByteLength', () => {
  it('conta bytes, não caracteres', () => {
    expect(utf8ByteLength('ação')).toBe(6);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});

describe('parseKeywords', () => {
  it('separa por vírgula ou quebra de linha e remove duplicatas equivalentes', () => {
    expect(parseKeywords('EU QUERO, link\nLink ,  , preço')).toEqual(['EU QUERO', 'link', 'preço']);
  });
});
```


`test/html.test.ts`:

```ts
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
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/crypto.test.ts test/text.test.ts test/html.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/lib/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

export interface TokenCipher {
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

/** AES-256-GCM. Formato armazenado: base64(iv[12] | authTag[16] | ciphertext). */
export function createTokenCipher(base64Key: string): TokenCipher {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes');
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    decrypt(encoded) {
      const data = Buffer.from(encoded, 'base64');
      const decipher = createDecipheriv(ALGORITHM, key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Valida o cabeçalho X-Hub-Signature-256 (HMAC-SHA256 do corpo bruto) contra qualquer um dos segredos aceitos. */
export function verifyHubSignature(rawBody: Buffer, header: string | undefined, secrets: readonly string[]): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  if (received.length !== 32) return false;
  return secrets.some((secret) => safeEqual(createHmac('sha256', secret).update(rawBody).digest(), received));
}

export interface SignedRequestPayload {
  user_id: string;
  algorithm: string;
  issued_at?: number;
  [key: string]: unknown;
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Decodifica e valida um `signed_request` da Meta (callbacks de desautorização e exclusão de dados). */
export function parseSignedRequest(signedRequest: string, secrets: readonly string[]): SignedRequestPayload | null {
  const [encodedSig, encodedPayload] = signedRequest.split('.', 2);
  if (!encodedSig || !encodedPayload) return null;
  const signature = base64UrlDecode(encodedSig);
  const valid = secrets.some((secret) =>
    safeEqual(createHmac('sha256', secret).update(encodedPayload).digest(), signature),
  );
  if (!valid) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as SignedRequestPayload;
    if (payload.algorithm?.toUpperCase() !== 'HMAC-SHA256' || payload.user_id === undefined) return null;
    return { ...payload, user_id: String(payload.user_id) };
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
```


`src/lib/text.ts`:

```ts
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
```


`src/lib/html.ts`:

```ts
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
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  26 passed (26)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/crypto.test.ts test/text.test.ts test/html.test.ts src/lib/crypto.ts src/lib/text.ts src/lib/html.ts
git commit -m "feat(lib): criptografia, texto e html seguro"
```

---

### Task 4: Cliente da Graph API (Instagram Login), OAuth e classificação de erros

**Objetivo:** Isolar toda chamada HTTP à Meta (host, versão, token) em um cliente testável com `fetch` injetado, e centralizar a tabela de decisão de erros da spec §9.

**Files:**
- Test: `test/helpers/fakeFetch.ts`
- Test: `test/instagram-errors.test.ts`
- Test: `test/instagram-client.test.ts`
- Test: `test/instagram-oauth.test.ts`
- Create: `src/instagram/errors.ts`
- Create: `src/instagram/client.ts`
- Create: `src/instagram/oauth.ts`

**Interfaces:**
- Produces (`errors.ts`): `class GraphApiError(message, httpStatus, code?, subcode?, regainAccessMinutes?)`, `classifyError(error: unknown): ErrorClassification` com `kind ∈ 'auth'|'rate_limit'|'messaging_disabled'|'abuse'|'permanent'|'transient'`, `reason: FailReason`, `maxAttempts?`, `retryAfterMs?`, `code?`, `message`.
- Produces (`client.ts`): `type FetchFn`, `readGraphResponse<T>(response)`, `createInstagramClient({ version, fetch?, baseUrl?, timeoutMs? }): InstagramClient` com `getProfile(token)` → `{ igId (user_id), appUserId (id), username, profilePictureUrl?, accountType? }`, `listMedia(token, limit?)`, `getMedia(token, mediaId)`, `listComments(token, mediaId, after?)` → `{ comments: CommentItem[], nextCursor? }`, `replyToComment(token, commentId, message)` → `{ id }`, `sendPrivateReply(token, igId, commentId, text)` → `{ messageId }`, `subscribeToComments(token)`.
- Produces (`oauth.ts`): `REQUIRED_SCOPES`, `createInstagramOAuth({ appId, appSecret, redirectUri, fetch? }): InstagramOAuth` com `authorizeUrl(state)`, `exchangeCode(code)` → `{ accessToken, permissions }`, `exchangeForLongLived(short)` / `refresh(long)` → `{ accessToken, expiresInSec }`.
- Endpoints conferidos na doc v26.0 (spec §4.4).

- [ ] **Step 1: Escrever os testes (falhando)**

`test/helpers/fakeFetch.ts`:

```ts
export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeResponse {
  status?: number;
  json: unknown;
  headers?: Record<string, string>;
}

/** fetch falso: responde em ordem às respostas enfileiradas e grava as requisições feitas. */
export function createFakeFetch(responses: FakeResponse[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    requests.push({ url, method: init?.method ?? 'GET', headers, body });
    const next = queue.shift();
    if (!next) throw new Error(`Requisição inesperada: ${url}`);
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200, headers: next.headers });
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}
```


`test/instagram-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyError, GraphApiError } from '../src/instagram/errors.js';

const err = (code: number | undefined, message = 'x', status = 400, subcode?: number, regain?: number) =>
  new GraphApiError(message, status, code, subcode, regain);

describe('classifyError', () => {
  it('token inválido → auth', () => {
    expect(classifyError(err(190))).toMatchObject({ kind: 'auth', reason: 'token_invalid', code: '190' });
  });

  it('limites de chamada → rate_limit com espera da Meta ou 15 min', () => {
    expect(classifyError(err(80002, 'x', 400, undefined, 7))).toMatchObject({ kind: 'rate_limit', retryAfterMs: 7 * 60_000 });
    for (const code of [4, 17, 32, 613]) {
      expect(classifyError(err(code))).toMatchObject({ kind: 'rate_limit', retryAfterMs: 15 * 60_000 });
    }
  });

  it('bloqueio por abuso → abuse', () => {
    expect(classifyError(err(368))).toMatchObject({ kind: 'abuse', reason: 'abuse_blocked' });
    expect(classifyError(err(undefined, 'You are temporarily blocked'))).toMatchObject({ kind: 'abuse' });
  });

  it('DMs desativadas na conta → messaging_disabled', () => {
    const e = err(200, '(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.', 403);
    expect(classifyError(e)).toMatchObject({ kind: 'messaging_disabled' });
  });

  it('erros permanentes', () => {
    expect(classifyError(err(10, 'x', 400, 2534022))).toMatchObject({ kind: 'permanent', reason: 'window_expired' });
    expect(classifyError(err(100))).toMatchObject({ kind: 'permanent', reason: 'comment_unavailable' });
    expect(classifyError(err(10))).toMatchObject({ kind: 'permanent', reason: 'permission_denied' });
  });

  it('5xx e falhas de rede → transient com 5 tentativas; desconhecido → 2 tentativas', () => {
    expect(classifyError(err(undefined, 'x', 503))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
    expect(classifyError(new TypeError('fetch failed'))).toMatchObject({ kind: 'transient', maxAttempts: 5 });
    expect(classifyError(err(99999))).toMatchObject({ kind: 'transient', reason: 'unknown_error', maxAttempts: 2 });
  });
});
```


`test/instagram-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createInstagramClient } from '../src/instagram/client.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { createFakeFetch } from './helpers/fakeFetch.js';

const build = (responses: Parameters<typeof createFakeFetch>[0]) => {
  const fake = createFakeFetch(responses);
  return { client: createInstagramClient({ version: 'v26.0', fetch: fake.fetch }), requests: fake.requests };
};

describe('createInstagramClient', () => {
  it('getProfile usa user_id como igId e id como appUserId', async () => {
    const { client, requests } = build([
      { json: { id: '999', user_id: 17841400000000000, username: 'loja', account_type: 'Business' } },
    ]);
    const profile = await client.getProfile('TOKEN');
    expect(profile).toMatchObject({ igId: '17841400000000000', appUserId: '999', username: 'loja' });
    expect(requests[0]!.url.pathname).toBe('/v26.0/me');
    expect(requests[0]!.headers.authorization).toBe('Bearer TOKEN');
  });

  it('replyToComment envia POST JSON para /{comment_id}/replies', async () => {
    const { client, requests } = build([{ json: { id: '178' } }]);
    await expect(client.replyToComment('T', 'C1', 'Oi @ana')).resolves.toEqual({ id: '178' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url.pathname).toBe('/v26.0/C1/replies');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ message: 'Oi @ana' });
  });

  it('sendPrivateReply usa recipient.comment_id', async () => {
    const { client, requests } = build([{ json: { recipient_id: 'R', message_id: 'M' } }]);
    await expect(client.sendPrivateReply('T', 'IG1', 'C1', 'Link: https://x.y')).resolves.toEqual({ messageId: 'M' });
    expect(requests[0]!.url.pathname).toBe('/v26.0/IG1/messages');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ recipient: { comment_id: 'C1' }, message: { text: 'Link: https://x.y' } });
  });

  it('listComments mapeia autor e cursor de paginação', async () => {
    const { client, requests } = build([
      {
        json: {
          data: [{ id: 'c1', text: 'eu quero', timestamp: '2026-10-27T10:00:00+0000', from: { id: 'u1', username: 'ana' } }],
          paging: { cursors: { after: 'CUR' }, next: 'https://graph.instagram.com/next' },
        },
      },
    ]);
    const page = await client.listComments('T', 'M1', 'PREV');
    expect(page).toEqual({
      comments: [{ id: 'c1', text: 'eu quero', timestamp: '2026-10-27T10:00:00+0000', fromId: 'u1', fromUsername: 'ana', hidden: undefined }],
      nextCursor: 'CUR',
    });
    expect(requests[0]!.url.searchParams.get('after')).toBe('PREV');
  });

  it('subscribeToComments assina apenas o campo comments', async () => {
    const { client, requests } = build([{ json: { success: true } }]);
    await client.subscribeToComments('T');
    expect(requests[0]!.url.pathname).toBe('/v26.0/me/subscribed_apps');
    expect(requests[0]!.url.searchParams.get('subscribed_fields')).toBe('comments');
  });

  it('converte erro da Graph API em GraphApiError com tempo de espera', async () => {
    const { client } = build([
      {
        status: 400,
        json: { error: { message: 'Too many calls', code: 80002, error_subcode: 2207051 } },
        headers: { 'x-business-use-case-usage': JSON.stringify({ '1': [{ type: 'instagram', estimated_time_to_regain_access: 12 }] }) },
      },
    ]);
    const error = await client.replyToComment('T', 'C', 'm').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(error).toMatchObject({ code: 80002, subcode: 2207051, httpStatus: 400, regainAccessMinutes: 12 });
  });
});
```


`test/instagram-oauth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createInstagramOAuth, REQUIRED_SCOPES } from '../src/instagram/oauth.js';
import { createFakeFetch } from './helpers/fakeFetch.js';

const opts = { appId: 'APP', appSecret: 'SECRET', redirectUri: 'https://dm.example.com/auth/instagram/callback' };

describe('createInstagramOAuth', () => {
  it('monta a URL de autorização com as 3 permissões e o state', () => {
    const url = new URL(createInstagramOAuth(opts).authorizeUrl('STATE123'));
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('APP');
    expect(url.searchParams.get('redirect_uri')).toBe(opts.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(REQUIRED_SCOPES.join(','));
    expect(url.searchParams.get('state')).toBe('STATE123');
  });

  it('troca o code (removendo #_) e aceita resposta envolvida em data[]', async () => {
    const fake = createFakeFetch([
      { json: { data: [{ access_token: 'SHORT', user_id: '1', permissions: 'instagram_business_basic,instagram_business_manage_comments' }] } },
    ]);
    const oauth = createInstagramOAuth({ ...opts, fetch: fake.fetch });
    await expect(oauth.exchangeCode('ABC#_')).resolves.toEqual({
      accessToken: 'SHORT',
      permissions: ['instagram_business_basic', 'instagram_business_manage_comments'],
    });
    const sent = new URLSearchParams(fake.requests[0]!.body);
    expect(fake.requests[0]!.url.toString()).toBe('https://api.instagram.com/oauth/access_token');
    expect(sent.get('code')).toBe('ABC');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_secret')).toBe('SECRET');
  });

  it('aceita resposta plana e permissões em array', async () => {
    const fake = createFakeFetch([{ json: { access_token: 'S', permissions: ['a', 'b'] } }]);
    await expect(createInstagramOAuth({ ...opts, fetch: fake.fetch }).exchangeCode('X')).resolves.toEqual({
      accessToken: 'S',
      permissions: ['a', 'b'],
    });
  });

  it('troca por token longo e renova', async () => {
    const fake = createFakeFetch([
      { json: { access_token: 'LONG', token_type: 'bearer', expires_in: 5183944 } },
      { json: { access_token: 'LONG2', token_type: 'bearer', expires_in: 5184000 } },
    ]);
    const oauth = createInstagramOAuth({ ...opts, fetch: fake.fetch });
    await expect(oauth.exchangeForLongLived('SHORT')).resolves.toEqual({ accessToken: 'LONG', expiresInSec: 5183944 });
    await expect(oauth.refresh('LONG')).resolves.toEqual({ accessToken: 'LONG2', expiresInSec: 5184000 });
    expect(fake.requests[0]!.url.pathname).toBe('/access_token');
    expect(fake.requests[0]!.url.searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(fake.requests[1]!.url.pathname).toBe('/refresh_access_token');
    expect(fake.requests[1]!.url.searchParams.get('grant_type')).toBe('ig_refresh_token');
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/instagram-errors.test.ts test/instagram-client.test.ts test/instagram-oauth.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/instagram/errors.ts`:

```ts
export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
    /** Minutos informados pela Meta em X-Business-Use-Case-Usage (estimated_time_to_regain_access). */
    readonly regainAccessMinutes?: number,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

export type FailReason =
  | 'token_invalid'
  | 'rate_limited'
  | 'messaging_disabled'
  | 'abuse_blocked'
  | 'comment_unavailable'
  | 'window_expired'
  | 'permission_denied'
  | 'temporary_error'
  | 'unknown_error';

export type ErrorKind = 'auth' | 'rate_limit' | 'messaging_disabled' | 'abuse' | 'permanent' | 'transient';

export interface ErrorClassification {
  kind: ErrorKind;
  reason: FailReason;
  /** Para 'transient': máximo de tentativas antes de desistir. */
  maxAttempts?: number;
  /** Para 'rate_limit': quanto esperar antes de tentar de novo. */
  retryAfterMs?: number;
  code?: string;
  message: string;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const DEFAULT_RATE_LIMIT_WAIT_MS = 15 * 60_000;

/** Tabela única de decisão sobre erros da Graph API (spec §9). */
export function classifyError(error: unknown): ErrorClassification {
  if (!(error instanceof GraphApiError)) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'transient', reason: 'temporary_error', maxAttempts: 5, message };
  }
  const { code, subcode, httpStatus, message } = error;
  const base = { code: code !== undefined ? String(code) : `http_${httpStatus}`, message };

  if (code === 190) return { ...base, kind: 'auth', reason: 'token_invalid' };
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    const retryAfterMs = error.regainAccessMinutes ? error.regainAccessMinutes * 60_000 : DEFAULT_RATE_LIMIT_WAIT_MS;
    return { ...base, kind: 'rate_limit', reason: 'rate_limited', retryAfterMs };
  }
  if (code === 368 || /temporarily blocked|considered spam|abusive/i.test(message)) {
    return { ...base, kind: 'abuse', reason: 'abuse_blocked' };
  }
  if (/disabled access to instagram direct messaging/i.test(message)) {
    return { ...base, kind: 'messaging_disabled', reason: 'messaging_disabled' };
  }
  if (code === 10 && subcode === 2534022) return { ...base, kind: 'permanent', reason: 'window_expired' };
  if (/outside of allowed window|reply to this comment|already (been )?replied/i.test(message)) {
    return { ...base, kind: 'permanent', reason: 'window_expired' };
  }
  if (code === 100 || code === 551) return { ...base, kind: 'permanent', reason: 'comment_unavailable' };
  if (code === 10 || code === 200 || code === 3) return { ...base, kind: 'permanent', reason: 'permission_denied' };
  if (httpStatus >= 500 || code === 1 || code === 2) {
    return { ...base, kind: 'transient', reason: 'temporary_error', maxAttempts: 5 };
  }
  return { ...base, kind: 'transient', reason: 'unknown_error', maxAttempts: 2 };
}
```


`src/instagram/client.ts`:

```ts
import { GraphApiError } from './errors.js';

export type FetchFn = typeof fetch;

export interface InstagramProfile {
  /** ID da conta profissional — o mesmo `entry.id` dos webhooks. */
  igId: string;
  /** ID escopado do app (campo `id`), usado em signed_request. */
  appUserId: string;
  username: string;
  name?: string;
  profilePictureUrl?: string;
  accountType?: string;
}

export interface MediaItem {
  id: string;
  caption?: string;
  mediaType: string;
  mediaProductType?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink: string;
  timestamp: string;
}

export interface CommentItem {
  id: string;
  text: string;
  timestamp: string;
  fromId?: string;
  fromUsername?: string;
  hidden?: boolean;
}

export interface InstagramClient {
  getProfile(token: string): Promise<InstagramProfile>;
  listMedia(token: string, limit?: number): Promise<MediaItem[]>;
  getMedia(token: string, mediaId: string): Promise<MediaItem>;
  listComments(token: string, mediaId: string, after?: string): Promise<{ comments: CommentItem[]; nextCursor?: string }>;
  replyToComment(token: string, commentId: string, message: string): Promise<{ id: string }>;
  sendPrivateReply(token: string, igId: string, commentId: string, text: string): Promise<{ messageId: string }>;
  subscribeToComments(token: string): Promise<void>;
}

export interface InstagramClientOptions {
  version: string;
  fetch?: FetchFn;
  baseUrl?: string;
  timeoutMs?: number;
}

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp';

interface RawMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink: string;
  timestamp: string;
}

function toMedia(raw: RawMedia): MediaItem {
  return {
    id: raw.id,
    caption: raw.caption,
    mediaType: raw.media_type,
    mediaProductType: raw.media_product_type,
    mediaUrl: raw.media_url,
    thumbnailUrl: raw.thumbnail_url,
    permalink: raw.permalink,
    timestamp: raw.timestamp,
  };
}

function regainMinutes(header: string | null): number | undefined {
  if (!header) return undefined;
  try {
    const usage = JSON.parse(header) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
    const minutes = Object.values(usage)
      .flat()
      .map((entry) => entry.estimated_time_to_regain_access ?? 0);
    const max = Math.max(0, ...minutes);
    return max > 0 ? max : undefined;
  } catch {
    return undefined;
  }
}

export async function readGraphResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: { message: text.slice(0, 200) } };
  }
  const error = (body as { error?: { message?: string; code?: number; error_subcode?: number } }).error;
  if (!response.ok || error) {
    throw new GraphApiError(
      error?.message ?? `HTTP ${response.status}`,
      response.status,
      error?.code,
      error?.error_subcode,
      regainMinutes(response.headers.get('x-business-use-case-usage')),
    );
  }
  return body as T;
}

export function createInstagramClient(options: InstagramClientOptions): InstagramClient {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.baseUrl ?? 'https://graph.instagram.com'}/${options.version}`;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string> = {},
    json?: unknown,
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return readGraphResponse<T>(response);
  }

  return {
    async getProfile(token) {
      const raw = await call<{
        id: string;
        user_id: string | number;
        username: string;
        name?: string;
        profile_picture_url?: string;
        account_type?: string;
      }>(token, 'GET', '/me', { fields: 'id,user_id,username,name,profile_picture_url,account_type' });
      return {
        igId: String(raw.user_id),
        appUserId: String(raw.id),
        username: raw.username,
        name: raw.name,
        profilePictureUrl: raw.profile_picture_url,
        accountType: raw.account_type,
      };
    },

    async listMedia(token, limit = 24) {
      const raw = await call<{ data: RawMedia[] }>(token, 'GET', '/me/media', {
        fields: MEDIA_FIELDS,
        limit: String(limit),
      });
      return raw.data.map(toMedia);
    },

    async getMedia(token, mediaId) {
      return toMedia(await call<RawMedia>(token, 'GET', `/${mediaId}`, { fields: MEDIA_FIELDS }));
    },

    async listComments(token, mediaId, after) {
      const raw = await call<{
        data: Array<{ id: string; text?: string; timestamp: string; hidden?: boolean; from?: { id: string; username?: string } }>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(token, 'GET', `/${mediaId}/comments`, {
        fields: 'id,text,timestamp,hidden,from{id,username}',
        limit: '50',
        ...(after ? { after } : {}),
      });
      return {
        comments: raw.data.map((c) => ({
          id: c.id,
          text: c.text ?? '',
          timestamp: c.timestamp,
          fromId: c.from?.id,
          fromUsername: c.from?.username,
          hidden: c.hidden,
        })),
        nextCursor: raw.paging?.next ? raw.paging.cursors?.after : undefined,
      };
    },

    async replyToComment(token, commentId, message) {
      return call<{ id: string }>(token, 'POST', `/${commentId}/replies`, {}, { message });
    },

    async sendPrivateReply(token, igId, commentId, text) {
      const raw = await call<{ message_id: string }>(token, 'POST', `/${igId}/messages`, {}, {
        recipient: { comment_id: commentId },
        message: { text },
      });
      return { messageId: raw.message_id };
    },

    async subscribeToComments(token) {
      await call<{ success: boolean }>(token, 'POST', '/me/subscribed_apps', { subscribed_fields: 'comments' });
    },
  };
}
```


`src/instagram/oauth.ts`:

```ts
import { readGraphResponse, type FetchFn } from './client.js';

export const REQUIRED_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
] as const;

export interface OAuthOptions {
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetch?: FetchFn;
}

export interface ShortLivedToken {
  accessToken: string;
  permissions: string[];
}

export interface LongLivedToken {
  accessToken: string;
  expiresInSec: number;
}

export interface InstagramOAuth {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<ShortLivedToken>;
  exchangeForLongLived(shortToken: string): Promise<LongLivedToken>;
  refresh(longToken: string): Promise<LongLivedToken>;
}

function toPermissions(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export function createInstagramOAuth(options: OAuthOptions): InstagramOAuth {
  const doFetch = options.fetch ?? fetch;

  return {
    authorizeUrl(state) {
      const url = new URL('https://www.instagram.com/oauth/authorize');
      url.searchParams.set('client_id', options.appId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', REQUIRED_SCOPES.join(','));
      url.searchParams.set('state', state);
      // Pede usuário/senha da conta certa (útil com várias contas) e esconde a opção "entrar com Facebook".
      url.searchParams.set('force_reauth', 'true');
      url.searchParams.set('enable_fb_login', 'false');
      return url.toString();
    },

    async exchangeCode(code) {
      const body = new URLSearchParams({
        client_id: options.appId,
        client_secret: options.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: options.redirectUri,
        code: code.replace(/#_$/, ''),
      });
      const response = await doFetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await readGraphResponse<
        { access_token?: string; permissions?: unknown; data?: Array<{ access_token: string; permissions?: unknown }> }
      >(response);
      const entry = raw.data?.[0] ?? raw;
      if (!entry.access_token) throw new Error('Resposta da Meta sem access_token');
      return { accessToken: entry.access_token, permissions: toPermissions(entry.permissions) };
    },

    async exchangeForLongLived(shortToken) {
      const url = new URL('https://graph.instagram.com/access_token');
      url.searchParams.set('grant_type', 'ig_exchange_token');
      url.searchParams.set('client_secret', options.appSecret);
      url.searchParams.set('access_token', shortToken);
      const raw = await readGraphResponse<{ access_token: string; expires_in: number }>(
        await doFetch(url, { signal: AbortSignal.timeout(15_000) }),
      );
      return { accessToken: raw.access_token, expiresInSec: raw.expires_in };
    },

    async refresh(longToken) {
      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', longToken);
      const raw = await readGraphResponse<{ access_token: string; expires_in: number }>(
        await doFetch(url, { signal: AbortSignal.timeout(15_000) }),
      );
      return { accessToken: raw.access_token, expiresInSec: raw.expires_in };
    },
  };
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  42 passed (42)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/fakeFetch.ts test/instagram-errors.test.ts test/instagram-client.test.ts test/instagram-oauth.test.ts src/instagram/errors.ts src/instagram/client.ts src/instagram/oauth.ts
git commit -m "feat(instagram): cliente da Graph API, OAuth e tabela de erros"
```

---

### Task 5: Repositórios (acesso a dados)

**Objetivo:** Funções SQL pequenas e testadas por tabela; toda regra de banco (deduplicação, fila, status agregado) mora aqui.

**Files:**
- Test: `test/helpers/db.ts`
- Test: `test/repos.test.ts`
- Create: `src/db/repos/accounts.ts`
- Create: `src/db/repos/automations.ts`
- Create: `src/db/repos/interactions.ts`
- Create: `src/db/repos/jobs.ts`
- Create: `src/db/repos/users.ts`
- Create: `src/db/repos/webhookEvents.ts`
- Create: `src/db/repos/deletionRequests.ts`

**Interfaces:**
- Consumes: `DB` (Task 2).
- Produces (`accounts.ts`): `type Account`, `type AccountStatus = 'ok'|'reconnect_required'|'paused_by_safety'|'disconnected'`, `upsertConnectedAccount(db, input, now)`, `getAccountById`, `getAccountByIgId`, `findAccountsByAnyUserId(db, userId)`, `listAccounts`, `updateAccountToken(db, id, tokenEnc, expiresAt, now)`, `setAccountStatus(db, id, status, now, { lastError?, pausedUntil? })`, `setMessagingDisabled(db, id, disabled, now)`, `disconnectAccount(db, id, now)`, `deleteAccount(db, id)`, `isAccountUsable(account, now)`.
- Produces (`automations.ts`): `type Automation`, `type AutomationSummary`, `class DuplicateAutomationError`, `createAutomation`, `updateAutomationContent`, `setAutomationActive`, `deleteAutomation`, `getAutomation`, `findActiveAutomation(db, accountId, mediaId)`, `listActiveAutomations`, `listAutomationSummaries(db, startOfToday)`, `setLastVariationIndex`, `setLastReconciledAt`.
- Produces (`interactions.ts`): `insertInteraction(db, input, now): number|null` (null = comentário duplicado), `commentExists`, `hasActedForPerson(db, automationId, igsid)`, `refreshInteractionStatus(db, id)`, `listActivity(db, filter): ActivityRow[]`, `purgeInteractionsBefore`.
- Produces (`jobs.ts`): `type JobType`, `type ClaimedJob`, `enqueueJob`, `claimNextDueJob(db, now)` (só contas aptas), `completeJob`, `failJob`, `rescheduleJob(db, id, runAt, now, { countAttempt, reason?, code?, message? })`, `countActionsSince`, `lastActionAt`, `resetRunningJobs`, `cancelJobsOlderThan(db, before, now): number[]`.
- Produces (`users.ts`, `webhookEvents.ts`, `deletionRequests.ts`): `createUser`, `setUserPassword`, `findUserByEmail`, `findUserById`; `insertWebhookEvent`, `purgeWebhookEventsBefore`; `insertDeletionRequest`, `findDeletionRequest`.
- Test helper: `makeDb()`, `seedAccount(db, overrides?)`, `seedAutomation(db, accountId, overrides?, createdAt?)`, `T0`.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/helpers/db.ts`:

```ts
import { migrate, openDatabase, type DB } from '../../src/db/database.js';
import { upsertConnectedAccount, type Account } from '../../src/db/repos/accounts.js';
import { createAutomation, type Automation, type NewAutomation } from '../../src/db/repos/automations.js';

export const T0 = Date.parse('2026-10-27T12:00:00Z');

export function makeDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export function seedAccount(db: DB, overrides: Partial<{ igId: string; username: string; tokenEnc: string }> = {}): Account {
  return upsertConnectedAccount(
    db,
    {
      igId: overrides.igId ?? 'IG1',
      appUserId: `APP-${overrides.igId ?? 'IG1'}`,
      username: overrides.username ?? 'loja',
      tokenEnc: overrides.tokenEnc ?? 'enc-token',
      tokenExpiresAt: T0 + 60 * 86_400_000,
    },
    T0,
  );
}

export function seedAutomation(db: DB, accountId: number, overrides: Partial<NewAutomation> = {}, createdAt = T0): Automation {
  return createAutomation(
    db,
    {
      accountId,
      mediaId: 'M1',
      mediaPermalink: 'https://www.instagram.com/p/abc/',
      mediaCaption: 'Post de teste',
      keywords: ['eu quero'],
      publicVariations: ['Oi {usuario}, te mandei no direct!', 'Enviado {usuario}!', 'Olha o direct {usuario}'],
      dmText: 'Aqui está o link: https://exemplo.com (mensagem automática)',
      ...overrides,
    },
    createdAt,
  );
}
```


`test/repos.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  disconnectAccount,
  getAccountById,
  isAccountUsable,
  setAccountStatus,
  upsertConnectedAccount,
} from '../src/db/repos/accounts.js';
import {
  DuplicateAutomationError,
  findActiveAutomation,
  getAutomation,
  listAutomationSummaries,
} from '../src/db/repos/automations.js';
import { hasActedForPerson, insertInteraction, listActivity, refreshInteractionStatus } from '../src/db/repos/interactions.js';
import { cancelJobsOlderThan, claimNextDueJob, completeJob, enqueueJob, failJob } from '../src/db/repos/jobs.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';

const interaction = (automationId: number, commentId: string, person = 'U1') => ({
  automationId,
  commentId,
  commenterIgsid: person,
  commenterUsername: 'ana',
  commentText: 'eu quero',
  matchedKeyword: 'eu quero',
  source: 'webhook' as const,
  status: 'queued' as const,
});

describe('accounts repo', () => {
  it('reconectar limpa status de erro e mantém o mesmo id', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    setAccountStatus(db, acc.id, 'reconnect_required', T0, { lastError: 'token' });
    const again = upsertConnectedAccount(
      db,
      { igId: 'IG1', appUserId: 'APP', username: 'loja_nova', tokenEnc: 'x', tokenExpiresAt: T0 + 1 },
      T0 + 5,
    );
    expect(again).toMatchObject({ id: acc.id, username: 'loja_nova', status: 'ok', lastError: null });
  });

  it('isAccountUsable considera token, status e pausa vencida', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    expect(isAccountUsable(acc, T0)).toBe(true);
    setAccountStatus(db, acc.id, 'paused_by_safety', T0, { pausedUntil: T0 + 1000 });
    expect(isAccountUsable(getAccountById(db, acc.id)!, T0)).toBe(false);
    expect(isAccountUsable(getAccountById(db, acc.id)!, T0 + 1000)).toBe(true);
    disconnectAccount(db, acc.id, T0);
    expect(isAccountUsable(getAccountById(db, acc.id)!, T0 + 1000)).toBe(false);
  });

  it('desconectar pausa as automações da conta', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    disconnectAccount(db, acc.id, T0);
    expect(getAutomation(db, auto.id)!.isActive).toBe(false);
  });
});

describe('automations repo', () => {
  it('impede duas automações no mesmo post', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    seedAutomation(db, acc.id);
    expect(() => seedAutomation(db, acc.id)).toThrow(DuplicateAutomationError);
  });

  it('findActiveAutomation ignora automações pausadas e o resumo conta respostas', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    expect(findActiveAutomation(db, acc.id, 'M1')?.id).toBe(auto.id);
    const id = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    db.prepare("UPDATE interactions SET status = 'done' WHERE id = ?").run(id);
    expect(listAutomationSummaries(db, T0 - 1)[0]).toMatchObject({ accountUsername: 'loja', repliesToday: 1, repliesTotal: 1 });
  });
});

describe('interactions + jobs repos', () => {
  it('deduplica por comment_id e detecta pessoa já atendida', () => {
    const db = makeDb();
    const auto = seedAutomation(db, seedAccount(db).id);
    expect(insertInteraction(db, interaction(auto.id, 'C1'), T0)).toBeTypeOf('number');
    expect(insertInteraction(db, interaction(auto.id, 'C1'), T0)).toBeNull();
    expect(hasActedForPerson(db, auto.id, 'U1')).toBe(true);
    expect(hasActedForPerson(db, auto.id, 'U2')).toBe(false);
  });

  it('claimNextDueJob respeita run_at e o estado da conta', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 + 100 }, T0);
    expect(claimNextDueJob(db, T0)).toBeUndefined();
    setAccountStatus(db, acc.id, 'reconnect_required', T0);
    expect(claimNextDueJob(db, T0 + 100)).toBeUndefined();
    setAccountStatus(db, acc.id, 'ok', T0);
    expect(claimNextDueJob(db, T0 + 100)).toMatchObject({ type: 'public_reply', commentId: 'C1', commenterUsername: 'ana' });
    expect(claimNextDueJob(db, T0 + 100)).toBeUndefined(); // já está 'running'
  });

  it('status agregado: done, partial, failed', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'public_reply', runAt: T0 }, T0);
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'private_reply', runAt: T0 }, T0);
    expect(refreshInteractionStatus(db, iid)).toBe('queued');
    const [a, b] = db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: number }>;
    completeJob(db, a!.id, 'R1', T0);
    failJob(db, b!.id, { reason: 'messaging_disabled' }, T0);
    expect(refreshInteractionStatus(db, iid)).toBe('partial');
    const rows = listActivity(db, { limit: 10, offset: 0 });
    expect(rows[0]).toMatchObject({ publicStatus: 'done', dmStatus: 'failed', dmFailReason: 'messaging_disabled', status: 'partial' });
  });

  it('cancela jobs pendentes de comentários com mais de 7 dias', () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const auto = seedAutomation(db, acc.id);
    const iid = insertInteraction(db, interaction(auto.id, 'C1'), T0)!;
    enqueueJob(db, { interactionId: iid, accountId: acc.id, type: 'private_reply', runAt: T0 }, T0);
    expect(cancelJobsOlderThan(db, T0 + 1, T0 + 2)).toEqual([iid]);
    expect(refreshInteractionStatus(db, iid)).toBe('failed');
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/repos.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/db/repos/accounts.ts`:

```ts
import type { DB } from '../database.js';

export type AccountStatus = 'ok' | 'reconnect_required' | 'paused_by_safety' | 'disconnected';

export interface Account {
  id: number;
  igId: string;
  appUserId: string | null;
  username: string;
  profilePictureUrl: string | null;
  tokenEnc: string | null;
  tokenExpiresAt: number | null;
  tokenRefreshedAt: number | null;
  status: AccountStatus;
  messagingDisabled: boolean;
  pausedUntil: number | null;
  lastError: string | null;
  connectedAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  ig_id: string;
  app_user_id: string | null;
  username: string;
  profile_picture_url: string | null;
  token_enc: string | null;
  token_expires_at: number | null;
  token_refreshed_at: number | null;
  status: AccountStatus;
  messaging_disabled: number;
  paused_until: number | null;
  last_error: string | null;
  connected_at: number;
  updated_at: number;
}

const toAccount = (r: Row): Account => ({
  id: r.id,
  igId: r.ig_id,
  appUserId: r.app_user_id,
  username: r.username,
  profilePictureUrl: r.profile_picture_url,
  tokenEnc: r.token_enc,
  tokenExpiresAt: r.token_expires_at,
  tokenRefreshedAt: r.token_refreshed_at,
  status: r.status,
  messagingDisabled: r.messaging_disabled === 1,
  pausedUntil: r.paused_until,
  lastError: r.last_error,
  connectedAt: r.connected_at,
  updatedAt: r.updated_at,
});

export interface ConnectedAccountInput {
  igId: string;
  appUserId: string;
  username: string;
  profilePictureUrl?: string;
  tokenEnc: string;
  tokenExpiresAt: number;
}

/** Cria ou reativa a conta após o Business Login (reconectar limpa erros e pausas). */
export function upsertConnectedAccount(db: DB, input: ConnectedAccountInput, now: number): Account {
  db.prepare(
    `INSERT INTO ig_accounts (ig_id, app_user_id, username, profile_picture_url, token_enc, token_expires_at,
       token_refreshed_at, status, messaging_disabled, paused_until, last_error, connected_at, updated_at)
     VALUES (@igId, @appUserId, @username, @pic, @tokenEnc, @exp, @now, 'ok', 0, NULL, NULL, @now, @now)
     ON CONFLICT (ig_id) DO UPDATE SET
       app_user_id = excluded.app_user_id, username = excluded.username,
       profile_picture_url = excluded.profile_picture_url, token_enc = excluded.token_enc,
       token_expires_at = excluded.token_expires_at, token_refreshed_at = excluded.token_refreshed_at,
       status = 'ok', messaging_disabled = 0, paused_until = NULL, last_error = NULL,
       connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
  ).run({ ...input, pic: input.profilePictureUrl ?? null, exp: input.tokenExpiresAt, now });
  return getAccountByIgId(db, input.igId)!;
}

export function getAccountById(db: DB, id: number): Account | undefined {
  const row = db.prepare('SELECT * FROM ig_accounts WHERE id = ?').get(id) as Row | undefined;
  return row && toAccount(row);
}

export function getAccountByIgId(db: DB, igId: string): Account | undefined {
  const row = db.prepare('SELECT * FROM ig_accounts WHERE ig_id = ?').get(igId) as Row | undefined;
  return row && toAccount(row);
}

export function findAccountsByAnyUserId(db: DB, userId: string): Account[] {
  return (db.prepare('SELECT * FROM ig_accounts WHERE ig_id = ? OR app_user_id = ?').all(userId, userId) as Row[]).map(
    toAccount,
  );
}

export function listAccounts(db: DB): Account[] {
  return (db.prepare('SELECT * FROM ig_accounts ORDER BY username').all() as Row[]).map(toAccount);
}

export function updateAccountToken(db: DB, id: number, tokenEnc: string, tokenExpiresAt: number, now: number): void {
  db.prepare(
    'UPDATE ig_accounts SET token_enc = ?, token_expires_at = ?, token_refreshed_at = ?, updated_at = ? WHERE id = ?',
  ).run(tokenEnc, tokenExpiresAt, now, now, id);
}

export function setAccountStatus(
  db: DB,
  id: number,
  status: AccountStatus,
  now: number,
  extra: { lastError?: string | null; pausedUntil?: number | null } = {},
): void {
  db.prepare('UPDATE ig_accounts SET status = ?, last_error = ?, paused_until = ?, updated_at = ? WHERE id = ?').run(
    status,
    extra.lastError ?? null,
    extra.pausedUntil ?? null,
    now,
    id,
  );
}

export function setMessagingDisabled(db: DB, id: number, disabled: boolean, now: number): void {
  db.prepare('UPDATE ig_accounts SET messaging_disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, now, id);
}

/** Apaga o token e pausa as automações (usado no botão "Desconectar" e no callback de desautorização). */
export function disconnectAccount(db: DB, id: number, now: number): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE ig_accounts SET token_enc = NULL, token_expires_at = NULL, status = 'disconnected', updated_at = ? WHERE id = ?",
    ).run(now, id);
    db.prepare('UPDATE automations SET is_active = 0, updated_at = ? WHERE account_id = ?').run(now, id);
  })();
}

export function deleteAccount(db: DB, id: number): void {
  db.prepare('DELETE FROM ig_accounts WHERE id = ?').run(id);
}

/** Conta apta a executar ações agora (ok, ou pausa de segurança já vencida). */
export function isAccountUsable(account: Account, now: number): boolean {
  if (!account.tokenEnc) return false;
  if (account.status === 'ok') return true;
  return account.status === 'paused_by_safety' && account.pausedUntil !== null && account.pausedUntil <= now;
}
```


`src/db/repos/automations.ts`:

```ts
import type { DB } from '../database.js';

export interface AutomationContent {
  keywords: string[];
  publicVariations: string[];
  dmText: string;
}

export interface NewAutomation extends AutomationContent {
  accountId: number;
  mediaId: string;
  mediaType?: string;
  mediaPermalink?: string;
  mediaCaption?: string;
}

export interface Automation extends NewAutomation {
  id: number;
  isActive: boolean;
  lastVariationIndex: number | null;
  lastReconciledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationSummary extends Automation {
  accountUsername: string;
  repliesToday: number;
  repliesTotal: number;
}

interface Row {
  id: number;
  account_id: number;
  media_id: string;
  media_type: string | null;
  media_permalink: string | null;
  media_caption: string | null;
  keywords_json: string;
  public_variations_json: string;
  dm_text: string;
  is_active: number;
  last_variation_index: number | null;
  last_reconciled_at: number | null;
  created_at: number;
  updated_at: number;
}

const toAutomation = (r: Row): Automation => ({
  id: r.id,
  accountId: r.account_id,
  mediaId: r.media_id,
  mediaType: r.media_type ?? undefined,
  mediaPermalink: r.media_permalink ?? undefined,
  mediaCaption: r.media_caption ?? undefined,
  keywords: JSON.parse(r.keywords_json) as string[],
  publicVariations: JSON.parse(r.public_variations_json) as string[],
  dmText: r.dm_text,
  isActive: r.is_active === 1,
  lastVariationIndex: r.last_variation_index,
  lastReconciledAt: r.last_reconciled_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class DuplicateAutomationError extends Error {
  constructor() {
    super('Este post já tem uma automação');
  }
}

export function createAutomation(db: DB, input: NewAutomation, now: number): Automation {
  try {
    const result = db
      .prepare(
        `INSERT INTO automations (account_id, media_id, media_type, media_permalink, media_caption, keywords_json,
           public_variations_json, dm_text, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.accountId,
        input.mediaId,
        input.mediaType ?? null,
        input.mediaPermalink ?? null,
        input.mediaCaption ?? null,
        JSON.stringify(input.keywords),
        JSON.stringify(input.publicVariations),
        input.dmText,
        now,
        now,
      );
    return getAutomation(db, Number(result.lastInsertRowid))!;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new DuplicateAutomationError();
    throw error;
  }
}

export function updateAutomationContent(db: DB, id: number, content: AutomationContent, now: number): void {
  db.prepare(
    'UPDATE automations SET keywords_json = ?, public_variations_json = ?, dm_text = ?, last_variation_index = NULL, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(content.keywords), JSON.stringify(content.publicVariations), content.dmText, now, id);
}

export function setAutomationActive(db: DB, id: number, active: boolean, now: number): void {
  db.prepare('UPDATE automations SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now, id);
}

export function deleteAutomation(db: DB, id: number): void {
  db.prepare('DELETE FROM automations WHERE id = ?').run(id);
}

export function getAutomation(db: DB, id: number): Automation | undefined {
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as Row | undefined;
  return row && toAutomation(row);
}

export function findActiveAutomation(db: DB, accountId: number, mediaId: string): Automation | undefined {
  const row = db
    .prepare('SELECT * FROM automations WHERE account_id = ? AND media_id = ? AND is_active = 1')
    .get(accountId, mediaId) as Row | undefined;
  return row && toAutomation(row);
}

export function listActiveAutomations(db: DB): Automation[] {
  return (db.prepare('SELECT * FROM automations WHERE is_active = 1 ORDER BY id').all() as Row[]).map(toAutomation);
}

export function listAutomationSummaries(db: DB, startOfToday: number): AutomationSummary[] {
  const rows = db
    .prepare(
      `SELECT a.*, acc.username AS account_username,
         (SELECT COUNT(*) FROM interactions i WHERE i.automation_id = a.id AND i.status IN ('done','partial') AND i.created_at >= ?) AS replies_today,
         (SELECT COUNT(*) FROM interactions i WHERE i.automation_id = a.id AND i.status IN ('done','partial')) AS replies_total
       FROM automations a JOIN ig_accounts acc ON acc.id = a.account_id
       ORDER BY a.is_active DESC, a.created_at DESC`,
    )
    .all(startOfToday) as Array<Row & { account_username: string; replies_today: number; replies_total: number }>;
  return rows.map((r) => ({
    ...toAutomation(r),
    accountUsername: r.account_username,
    repliesToday: r.replies_today,
    repliesTotal: r.replies_total,
  }));
}

export function setLastVariationIndex(db: DB, id: number, index: number): void {
  db.prepare('UPDATE automations SET last_variation_index = ? WHERE id = ?').run(index, id);
}

export function setLastReconciledAt(db: DB, id: number, at: number): void {
  db.prepare('UPDATE automations SET last_reconciled_at = ? WHERE id = ?').run(at, id);
}
```


`src/db/repos/interactions.ts`:

```ts
import type { DB } from '../database.js';

export type InteractionStatus = 'queued' | 'done' | 'partial' | 'failed' | 'skipped';
export type InteractionSource = 'webhook' | 'reconciler';
export type SkipReason = 'already_replied_to_person';

export interface NewInteraction {
  automationId: number;
  commentId: string;
  commenterIgsid: string;
  commenterUsername?: string;
  commentText: string;
  matchedKeyword: string | null;
  source: InteractionSource;
  status: 'queued' | 'skipped';
  skipReason?: SkipReason;
}

/** Insere a interação; retorna null se o comment_id já existe (deduplicação de webhooks/reconciliação). */
export function insertInteraction(db: DB, input: NewInteraction, now: number): number | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO interactions (automation_id, comment_id, commenter_igsid, commenter_username, comment_text,
         matched_keyword, source, status, skip_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.automationId,
      input.commentId,
      input.commenterIgsid,
      input.commenterUsername ?? null,
      input.commentText,
      input.matchedKeyword,
      input.source,
      input.status,
      input.skipReason ?? null,
      now,
    );
  return result.changes === 0 ? null : Number(result.lastInsertRowid);
}

export function commentExists(db: DB, commentId: string): boolean {
  return db.prepare('SELECT 1 FROM interactions WHERE comment_id = ?').get(commentId) !== undefined;
}

/** A pessoa já recebeu (ou está para receber) ação nesta automação? */
export function hasActedForPerson(db: DB, automationId: number, commenterIgsid: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM interactions WHERE automation_id = ? AND commenter_igsid = ? AND status <> 'skipped' LIMIT 1")
      .get(automationId, commenterIgsid) !== undefined
  );
}

/** Recalcula o status agregado a partir dos jobs: done, partial, failed ou queued. */
export function refreshInteractionStatus(db: DB, interactionId: number): InteractionStatus {
  const jobs = db.prepare('SELECT status FROM jobs WHERE interaction_id = ?').all(interactionId) as Array<{ status: string }>;
  const statuses = jobs.map((job) => job.status);
  let status: InteractionStatus;
  if (statuses.some((s) => s === 'pending' || s === 'running')) status = 'queued';
  else if (statuses.every((s) => s === 'done')) status = 'done';
  else if (statuses.some((s) => s === 'done')) status = 'partial';
  else status = 'failed';
  db.prepare('UPDATE interactions SET status = ? WHERE id = ?').run(status, interactionId);
  return status;
}

export interface ActivityFilter {
  accountId?: number;
  status?: InteractionStatus;
  limit: number;
  offset: number;
}

export interface ActivityRow {
  id: number;
  createdAt: number;
  accountUsername: string;
  mediaPermalink: string | null;
  mediaCaption: string | null;
  commenterUsername: string | null;
  commentText: string | null;
  matchedKeyword: string | null;
  status: InteractionStatus;
  skipReason: SkipReason | null;
  publicStatus: string | null;
  publicFailReason: string | null;
  dmStatus: string | null;
  dmFailReason: string | null;
}

export function listActivity(db: DB, filter: ActivityFilter): ActivityRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.accountId !== undefined) {
    where.push('a.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.status !== undefined) {
    where.push('i.status = ?');
    params.push(filter.status);
  }
  const sql = `
    SELECT i.id, i.created_at AS createdAt, acc.username AS accountUsername, a.media_permalink AS mediaPermalink,
      a.media_caption AS mediaCaption, i.commenter_username AS commenterUsername, i.comment_text AS commentText,
      i.matched_keyword AS matchedKeyword, i.status, i.skip_reason AS skipReason,
      pj.status AS publicStatus, pj.fail_reason AS publicFailReason,
      dj.status AS dmStatus, dj.fail_reason AS dmFailReason
    FROM interactions i
    JOIN automations a ON a.id = i.automation_id
    JOIN ig_accounts acc ON acc.id = a.account_id
    LEFT JOIN jobs pj ON pj.interaction_id = i.id AND pj.type = 'public_reply'
    LEFT JOIN jobs dj ON dj.interaction_id = i.id AND dj.type = 'private_reply'
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, filter.limit, filter.offset) as ActivityRow[];
}

/** Retenção (spec §12): apaga interações (e jobs, em cascata) mais antigas que `before`. */
export function purgeInteractionsBefore(db: DB, before: number): number {
  return db.prepare('DELETE FROM interactions WHERE created_at < ?').run(before).changes;
}
```


`src/db/repos/jobs.ts`:

```ts
import type { DB } from '../database.js';

export type JobType = 'public_reply' | 'private_reply';

export interface ClaimedJob {
  id: number;
  type: JobType;
  attempts: number;
  interactionId: number;
  interactionCreatedAt: number;
  commentId: string;
  commenterUsername: string | null;
  accountId: number;
  automationId: number;
}

export function enqueueJob(
  db: DB,
  job: { interactionId: number; accountId: number; type: JobType; runAt: number },
  now: number,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO jobs (interaction_id, account_id, type, status, attempts, run_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
  ).run(job.interactionId, job.accountId, job.type, job.runAt, now);
}

/**
 * Pega o próximo job vencido de uma conta apta (status ok, ou pausa de segurança vencida)
 * e o marca como 'running'. Jobs de contas desconectadas/pausadas ficam aguardando.
 */
export function claimNextDueJob(db: DB, now: number): ClaimedJob | undefined {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT j.id, j.type, j.attempts, j.interaction_id AS interactionId, i.created_at AS interactionCreatedAt,
           i.comment_id AS commentId, i.commenter_username AS commenterUsername, j.account_id AS accountId,
           i.automation_id AS automationId
         FROM jobs j
         JOIN interactions i ON i.id = j.interaction_id
         JOIN ig_accounts acc ON acc.id = j.account_id
         WHERE j.status = 'pending' AND j.run_at <= @now AND acc.token_enc IS NOT NULL
           AND (acc.status = 'ok' OR (acc.status = 'paused_by_safety' AND acc.paused_until <= @now))
         ORDER BY j.run_at, j.id
         LIMIT 1`,
      )
      .get({ now }) as ClaimedJob | undefined;
    if (row) db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(now, row.id);
    return row;
  })();
}

export function completeJob(db: DB, id: number, resultId: string, now: number): void {
  db.prepare("UPDATE jobs SET status = 'done', result_id = ?, updated_at = ? WHERE id = ?").run(resultId, now, id);
}

export function failJob(
  db: DB,
  id: number,
  failure: { reason: string; code?: string; message?: string },
  now: number,
): void {
  db.prepare(
    "UPDATE jobs SET status = 'failed', attempts = attempts + 1, fail_reason = ?, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?",
  ).run(failure.reason, failure.code ?? null, failure.message ?? null, now, id);
}

/** Devolve o job para a fila. `countAttempt=false` para esperas que não são falha (ritmo, limite, conta pausada). */
export function rescheduleJob(
  db: DB,
  id: number,
  runAt: number,
  now: number,
  opts: { countAttempt: boolean; reason?: string; code?: string; message?: string },
): void {
  db.prepare(
    `UPDATE jobs SET status = 'pending', run_at = ?, attempts = attempts + ?, fail_reason = ?, last_error_code = ?,
       last_error_message = ?, updated_at = ? WHERE id = ?`,
  ).run(runAt, opts.countAttempt ? 1 : 0, opts.reason ?? null, opts.code ?? null, opts.message ?? null, now, id);
}

/** Quantas ações (sucesso ou falha) a conta executou desde `since` — base do teto por hora. */
export function countActionsSince(db: DB, accountId: number, since: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE account_id = ? AND status IN ('done','failed') AND updated_at >= ?")
    .get(accountId, since) as { n: number };
  return row.n;
}

export function lastActionAt(db: DB, accountId: number): number | null {
  const row = db
    .prepare("SELECT MAX(updated_at) AS t FROM jobs WHERE account_id = ? AND status IN ('done','failed')")
    .get(accountId) as { t: number | null };
  return row.t;
}

/** Ao subir o processo: jobs que ficaram 'running' (queda no meio) voltam para a fila. */
export function resetRunningJobs(db: DB, now: number): number {
  return db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(now).changes;
}

/** Jobs pendentes cujo comentário passou da janela de 7 dias são cancelados. Retorna os interaction_ids afetados. */
export function cancelJobsOlderThan(db: DB, interactionCreatedBefore: number, now: number): number[] {
  const rows = db
    .prepare(
      `SELECT j.id, j.interaction_id AS interactionId FROM jobs j JOIN interactions i ON i.id = j.interaction_id
       WHERE j.status = 'pending' AND i.created_at < ?`,
    )
    .all(interactionCreatedBefore) as Array<{ id: number; interactionId: number }>;
  const cancel = db.prepare("UPDATE jobs SET status = 'cancelled', fail_reason = 'window_expired', updated_at = ? WHERE id = ?");
  for (const row of rows) cancel.run(now, row.id);
  return [...new Set(rows.map((row) => row.interactionId))];
}
```


`src/db/repos/users.ts`:

```ts
import type { DB } from '../database.js';

export interface User {
  id: number;
  email: string;
  passwordHash: string;
}

export function createUser(db: DB, email: string, passwordHash: string, now: number): number {
  return Number(
    db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(email.toLowerCase(), passwordHash, now)
      .lastInsertRowid,
  );
}

export function setUserPassword(db: DB, email: string, passwordHash: string): boolean {
  return db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwordHash, email.toLowerCase()).changes > 0;
}

export function findUserByEmail(db: DB, email: string): User | undefined {
  return db
    .prepare('SELECT id, email, password_hash AS passwordHash FROM users WHERE email = ?')
    .get(email.toLowerCase()) as User | undefined;
}

export function findUserById(db: DB, id: number): User | undefined {
  return db.prepare('SELECT id, email, password_hash AS passwordHash FROM users WHERE id = ?').get(id) as User | undefined;
}
```


`src/db/repos/webhookEvents.ts`:

```ts
import type { DB } from '../database.js';

export function insertWebhookEvent(db: DB, payloadJson: string, now: number): void {
  db.prepare('INSERT INTO webhook_events (received_at, payload_json) VALUES (?, ?)').run(now, payloadJson);
}

export function purgeWebhookEventsBefore(db: DB, before: number): number {
  return db.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(before).changes;
}
```


`src/db/repos/deletionRequests.ts`:

```ts
import type { DB } from '../database.js';

export function insertDeletionRequest(db: DB, code: string, appUserId: string, now: number): void {
  db.prepare('INSERT INTO deletion_requests (code, app_user_id, created_at) VALUES (?, ?, ?)').run(code, appUserId, now);
}

export function findDeletionRequest(db: DB, code: string): { code: string; createdAt: number } | undefined {
  return db.prepare('SELECT code, created_at AS createdAt FROM deletion_requests WHERE code = ?').get(code) as
    | { code: string; createdAt: number }
    | undefined;
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  51 passed (51)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/db.ts test/repos.test.ts src/db/repos/accounts.ts src/db/repos/automations.ts src/db/repos/interactions.ts src/db/repos/jobs.ts src/db/repos/users.ts src/db/repos/webhookEvents.ts src/db/repos/deletionRequests.ts
git commit -m "feat(db): repositórios de contas, automações, interações e fila"
```

---

### Task 6: Parser do webhook `comments` (dois formatos da doc)

**Objetivo:** Extrair eventos de comentário aceitando `changes[]` ou `field/value` direto na entry, corpo em objeto ou array, `id` ou `comment_id`, e marcando comentários da própria conta.

**Files:**
- Test: `test/parsePayload.test.ts`
- Create: `src/webhooks/parsePayload.ts`

**Interfaces:**
- Produces: `type CommentEvent = { accountIgId, commentId, fromId, fromUsername?, isSelf, text, mediaId, parentId? }`, `extractCommentEvents(payload: unknown): CommentEvent[]`.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/parsePayload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractCommentEvents } from '../src/webhooks/parsePayload.js';

const value = {
  id: 'C1',
  from: { id: 'U1', username: 'ana' },
  text: 'EU QUERO',
  media: { id: 'M1', media_product_type: 'FEED' },
};

describe('extractCommentEvents', () => {
  it('lê o formato com changes[]', () => {
    const payload = { object: 'instagram', entry: [{ id: 'IG1', time: 1, changes: [{ field: 'comments', value }] }] };
    expect(extractCommentEvents(payload)).toEqual([
      { accountIgId: 'IG1', commentId: 'C1', fromId: 'U1', fromUsername: 'ana', isSelf: false, text: 'EU QUERO', mediaId: 'M1', parentId: undefined },
    ]);
  });

  it('lê o formato com field/value direto na entry e corpo em array', () => {
    const payload = [{ object: 'instagram', entry: [{ id: 'IG1', time: 1, field: 'comments', value }] }];
    expect(extractCommentEvents(payload)).toHaveLength(1);
  });

  it('marca comentários da própria conta (from.id igual ou self_ig_scoped_id)', () => {
    const own = { ...value, from: { id: 'IG1', username: 'loja' } };
    const self = { ...value, from: { id: 'X', username: 'loja', self_ig_scoped_id: 'S' } };
    const payload = {
      object: 'instagram',
      entry: [{ id: 'IG1', changes: [{ field: 'comments', value: own }, { field: 'comments', value: self }] }],
    };
    expect(extractCommentEvents(payload).map((e) => e.isSelf)).toEqual([true, true]);
  });

  it('aceita comment_id (formato Facebook Login) e parent_id', () => {
    const fb = { comment_id: 'C9', parent_id: 'C1', from: { id: 'U2' }, text: 'link', media: { id: 'M1' } };
    const payload = { object: 'instagram', entry: [{ id: 'IG1', changes: [{ field: 'comments', value: fb }] }] };
    expect(extractCommentEvents(payload)[0]).toMatchObject({ commentId: 'C9', parentId: 'C1' });
  });

  it('ignora outros campos, objetos não-instagram e eventos incompletos', () => {
    const payload = {
      object: 'instagram',
      entry: [
        { id: 'IG1', changes: [{ field: 'messages', value }] },
        { id: 'IG1', changes: [{ field: 'comments', value: { id: 'C2' } }] },
      ],
    };
    expect(extractCommentEvents(payload)).toEqual([]);
    expect(extractCommentEvents({ object: 'page', entry: [] })).toEqual([]);
    expect(extractCommentEvents('lixo')).toEqual([]);
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/parsePayload.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/webhooks/parsePayload.ts`:

```ts
export interface CommentEvent {
  accountIgId: string;
  commentId: string;
  fromId: string;
  fromUsername?: string;
  /** true quando o comentário é da própria conta (inclui as respostas que o app publica). */
  isSelf: boolean;
  text: string;
  mediaId: string;
  parentId?: string;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

function toCommentEvent(accountIgId: string, value: Obj): CommentEvent | null {
  const from = isObj(value.from) ? value.from : {};
  const media = isObj(value.media) ? value.media : {};
  const commentId = str(value.id) ?? str(value.comment_id);
  const fromId = str(from.id);
  const mediaId = str(media.id);
  if (!commentId || !fromId || !mediaId) return null;
  return {
    accountIgId,
    commentId,
    fromId,
    fromUsername: str(from.username),
    isSelf: fromId === accountIgId || from.self_ig_scoped_id !== undefined,
    text: str(value.text) ?? '',
    mediaId,
    parentId: str(value.parent_id),
  };
}

/**
 * Extrai eventos do campo `comments` (spec §4.6). Aceita o corpo como objeto ou array, e cada entry
 * com `changes[]` ou com `field`/`value` direto — a documentação da Meta mostra os dois formatos.
 */
export function extractCommentEvents(payload: unknown): CommentEvent[] {
  const bodies = Array.isArray(payload) ? payload : [payload];
  const events: CommentEvent[] = [];
  for (const body of bodies) {
    if (!isObj(body) || body.object !== 'instagram' || !Array.isArray(body.entry)) continue;
    for (const entry of body.entry) {
      if (!isObj(entry)) continue;
      const accountIgId = str(entry.id);
      if (!accountIgId) continue;
      const changes = Array.isArray(entry.changes) ? entry.changes : [entry];
      for (const change of changes) {
        if (!isObj(change) || change.field !== 'comments' || !isObj(change.value)) continue;
        const event = toCommentEvent(accountIgId, change.value);
        if (event) events.push(event);
      }
    }
  }
  return events;
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  56 passed (56)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/parsePayload.test.ts src/webhooks/parsePayload.ts
git commit -m "feat(webhooks): parser tolerante do campo comments"
```

---

### Task 7: Matcher (regras da spec §6.2) e parâmetros de ritmo

**Objetivo:** Decidir se um comentário vira interação e enfileirar os 2 jobs (resposta pública 15–90 s depois; DM 3–10 s após a pública) numa transação.

**Files:**
- Test: `test/pacing.test.ts`
- Test: `test/matcher.test.ts`
- Create: `src/engine/pacing.ts`
- Create: `src/engine/matcher.ts`

**Interfaces:**
- Consumes: repositórios (Task 5), `findMatchingKeyword` (Task 3).
- Produces (`pacing.ts`): constantes `PUBLIC_REPLY_DELAY_MS`, `PRIVATE_REPLY_EXTRA_DELAY_MS`, `MIN_INTERVAL_BETWEEN_ACTIONS_MS` (8 s), `SAFETY_PAUSE_MS` (24 h), `COMMENT_WINDOW_MS` (7 dias), `RECONNECT_RETRY_MS`, `TRANSIENT_BACKOFF_MS`; funções `randomBetween(range, random)`, `transientBackoff(attempts)`, `nextAllowedAt({ now, lastActionAt, actionsLastHour, maxPerHour })`.
- Produces (`matcher.ts`): `type IncomingComment`, `type MatchOutcome`, `handleComment({ db, now, random }, comment): MatchOutcome`.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/pacing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextAllowedAt, randomBetween, transientBackoff } from '../src/engine/pacing.js';

describe('pacing', () => {
  it('randomBetween cobre os limites', () => {
    expect(randomBetween({ min: 10, max: 20 }, () => 0)).toBe(10);
    expect(randomBetween({ min: 10, max: 20 }, () => 0.9999)).toBe(20);
  });

  it('transientBackoff: 1min, 5min, 15min, 1h, 3h e satura', () => {
    expect([1, 2, 3, 4, 5, 9].map(transientBackoff)).toEqual([60_000, 300_000, 900_000, 3_600_000, 10_800_000, 10_800_000]);
  });

  it('nextAllowedAt respeita intervalo mínimo de 8s e teto por hora', () => {
    expect(nextAllowedAt({ now: 100_000, lastActionAt: null, actionsLastHour: 0, maxPerHour: 200 })).toBe(100_000);
    expect(nextAllowedAt({ now: 100_000, lastActionAt: 95_000, actionsLastHour: 0, maxPerHour: 200 })).toBe(103_000);
    expect(nextAllowedAt({ now: 100_000, lastActionAt: null, actionsLastHour: 200, maxPerHour: 200 })).toBe(400_000);
  });
});
```


`test/matcher.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { disconnectAccount } from '../src/db/repos/accounts.js';
import { setAutomationActive } from '../src/db/repos/automations.js';
import { handleComment, type IncomingComment } from '../src/engine/matcher.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';

function setup() {
  const db = makeDb();
  const account = seedAccount(db);
  const automation = seedAutomation(db, account.id);
  const deps = { db, now: () => T0 + 1000, random: () => 0 };
  const comment = (overrides: Partial<IncomingComment> = {}): IncomingComment => ({
    accountIgId: 'IG1',
    commentId: 'C1',
    fromId: 'U1',
    fromUsername: 'ana',
    isSelf: false,
    text: 'Eu quero!!',
    mediaId: 'M1',
    source: 'webhook',
    ...overrides,
  });
  return { db, account, automation, deps, comment };
}

const jobs = (db: ReturnType<typeof setup>['db']) =>
  db.prepare('SELECT type, run_at AS runAt FROM jobs ORDER BY run_at').all() as Array<{ type: string; runAt: number }>;

describe('handleComment', () => {
  it('cria interação e 2 jobs com atraso: pública (15–90s) e DM depois (3–10s)', () => {
    const { db, deps, comment } = setup();
    expect(handleComment(deps, comment())).toMatchObject({ kind: 'queued' });
    expect(jobs(db)).toEqual([
      { type: 'public_reply', runAt: T0 + 1000 + 15_000 },
      { type: 'private_reply', runAt: T0 + 1000 + 15_000 + 3_000 },
    ]);
  });

  it('ignora conta desconhecida ou desconectada', () => {
    const { db, account, deps, comment } = setup();
    expect(handleComment(deps, comment({ accountIgId: 'OUTRA' }))).toEqual({ kind: 'ignored', reason: 'unknown_account' });
    disconnectAccount(db, account.id, T0);
    expect(handleComment(deps, comment())).toEqual({ kind: 'ignored', reason: 'unknown_account' });
  });

  it('ignora comentário da própria conta (evita loop com as nossas respostas)', () => {
    const { deps, comment } = setup();
    expect(handleComment(deps, comment({ isSelf: true }))).toEqual({ kind: 'ignored', reason: 'self_comment' });
    expect(handleComment(deps, comment({ fromId: 'IG1' }))).toEqual({ kind: 'ignored', reason: 'self_comment' });
  });

  it('ignora post sem automação ativa e texto sem palavra-chave', () => {
    const { db, automation, deps, comment } = setup();
    expect(handleComment(deps, comment({ text: 'que lindo' }))).toEqual({ kind: 'ignored', reason: 'no_keyword' });
    expect(handleComment(deps, comment({ mediaId: 'M2' }))).toEqual({ kind: 'ignored', reason: 'no_automation' });
    setAutomationActive(db, automation.id, false, T0);
    expect(handleComment(deps, comment())).toEqual({ kind: 'ignored', reason: 'no_automation' });
  });

  it('no reconciler, ignora comentários anteriores à automação ou com mais de 7 dias', () => {
    const { deps, comment } = setup();
    expect(handleComment(deps, comment({ source: 'reconciler', createdAt: T0 - 1 }))).toEqual({
      kind: 'ignored',
      reason: 'before_automation',
    });
    const late = { ...deps, now: () => T0 + 8 * 86_400_000 };
    expect(handleComment(late, comment({ source: 'reconciler', createdAt: T0 + 1 }))).toEqual({ kind: 'ignored', reason: 'too_old' });
  });

  it('deduplica o mesmo comentário (reentrega do webhook)', () => {
    const { db, deps, comment } = setup();
    handleComment(deps, comment());
    expect(handleComment(deps, comment())).toEqual({ kind: 'ignored', reason: 'duplicate' });
    expect(jobs(db)).toHaveLength(2);
  });

  it('a mesma pessoa comentando de novo no post vira "skipped", sem novos jobs', () => {
    const { db, deps, comment } = setup();
    handleComment(deps, comment());
    expect(handleComment(deps, comment({ commentId: 'C2' }))).toMatchObject({ kind: 'skipped' });
    expect(jobs(db)).toHaveLength(2);
    const row = db.prepare("SELECT skip_reason AS r FROM interactions WHERE comment_id = 'C2'").get() as { r: string };
    expect(row.r).toBe('already_replied_to_person');
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/pacing.test.ts test/matcher.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/engine/pacing.ts`:

```ts
// Parâmetros de ritmo e retentativa (spec §6.2, §6.3, §9 e §10). Altere aqui, em um só lugar.
export const PUBLIC_REPLY_DELAY_MS = { min: 15_000, max: 90_000 } as const;
export const PRIVATE_REPLY_EXTRA_DELAY_MS = { min: 3_000, max: 10_000 } as const;
export const MIN_INTERVAL_BETWEEN_ACTIONS_MS = 8_000;
export const SAFETY_PAUSE_MS = 24 * 60 * 60_000;
export const COMMENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const RECONNECT_RETRY_MS = 30 * 60_000;
export const TRANSIENT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000] as const;

export function randomBetween(range: { min: number; max: number }, random: () => number): number {
  return range.min + Math.floor(random() * (range.max - range.min + 1));
}

/** Espera antes da próxima tentativa após `attempts` falhas transitórias (1 → 1 min, 2 → 5 min ...). */
export function transientBackoff(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), TRANSIENT_BACKOFF_MS.length) - 1;
  return TRANSIENT_BACKOFF_MS[index]!;
}

/**
 * Quando a conta pode executar a próxima ação, respeitando intervalo mínimo e teto por hora.
 * Retorna `now` se já pode agir.
 */
export function nextAllowedAt(input: {
  now: number;
  lastActionAt: number | null;
  actionsLastHour: number;
  maxPerHour: number;
}): number {
  const { now, lastActionAt, actionsLastHour, maxPerHour } = input;
  let at = now;
  if (lastActionAt !== null) at = Math.max(at, lastActionAt + MIN_INTERVAL_BETWEEN_ACTIONS_MS);
  if (actionsLastHour >= maxPerHour) at = Math.max(at, now + 5 * 60_000);
  return at;
}
```


`src/engine/matcher.ts`:

```ts
import type { DB } from '../db/database.js';
import { getAccountByIgId } from '../db/repos/accounts.js';
import { findActiveAutomation } from '../db/repos/automations.js';
import { commentExists, hasActedForPerson, insertInteraction, type InteractionSource } from '../db/repos/interactions.js';
import { enqueueJob } from '../db/repos/jobs.js';
import { findMatchingKeyword } from '../lib/text.js';
import { COMMENT_WINDOW_MS, PRIVATE_REPLY_EXTRA_DELAY_MS, PUBLIC_REPLY_DELAY_MS, randomBetween } from './pacing.js';

export interface IncomingComment {
  accountIgId: string;
  commentId: string;
  fromId: string;
  fromUsername?: string;
  isSelf: boolean;
  text: string;
  mediaId: string;
  /** Epoch ms da criação do comentário, quando conhecido (reconciler). */
  createdAt?: number;
  source: InteractionSource;
}

export type IgnoreReason =
  | 'unknown_account'
  | 'self_comment'
  | 'no_automation'
  | 'before_automation'
  | 'too_old'
  | 'no_keyword'
  | 'duplicate';

export type MatchOutcome =
  | { kind: 'ignored'; reason: IgnoreReason }
  | { kind: 'skipped'; interactionId: number }
  | { kind: 'queued'; interactionId: number };

export interface MatcherDeps {
  db: DB;
  now: () => number;
  random: () => number;
}

/** Aplica as 7 regras da spec §6.2 e, se for o caso, cria a interação e os 2 jobs numa transação. */
export function handleComment(deps: MatcherDeps, comment: IncomingComment): MatchOutcome {
  const { db } = deps;
  const now = deps.now();

  const account = getAccountByIgId(db, comment.accountIgId);
  if (!account || account.status === 'disconnected') return { kind: 'ignored', reason: 'unknown_account' };
  if (comment.isSelf || comment.fromId === account.igId) return { kind: 'ignored', reason: 'self_comment' };

  const automation = findActiveAutomation(db, account.id, comment.mediaId);
  if (!automation) return { kind: 'ignored', reason: 'no_automation' };
  if (comment.createdAt !== undefined) {
    if (comment.createdAt < automation.createdAt) return { kind: 'ignored', reason: 'before_automation' };
    if (now - comment.createdAt > COMMENT_WINDOW_MS) return { kind: 'ignored', reason: 'too_old' };
  }

  const keyword = findMatchingKeyword(comment.text, automation.keywords);
  if (!keyword) return { kind: 'ignored', reason: 'no_keyword' };
  if (commentExists(db, comment.commentId)) return { kind: 'ignored', reason: 'duplicate' };

  return db.transaction((): MatchOutcome => {
    const base = {
      automationId: automation.id,
      commentId: comment.commentId,
      commenterIgsid: comment.fromId,
      commenterUsername: comment.fromUsername,
      commentText: comment.text,
      matchedKeyword: keyword,
      source: comment.source,
    };
    if (hasActedForPerson(db, automation.id, comment.fromId)) {
      const id = insertInteraction(db, { ...base, status: 'skipped', skipReason: 'already_replied_to_person' }, now);
      return id === null ? { kind: 'ignored', reason: 'duplicate' } : { kind: 'skipped', interactionId: id };
    }
    const id = insertInteraction(db, { ...base, status: 'queued' }, now);
    if (id === null) return { kind: 'ignored', reason: 'duplicate' };
    const publicAt = now + randomBetween(PUBLIC_REPLY_DELAY_MS, deps.random);
    const privateAt = publicAt + randomBetween(PRIVATE_REPLY_EXTRA_DELAY_MS, deps.random);
    enqueueJob(db, { interactionId: id, accountId: account.id, type: 'public_reply', runAt: publicAt }, now);
    enqueueJob(db, { interactionId: id, accountId: account.id, type: 'private_reply', runAt: privateAt }, now);
    return { kind: 'queued', interactionId: id };
  })();
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  66 passed (66)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/pacing.test.ts test/matcher.test.ts src/engine/pacing.ts src/engine/matcher.ts
git commit -m "feat(engine): matcher de palavras-chave e enfileiramento"
```

---

### Task 8: Worker: execução com ritmo humano, retries e disjuntor

**Objetivo:** Executar os jobs vencidos (resposta pública e private reply) respeitando intervalo mínimo, teto por hora e a política de erros (spec §9–10).

**Files:**
- Test: `test/helpers/fakeInstagram.ts`
- Test: `test/worker.test.ts`
- Create: `src/engine/worker.ts`

**Interfaces:**
- Consumes: `claimNextDueJob` e cia (Task 5), `InstagramClient` + `classifyError` (Task 4), `pickVariationIndex`/`renderReply` (Task 3), `pacing.ts` (Task 7).
- Produces: `type WorkerDeps = { db, client, decryptToken, now, random, maxActionsPerHour, log }`, `processJob(deps, job): Promise<'done'|'failed'|'rescheduled'>`, `runWorkerTick(deps, maxJobs = 10): Promise<number>`.
- Test helper: `createFakeInstagram(overrides?)` (todos os métodos são `vi.fn` tipados) e `silentLog`.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/helpers/fakeInstagram.ts`:

```ts
import { vi, type Mock } from 'vitest';
import type { InstagramClient } from '../../src/instagram/client.js';

export type FakeInstagram = { [K in keyof InstagramClient]: Mock<InstagramClient[K]> };

/** Cliente falso: todos os métodos são mocks tipados; `overrides` define implementações específicas. */
export function createFakeInstagram(overrides: Partial<InstagramClient> = {}): FakeInstagram {
  const client: FakeInstagram = {
    getProfile: vi.fn<InstagramClient['getProfile']>(),
    listMedia: vi.fn<InstagramClient['listMedia']>(async () => []),
    getMedia: vi.fn<InstagramClient['getMedia']>(),
    listComments: vi.fn<InstagramClient['listComments']>(async () => ({ comments: [] })),
    replyToComment: vi.fn<InstagramClient['replyToComment']>(async () => ({ id: 'REPLY1' })),
    sendPrivateReply: vi.fn<InstagramClient['sendPrivateReply']>(async () => ({ messageId: 'MSG1' })),
    subscribeToComments: vi.fn<InstagramClient['subscribeToComments']>(async () => undefined),
  };
  for (const [key, implementation] of Object.entries(overrides)) {
    (client[key as keyof FakeInstagram] as Mock).mockImplementation(implementation as (...args: unknown[]) => unknown);
  }
  return client;
}

export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
```


`test/worker.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getAccountById } from '../src/db/repos/accounts.js';
import { getAutomation } from '../src/db/repos/automations.js';
import { handleComment } from '../src/engine/matcher.js';
import { SAFETY_PAUSE_MS } from '../src/engine/pacing.js';
import { runWorkerTick, type WorkerDeps } from '../src/engine/worker.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';
import { createFakeInstagram, silentLog } from './helpers/fakeInstagram.js';

function setup(clientOverrides: Parameters<typeof createFakeInstagram>[0] = {}) {
  const db = makeDb();
  const account = seedAccount(db);
  const automation = seedAutomation(db, account.id);
  let now = T0;
  const client = createFakeInstagram(clientOverrides);
  const deps: WorkerDeps = {
    db,
    client,
    decryptToken: (enc) => `plain:${enc}`,
    now: () => now,
    random: () => 0,
    maxActionsPerHour: 200,
    log: silentLog,
  };
  const comment = (id: string, from = 'U1') =>
    handleComment({ db, now: () => now, random: () => 0 }, {
      accountIgId: 'IG1', commentId: id, fromId: from, fromUsername: 'ana', isSelf: false, text: 'eu quero', mediaId: 'M1', source: 'webhook',
    });
  const advance = (ms: number) => { now += ms; };
  const jobRows = () =>
    db.prepare('SELECT type, status, attempts, run_at AS runAt, fail_reason AS reason FROM jobs ORDER BY id').all() as Array<{
      type: string; status: string; attempts: number; runAt: number; reason: string | null;
    }>;
  return { db, account, automation, client, deps, comment, advance, jobRows, getNow: () => now };
}

describe('runWorkerTick', () => {
  it('não executa antes do atraso; depois responde em público e manda a DM', async () => {
    const t = setup();
    t.comment('C1');
    expect(await runWorkerTick(t.deps)).toBe(0);
    t.advance(15_000);
    await runWorkerTick(t.deps);
    expect(t.client.replyToComment).toHaveBeenCalledWith('plain:enc-token', 'C1', 'Oi @ana, te mandei no direct!');
    t.advance(8_000);
    await runWorkerTick(t.deps);
    expect(t.client.sendPrivateReply).toHaveBeenCalledWith('plain:enc-token', 'IG1', 'C1', expect.stringContaining('https://exemplo.com'));
    expect(t.jobRows().map((j) => j.status)).toEqual(['done', 'done']);
    expect(getAutomation(t.db, t.automation.id)!.lastVariationIndex).toBe(0);
    const status = t.db.prepare('SELECT status FROM interactions').get() as { status: string };
    expect(status.status).toBe('done');
  });

  it('respeita 8s entre ações da mesma conta (reagenda sem contar tentativa)', async () => {
    const t = setup();
    t.comment('C1');
    t.advance(20_000); // os dois jobs vencidos
    await runWorkerTick(t.deps);
    expect(t.client.replyToComment).toHaveBeenCalledTimes(1);
    expect(t.client.sendPrivateReply).not.toHaveBeenCalled();
    const dm = t.jobRows()[1]!;
    expect(dm).toMatchObject({ status: 'pending', attempts: 0 });
    expect(dm.runAt).toBe(t.getNow() + 8_000);
  });

  it('token inválido: conta vai para "reconnect_required" e o job aguarda', async () => {
    const t = setup({ replyToComment: async () => { throw new GraphApiError('invalid', 400, 190); } });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    expect(getAccountById(t.db, t.account.id)!.status).toBe('reconnect_required');
    expect(t.jobRows()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('sinal de abuso: pausa a conta por 24h (disjuntor)', async () => {
    const t = setup({ replyToComment: async () => { throw new GraphApiError('blocked', 400, 368); } });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    const acc = getAccountById(t.db, t.account.id)!;
    expect(acc.status).toBe('paused_by_safety');
    expect(acc.pausedUntil).toBe(t.getNow() + SAFETY_PAUSE_MS);
    t.advance(60_000);
    expect(await runWorkerTick(t.deps)).toBe(0);
  });

  it('DMs desativadas: marca a conta, falha só a DM e mantém a resposta pública', async () => {
    const t = setup({
      sendPrivateReply: async () => {
        throw new GraphApiError('(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.', 403, 200);
      },
    });
    t.comment('C1');
    t.advance(15_000);
    await runWorkerTick(t.deps);
    t.advance(10_000);
    await runWorkerTick(t.deps);
    expect(getAccountById(t.db, t.account.id)!.messagingDisabled).toBe(true);
    expect(t.jobRows().map((j) => [j.status, j.reason])).toEqual([
      ['done', null],
      ['failed', 'messaging_disabled'],
    ]);
    const status = t.db.prepare('SELECT status FROM interactions').get() as { status: string };
    expect(status.status).toBe('partial');
  });

  it('erro transitório: tenta de novo com backoff e desiste após 5 tentativas', async () => {
    const t = setup({ replyToComment: vi.fn(async () => { throw new GraphApiError('oops', 500); }) });
    t.comment('C1');
    t.db.prepare("UPDATE jobs SET status = 'cancelled' WHERE type = 'private_reply'").run();
    t.advance(15_000);
    for (const wait of [0, 60_000, 300_000, 900_000, 3_600_000]) {
      t.advance(wait);
      await runWorkerTick(t.deps);
    }
    expect(t.client.replyToComment).toHaveBeenCalledTimes(5);
    expect(t.jobRows()[0]).toMatchObject({ status: 'failed', attempts: 5, reason: 'temporary_error' });
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/worker.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/engine/worker.ts`:

```ts
import type { DB } from '../db/database.js';
import { getAccountById, setAccountStatus, setMessagingDisabled, type Account } from '../db/repos/accounts.js';
import { getAutomation, setLastVariationIndex } from '../db/repos/automations.js';
import { refreshInteractionStatus } from '../db/repos/interactions.js';
import {
  claimNextDueJob,
  completeJob,
  countActionsSince,
  failJob,
  lastActionAt,
  rescheduleJob,
  type ClaimedJob,
} from '../db/repos/jobs.js';
import type { InstagramClient } from '../instagram/client.js';
import { classifyError } from '../instagram/errors.js';
import { pickVariationIndex, renderReply } from '../lib/text.js';
import { nextAllowedAt, RECONNECT_RETRY_MS, SAFETY_PAUSE_MS, transientBackoff } from './pacing.js';

export interface WorkerDeps {
  db: DB;
  client: InstagramClient;
  decryptToken: (encoded: string) => string;
  now: () => number;
  random: () => number;
  maxActionsPerHour: number;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export type JobOutcome = 'done' | 'failed' | 'rescheduled';

async function execute(deps: WorkerDeps, job: ClaimedJob, account: Account): Promise<string> {
  const automation = getAutomation(deps.db, job.automationId);
  if (!automation) throw new Error('Automação removida');
  const token = deps.decryptToken(account.tokenEnc!);
  if (job.type === 'public_reply') {
    const index = pickVariationIndex(automation.publicVariations.length, automation.lastVariationIndex, deps.random);
    const text = renderReply(automation.publicVariations[index]!, job.commenterUsername);
    const { id } = await deps.client.replyToComment(token, job.commentId, text);
    setLastVariationIndex(deps.db, automation.id, index);
    return id;
  }
  const { messageId } = await deps.client.sendPrivateReply(token, account.igId, job.commentId, automation.dmText);
  if (account.messagingDisabled) setMessagingDisabled(deps.db, account.id, false, deps.now());
  return messageId;
}

/** Executa um job já reivindicado e aplica a política de erros da spec §9. */
export async function processJob(deps: WorkerDeps, job: ClaimedJob): Promise<JobOutcome> {
  const { db } = deps;
  const now = deps.now();
  const account = getAccountById(db, job.accountId);
  if (!account?.tokenEnc) {
    rescheduleJob(db, job.id, now + RECONNECT_RETRY_MS, now, { countAttempt: false, reason: 'token_invalid' });
    return 'rescheduled';
  }

  const allowedAt = nextAllowedAt({
    now,
    lastActionAt: lastActionAt(db, account.id),
    actionsLastHour: countActionsSince(db, account.id, now - 60 * 60_000),
    maxPerHour: deps.maxActionsPerHour,
  });
  if (allowedAt > now) {
    rescheduleJob(db, job.id, allowedAt + Math.floor(deps.random() * 2_000), now, { countAttempt: false });
    return 'rescheduled';
  }

  if (account.status === 'paused_by_safety') setAccountStatus(db, account.id, 'ok', now);

  try {
    const resultId = await execute(deps, job, account);
    completeJob(db, job.id, resultId, deps.now());
    refreshInteractionStatus(db, job.interactionId);
    deps.log.info({ jobId: job.id, type: job.type, accountId: account.id }, 'ação executada');
    return 'done';
  } catch (error) {
    const c = classifyError(error);
    const at = deps.now();
    const details = { reason: c.reason, code: c.code, message: c.message };
    deps.log.warn({ jobId: job.id, type: job.type, accountId: account.id, ...details, kind: c.kind }, 'falha ao executar ação');

    switch (c.kind) {
      case 'auth':
        setAccountStatus(db, account.id, 'reconnect_required', at, { lastError: c.message });
        rescheduleJob(db, job.id, at, at, { countAttempt: false, ...details });
        return 'rescheduled';
      case 'rate_limit':
        rescheduleJob(db, job.id, at + (c.retryAfterMs ?? 15 * 60_000), at, { countAttempt: false, ...details });
        return 'rescheduled';
      case 'abuse': {
        const pausedUntil = at + SAFETY_PAUSE_MS;
        setAccountStatus(db, account.id, 'paused_by_safety', at, { lastError: c.message, pausedUntil });
        rescheduleJob(db, job.id, pausedUntil, at, { countAttempt: false, ...details });
        return 'rescheduled';
      }
      case 'messaging_disabled':
        setMessagingDisabled(db, account.id, true, at);
        failJob(db, job.id, details, at);
        break;
      case 'permanent':
        failJob(db, job.id, details, at);
        break;
      case 'transient': {
        const attempts = job.attempts + 1;
        if (attempts >= (c.maxAttempts ?? 5)) {
          failJob(db, job.id, details, at);
          break;
        }
        rescheduleJob(db, job.id, at + transientBackoff(attempts), at, { countAttempt: true, ...details });
        return 'rescheduled';
      }
    }
    refreshInteractionStatus(db, job.interactionId);
    return 'failed';
  }
}

/** Uma rodada do worker: processa em sequência até `maxJobs` jobs vencidos. */
export async function runWorkerTick(deps: WorkerDeps, maxJobs = 10): Promise<number> {
  let processed = 0;
  while (processed < maxJobs) {
    const job = claimNextDueJob(deps.db, deps.now());
    if (!job) break;
    await processJob(deps, job);
    processed += 1;
  }
  return processed;
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  72 passed (72)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/fakeInstagram.ts test/worker.test.ts src/engine/worker.ts
git commit -m "feat(engine): worker com ritmo, retentativas e disjuntor de segurança"
```

---

### Task 9: Reconciler, manutenção (tokens/retenção) e agendador

**Objetivo:** Recuperar comentários sem webhook a cada 10 min, renovar tokens perto do vencimento, cancelar jobs fora da janela de 7 dias, aplicar retenção e agendar tudo sem sobreposição.

**Files:**
- Test: `test/reconciler.test.ts`
- Test: `test/maintenance.test.ts`
- Test: `test/scheduler.test.ts`
- Create: `src/engine/reconciler.ts`
- Create: `src/engine/maintenance.ts`
- Create: `src/engine/scheduler.ts`

**Interfaces:**
- Produces (`reconciler.ts`): `reconcileOnce({ db, client, decryptToken, now, random, log }): Promise<{ checked, queued }>`.
- Produces (`maintenance.ts`): `refreshExpiringTokens({ db, refresh, encrypt, decrypt, now, log })`, `runHousekeeping(db, now)` → `{ cancelled, events, interactions }`.
- Produces (`scheduler.ts`): `type ScheduledTask`, `type Health = { lastWorkerTickAt: number|null }`, `startScheduler(tasks, log): { stop(): Promise<void> }`.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/reconciler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getAccountById } from '../src/db/repos/accounts.js';
import { getAutomation } from '../src/db/repos/automations.js';
import { reconcileOnce } from '../src/engine/reconciler.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';
import { createFakeInstagram, silentLog } from './helpers/fakeInstagram.js';

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', '+0000');

describe('reconcileOnce', () => {
  it('enfileira comentários novos com palavra-chave e para ao chegar em comentários antigos', async () => {
    const db = makeDb();
    const account = seedAccount(db);
    const automation = seedAutomation(db, account.id);
    const now = T0 + 60 * 60_000;
    const listComments = vi.fn(async (_t: string, _m: string, cursor?: string) =>
      cursor
        ? { comments: [{ id: 'old', text: 'eu quero', timestamp: iso(T0 - 1), fromId: 'U9' }] }
        : {
            comments: [
              { id: 'c2', text: 'EU QUERO', timestamp: iso(T0 + 50 * 60_000), fromId: 'U2', fromUsername: 'bia' },
              { id: 'c1', text: 'lindo', timestamp: iso(T0 + 40 * 60_000), fromId: 'U1' },
            ],
            nextCursor: 'P2',
          },
    );
    const deps = {
      db, client: createFakeInstagram({ listComments }), decryptToken: (e: string) => e,
      now: () => now, random: () => 0, log: silentLog,
    };
    expect(await reconcileOnce(deps)).toEqual({ checked: 1, queued: 1 });
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(getAutomation(db, automation.id)!.lastReconciledAt).toBe(now);
    const rows = db.prepare('SELECT comment_id AS id, source FROM interactions').all();
    expect(rows).toEqual([{ id: 'c2', source: 'reconciler' }]);
  });

  it('token inválido durante a varredura marca a conta para reconectar', async () => {
    const db = makeDb();
    const account = seedAccount(db);
    seedAutomation(db, account.id);
    const deps = {
      db,
      client: createFakeInstagram({ listComments: vi.fn(async () => { throw new GraphApiError('bad', 400, 190); }) }),
      decryptToken: (e: string) => e, now: () => T0 + 1, random: () => 0, log: silentLog,
    };
    expect(await reconcileOnce(deps)).toEqual({ checked: 0, queued: 0 });
    expect(getAccountById(db, account.id)!.status).toBe('reconnect_required');
  });
});
```


`test/maintenance.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getAccountById, updateAccountToken } from '../src/db/repos/accounts.js';
import { insertInteraction } from '../src/db/repos/interactions.js';
import { insertWebhookEvent } from '../src/db/repos/webhookEvents.js';
import { refreshExpiringTokens, runHousekeeping } from '../src/engine/maintenance.js';
import { GraphApiError } from '../src/instagram/errors.js';
import { makeDb, seedAccount, seedAutomation, T0 } from './helpers/db.js';
import { silentLog } from './helpers/fakeInstagram.js';

const DAY = 86_400_000;

describe('refreshExpiringTokens', () => {
  const deps = (db: ReturnType<typeof makeDb>, now: number, refresh = vi.fn(async () => ({ accessToken: 'NEW', expiresInSec: 60 * 86_400 }))) => ({
    db, refresh, encrypt: (p: string) => `enc:${p}`, decrypt: (e: string) => e, now: () => now, log: silentLog,
  });

  it('não renova token novo (<24h) nem token com validade longa', async () => {
    const db = makeDb();
    seedAccount(db); // vence em T0 + 60 dias
    const d = deps(db, T0 + 1000);
    expect(await refreshExpiringTokens(d)).toEqual({ refreshed: 0, failed: 0 });
    const d2 = deps(db, T0 + 2 * DAY);
    expect(await refreshExpiringTokens(d2)).toEqual({ refreshed: 0, failed: 0 });
  });

  it('renova quando faltam ≤ 30 dias e grava a nova expiração', async () => {
    const db = makeDb();
    const acc = seedAccount(db);
    const now = T0 + 35 * DAY;
    const d = deps(db, now);
    expect(await refreshExpiringTokens(d)).toEqual({ refreshed: 1, failed: 0 });
    expect(d.refresh).toHaveBeenCalledWith('enc-token');
    expect(getAccountById(db, acc.id)).toMatchObject({ tokenEnc: 'enc:NEW', tokenExpiresAt: now + 60 * DAY, tokenRefreshedAt: now });
  });

  it('token revogado: conta vai para "reconnect_required"', async () => {
    const db = makeDb();
    const acc = seedAccount(db);
    updateAccountToken(db, acc.id, 'x', T0 + 10 * DAY, T0);
    const d = deps(db, T0 + 2 * DAY, vi.fn(async () => { throw new GraphApiError('revoked', 400, 190); }));
    expect(await refreshExpiringTokens(d)).toEqual({ refreshed: 0, failed: 1 });
    expect(getAccountById(db, acc.id)!.status).toBe('reconnect_required');
  });
});

describe('runHousekeeping', () => {
  it('apaga eventos > 30 dias e interações > 90 dias', () => {
    const db = makeDb();
    const auto = seedAutomation(db, seedAccount(db).id);
    insertWebhookEvent(db, '{}', T0);
    insertWebhookEvent(db, '{}', T0 + 89 * DAY);
    insertInteraction(db, {
      automationId: auto.id, commentId: 'C1', commenterIgsid: 'U1', commentText: 'x', matchedKeyword: 'x',
      source: 'webhook', status: 'skipped',
    }, T0);
    expect(runHousekeeping(db, T0 + 91 * DAY)).toEqual({ cancelled: 0, events: 1, interactions: 1 });
  });
});
```


`test/scheduler.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../src/engine/scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startScheduler', () => {
  it('executa no início e a cada intervalo, sem sobrepor execuções lentas', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<void>((resolve) => {
        calls += 1;
        release = resolve;
      });
    const scheduler = startScheduler([{ name: 'slow', intervalMs: 1000, run: slow, runOnStart: true }], { error: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBe(1); // ainda rodando: não sobrepõe
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    release();
    await scheduler.stop();
  });

  it('registra erro e continua agendando', async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    let calls = 0;
    const scheduler = startScheduler(
      [{ name: 'boom', intervalMs: 500, run: () => { calls += 1; throw new Error('x'); } }],
      { error },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/reconciler.test.ts test/maintenance.test.ts test/scheduler.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/engine/reconciler.ts`:

```ts
import type { DB } from '../db/database.js';
import { getAccountById, isAccountUsable, setAccountStatus } from '../db/repos/accounts.js';
import { listActiveAutomations, setLastReconciledAt, type Automation } from '../db/repos/automations.js';
import type { InstagramClient } from '../instagram/client.js';
import { classifyError } from '../instagram/errors.js';
import { handleComment } from './matcher.js';
import { COMMENT_WINDOW_MS } from './pacing.js';

export const RECONCILE_OVERLAP_MS = 15 * 60_000;
export const RECONCILE_MAX_PAGES = 5;

export interface ReconcilerDeps {
  db: DB;
  client: InstagramClient;
  decryptToken: (encoded: string) => string;
  now: () => number;
  random: () => number;
  log: { warn: (obj: object, msg: string) => void };
}

async function reconcileAutomation(deps: ReconcilerDeps, automation: Automation, igId: string, token: string): Promise<number> {
  const now = deps.now();
  const since = Math.max(
    automation.createdAt,
    (automation.lastReconciledAt ?? automation.createdAt) - RECONCILE_OVERLAP_MS,
    now - COMMENT_WINDOW_MS,
  );
  let queued = 0;
  let cursor: string | undefined;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const { comments, nextCursor } = await deps.client.listComments(token, automation.mediaId, cursor);
    let reachedOld = false;
    for (const comment of comments) {
      const createdAt = Date.parse(comment.timestamp.replace(/\+0000$/, 'Z'));
      if (createdAt < since) {
        reachedOld = true;
        continue;
      }
      if (!comment.fromId || comment.hidden) continue;
      const outcome = handleComment(
        { db: deps.db, now: deps.now, random: deps.random },
        {
          accountIgId: igId,
          commentId: comment.id,
          fromId: comment.fromId,
          fromUsername: comment.fromUsername,
          isSelf: false,
          text: comment.text,
          mediaId: automation.mediaId,
          createdAt,
          source: 'reconciler',
        },
      );
      if (outcome.kind === 'queued') queued += 1;
    }
    if (reachedOld || !nextCursor) break;
    cursor = nextCursor;
  }
  setLastReconciledAt(deps.db, automation.id, now);
  return queued;
}

/** Varre os posts com automação ativa para recuperar comentários cujo webhook não chegou (spec §6.4). */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<{ checked: number; queued: number }> {
  let checked = 0;
  let queued = 0;
  for (const automation of listActiveAutomations(deps.db)) {
    const account = getAccountById(deps.db, automation.accountId);
    if (!account || !isAccountUsable(account, deps.now())) continue;
    try {
      queued += await reconcileAutomation(deps, automation, account.igId, deps.decryptToken(account.tokenEnc!));
      checked += 1;
    } catch (error) {
      const c = classifyError(error);
      deps.log.warn({ automationId: automation.id, kind: c.kind, code: c.code, message: c.message }, 'falha na reconciliação');
      if (c.kind === 'auth') setAccountStatus(deps.db, account.id, 'reconnect_required', deps.now(), { lastError: c.message });
    }
  }
  return { checked, queued };
}
```


`src/engine/maintenance.ts`:

```ts
import type { DB } from '../db/database.js';
import { listAccounts, setAccountStatus, updateAccountToken } from '../db/repos/accounts.js';
import { purgeInteractionsBefore, refreshInteractionStatus } from '../db/repos/interactions.js';
import { cancelJobsOlderThan } from '../db/repos/jobs.js';
import { purgeWebhookEventsBefore } from '../db/repos/webhookEvents.js';
import type { LongLivedToken } from '../instagram/oauth.js';
import { classifyError } from '../instagram/errors.js';
import { COMMENT_WINDOW_MS } from './pacing.js';

const DAY_MS = 86_400_000;
export const TOKEN_MIN_AGE_MS = DAY_MS;
export const TOKEN_REFRESH_WINDOW_MS = 30 * DAY_MS;
export const WEBHOOK_EVENTS_RETENTION_MS = 30 * DAY_MS;
export const INTERACTIONS_RETENTION_MS = 90 * DAY_MS;

export interface TokenRefreshDeps {
  db: DB;
  refresh: (token: string) => Promise<LongLivedToken>;
  encrypt: (plain: string) => string;
  decrypt: (encoded: string) => string;
  now: () => number;
  log: { warn: (obj: object, msg: string) => void };
}

/** Renova tokens com ≥ 24h de idade que vencem em ≤ 30 dias (spec §6.5). */
export async function refreshExpiringTokens(deps: TokenRefreshDeps): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;
  for (const account of listAccounts(deps.db)) {
    const now = deps.now();
    if (!account.tokenEnc || account.tokenExpiresAt === null || account.status === 'disconnected') continue;
    const age = now - (account.tokenRefreshedAt ?? account.connectedAt);
    if (age < TOKEN_MIN_AGE_MS || account.tokenExpiresAt - now > TOKEN_REFRESH_WINDOW_MS) continue;
    try {
      const token = await deps.refresh(deps.decrypt(account.tokenEnc));
      updateAccountToken(deps.db, account.id, deps.encrypt(token.accessToken), now + token.expiresInSec * 1000, now);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      const c = classifyError(error);
      deps.log.warn({ accountId: account.id, kind: c.kind, code: c.code }, 'falha ao renovar token');
      if (c.kind === 'auth') setAccountStatus(deps.db, account.id, 'reconnect_required', now, { lastError: c.message });
    }
  }
  return { refreshed, failed };
}

/** Cancela jobs fora da janela de 7 dias e aplica a retenção de dados (spec §12). */
export function runHousekeeping(db: DB, now: number): { cancelled: number; events: number; interactions: number } {
  const affected = cancelJobsOlderThan(db, now - COMMENT_WINDOW_MS, now);
  for (const interactionId of affected) refreshInteractionStatus(db, interactionId);
  return {
    cancelled: affected.length,
    events: purgeWebhookEventsBefore(db, now - WEBHOOK_EVENTS_RETENTION_MS),
    interactions: purgeInteractionsBefore(db, now - INTERACTIONS_RETENTION_MS),
  };
}
```


`src/engine/scheduler.ts`:

```ts
export interface ScheduledTask {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown> | unknown;
  /** Executa logo ao iniciar, além de a cada intervalo. */
  runOnStart?: boolean;
}

export interface Health {
  lastWorkerTickAt: number | null;
}

/** Timers simples sem sobreposição: se uma execução ainda está rodando, a próxima é pulada. */
export function startScheduler(
  tasks: ScheduledTask[],
  log: { error: (obj: object, msg: string) => void },
): { stop: () => Promise<void> } {
  const running = new Map<string, Promise<void>>();
  const timers: NodeJS.Timeout[] = [];

  const trigger = (task: ScheduledTask) => {
    if (running.has(task.name)) return;
    // Promise.resolve().then(): a tarefa só começa depois do `set`, mesmo se lançar erro de forma síncrona.
    const execution = Promise.resolve()
      .then(task.run)
      .then(
        () => undefined,
        (error: unknown) => log.error({ task: task.name, err: error }, 'tarefa agendada falhou'),
      )
      .finally(() => running.delete(task.name));
    running.set(task.name, execution);
  };

  for (const task of tasks) {
    if (task.runOnStart) trigger(task);
    timers.push(setInterval(() => trigger(task), task.intervalMs));
  }

  return {
    async stop() {
      timers.forEach(clearInterval);
      await Promise.all(running.values());
    },
  };
}
```


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  80 passed (80)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/reconciler.test.ts test/maintenance.test.ts test/scheduler.test.ts src/engine/reconciler.ts src/engine/maintenance.ts src/engine/scheduler.ts
git commit -m "feat(engine): reconciliação, renovação de tokens, retenção e agendador"
```

---

### Task 10: Servidor HTTP: webhook assinado e rotas públicas exigidas pela Meta

**Objetivo:** Fastify com helmet (CSP restrita), sessão criptografada, estáticos; rota do webhook com corpo bruto e HMAC; privacidade, desautorização, exclusão de dados e healthcheck.

**Files:**
- Test: `test/helpers/app.ts`
- Test: `test/http-webhooks.test.ts`
- Test: `test/http-public.test.ts`
- Create: `src/http/session.ts`
- Create: `src/http/redirect.ts`
- Create: `src/app.ts`
- Create: `src/webhooks/routes.ts`
- Create: `src/public/views.ts`
- Create: `src/public/routes.ts`
- Create: `public/assets/.gitkeep`

**Interfaces:**
- Produces (`app.ts`): `interface AppDeps { config, db, client, oauth, cipher, health, now, random, fetchImage?, logger? }`, `buildApp(deps): Promise<FastifyInstance>`.
- Produces (`http/session.ts`): augmentation de `SessionData` (`userId`, `csrf`, `oauthState`, `flash`), `ensureCsrfToken`, `verifyCsrf` (hook), `setFlash`, `takeFlash`, `type Flash`.
- Produces (`http/redirect.ts`): `redirectAfterAction(request, reply, url)` (HX-Redirect para htmx, 302 caso contrário).
- Rotas: `GET/POST /webhooks/instagram`, `GET /healthz`, `GET /privacidade`, `POST /meta/deauthorize`, `POST /meta/data-deletion`, `GET /meta/data-deletion/status`.
- Test helper: `buildTestApp(options?)`, `testConfig`, `fakeOAuth`, `cookieFrom`, `csrfFrom`, `login(app, db)`, `form(data)`.
- `src/app.ts` nesta task ainda **não** registra o painel (entra na Task 11).

- [ ] **Step 1: Escrever os testes (falhando)**

`test/helpers/app.ts`:

```ts
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createUser, findUserByEmail } from '../../src/db/repos/users.js';
import type { InstagramOAuth } from '../../src/instagram/oauth.js';
import { createTokenCipher } from '../../src/lib/crypto.js';
import { makeDb, T0 } from './db.js';
import { createFakeInstagram } from './fakeInstagram.js';

const KEY = Buffer.alloc(32, 9).toString('base64');

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://dm.example.com',
    CONTACT_EMAIL: 'contato@example.com',
    IG_APP_ID: 'IGAPP',
    IG_APP_SECRET: 'ig-secret',
    META_APP_SECRET: 'meta-secret',
    WEBHOOK_VERIFY_TOKEN: 'verify-token-1234567890',
    ENCRYPTION_KEY: KEY,
    SESSION_SECRET: KEY,
    IG_ALLOWED_USERNAMES: 'loja',
    ...overrides,
  });
}

export function fakeOAuth(overrides: Partial<InstagramOAuth> = {}): InstagramOAuth {
  return {
    authorizeUrl: (state) => `https://www.instagram.com/oauth/authorize?state=${state}`,
    exchangeCode: async () => ({
      accessToken: 'SHORT',
      permissions: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages'],
    }),
    exchangeForLongLived: async () => ({ accessToken: 'LONG', expiresInSec: 60 * 86_400 }),
    refresh: async () => ({ accessToken: 'LONG2', expiresInSec: 60 * 86_400 }),
    ...overrides,
  };
}

export async function buildTestApp(options: { config?: Record<string, string>; oauth?: Partial<InstagramOAuth>; fetchImage?: typeof fetch } = {}) {
  const db = makeDb();
  const client = createFakeInstagram();
  const config = testConfig(options.config);
  const cipher = createTokenCipher(config.ENCRYPTION_KEY);
  const now = { value: T0 };
  const app = await buildApp({
    config,
    db,
    client,
    oauth: fakeOAuth(options.oauth),
    cipher,
    health: { lastWorkerTickAt: T0 },
    now: () => now.value,
    random: () => 0,
    fetchImage: options.fetchImage,
  });
  return { app, db, client, cipher, config, now };
}

export function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(first ?? '').split(';')[0] ?? '';
}

export function csrfFrom(body: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(body) ?? /"x-csrf-token": "([^"]+)"/.exec(body);
  if (!match?.[1]) throw new Error('CSRF não encontrado na página');
  return match[1];
}

/** Cria o usuário, faz login e devolve cookie + CSRF prontos para as próximas requisições. */
export async function login(app: FastifyInstance, db: ReturnType<typeof makeDb>): Promise<{ cookie: string; csrf: string }> {
  if (!findUserByEmail(db, 'esposa@example.com')) createUser(db, 'esposa@example.com', await hash('senha-forte'), T0);
  const page = await app.inject({ method: 'GET', url: '/entrar' });
  const res = await app.inject({
    method: 'POST',
    url: '/entrar',
    headers: { cookie: cookieFrom(page), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ _csrf: csrfFrom(page.body), email: 'esposa@example.com', password: 'senha-forte' }).toString(),
  });
  if (res.statusCode !== 302) throw new Error(`login falhou: ${res.statusCode}`);
  const cookie = cookieFrom(res);
  const home = await app.inject({ method: 'GET', url: '/contas', headers: { cookie } });
  return { cookie: cookieFrom(home) || cookie, csrf: csrfFrom(home.body) };
}

export const form = (data: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) for (const v of [value].flat()) params.append(key, v);
  return params.toString();
};
```


`test/http-webhooks.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seedAccount, seedAutomation } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';

const payload = JSON.stringify({
  object: 'instagram',
  entry: [{ id: 'IG1', time: 1, changes: [{ field: 'comments', value: { id: 'C1', from: { id: 'U1', username: 'ana' }, text: 'Eu quero!', media: { id: 'M1' } } }] }],
});
const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('/webhooks/instagram', () => {
  it('GET responde o hub.challenge com o verify token certo e 403 caso contrário', async () => {
    const { app } = await buildTestApp();
    const ok = await app.inject({ url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-token-1234567890&hub.challenge=1158201444' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    const bad = await app.inject({ url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('POST com assinatura inválida é rejeitado e nada é gravado', async () => {
    const { app, db } = await buildTestApp();
    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram', payload,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload, 'outro') },
    });
    expect(res.statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get()).toEqual({ n: 0 });
  });

  it('POST válido grava o evento, cria a interação e responde 200; reentrega não duplica', async () => {
    const { app, db } = await buildTestApp();
    seedAutomation(db, seedAccount(db).id);
    for (const secret of ['ig-secret', 'meta-secret']) {
      const res = await app.inject({
        method: 'POST', url: '/webhooks/instagram', payload,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload, secret) },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM interactions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 });
  });
});
```


`test/http-public.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAccountById } from '../src/db/repos/accounts.js';
import { buildTestApp, form } from './helpers/app.js';
import { seedAccount, seedAutomation, T0 } from './helpers/db.js';

const signedRequest = (userId: string, secret = 'ig-secret') => {
  const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: userId, issued_at: 1 })).toString('base64url');
  return `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
};

describe('rotas públicas', () => {
  it('/healthz: 200 com worker recente, 503 se o worker parou', async () => {
    const t = await buildTestApp();
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    t.now.value = T0 + 120_000;
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(503);
  });

  it('/privacidade é pública, em português e inglês, com cabeçalhos de segurança', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ url: '/privacidade' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Política de Privacidade');
    expect(res.body).toContain('Privacy Policy');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('/meta/deauthorize desconecta a conta do signed_request válido', async () => {
    const { app, db } = await buildTestApp();
    const account = seedAccount(db);
    seedAutomation(db, account.id);
    const bad = await app.inject({
      method: 'POST', url: '/meta/deauthorize', payload: form({ signed_request: signedRequest('APP-IG1', 'x') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({
      method: 'POST', url: '/meta/deauthorize', payload: form({ signed_request: signedRequest('APP-IG1') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(getAccountById(db, account.id)).toMatchObject({ status: 'disconnected', tokenEnc: null });
  });

  it('/meta/data-deletion apaga a conta e devolve url + confirmation_code consultável', async () => {
    const { app, db } = await buildTestApp();
    const account = seedAccount(db);
    const res = await app.inject({
      method: 'POST', url: '/meta/data-deletion', payload: form({ signed_request: signedRequest('IG1', 'meta-secret') }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const body = res.json() as { url: string; confirmation_code: string };
    expect(body.url).toBe(`https://dm.example.com/meta/data-deletion/status?code=${body.confirmation_code}`);
    expect(getAccountById(db, account.id)).toBeUndefined();
    const status = await app.inject({ url: `/meta/data-deletion/status?code=${body.confirmation_code}` });
    expect(status.statusCode).toBe(200);
    expect(status.body).toContain('Exclusão concluída');
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/http-webhooks.test.ts test/http-public.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/http/session.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomToken } from '../lib/crypto.js';

export interface Flash {
  kind: 'success' | 'error';
  message: string;
}

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: number;
    csrf: string;
    oauthState: string;
    flash: Flash;
  }
}

export function ensureCsrfToken(request: FastifyRequest): string {
  let token = request.session.get('csrf');
  if (!token) {
    token = randomToken();
    request.session.set('csrf', token);
  }
  return token;
}

/** Hook de POST do painel: exige o token CSRF da sessão no campo `_csrf` ou no cabeçalho `x-csrf-token` (htmx). */
export async function verifyCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method !== 'POST') return;
  const expected = request.session.get('csrf');
  const body = (request.body ?? {}) as Record<string, unknown>;
  const received = (typeof body._csrf === 'string' ? body._csrf : undefined) ?? request.headers['x-csrf-token'];
  if (!expected || received !== expected) {
    await reply.code(403).type('text/plain; charset=utf-8').send('Sessão expirada. Recarregue a página e tente de novo.');
  }
}

export function setFlash(request: FastifyRequest, flash: Flash): void {
  request.session.set('flash', flash);
}

export function takeFlash(request: FastifyRequest): Flash | null {
  const flash = request.session.get('flash') ?? null;
  if (flash) request.session.set('flash', undefined);
  return flash;
}
```


`src/http/redirect.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Redireciona após uma ação. Em requisições htmx usa o cabeçalho HX-Redirect (um 302 seria seguido
 * pelo XHR e a página inteira seria trocada dentro do botão).
 */
export function redirectAfterAction(request: FastifyRequest, reply: FastifyReply, url: string): FastifyReply {
  if (request.headers['hx-request']) return reply.header('HX-Redirect', url).code(204).send();
  return reply.redirect(url);
}
```


`src/app.ts` (versão desta task, ainda sem o painel):

```ts
import { fileURLToPath } from 'node:url';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import secureSession from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/database.js';
import type { Health } from './engine/scheduler.js';
import type { FetchFn, InstagramClient } from './instagram/client.js';
import type { InstagramOAuth } from './instagram/oauth.js';
import type { TokenCipher } from './lib/crypto.js';
import { registerPublicRoutes } from './public/routes.js';
import { registerWebhookRoutes } from './webhooks/routes.js';

export interface AppDeps {
  config: Config;
  db: DB;
  client: InstagramClient;
  oauth: InstagramOAuth;
  cipher: TokenCipher;
  health: Health;
  now: () => number;
  random: () => number;
  /** fetch usado pelo proxy de miniaturas (injeção para testes). */
  fetchImage?: FetchFn;
  logger?: FastifyServerOptions['logger'];
}

const SESSION_DAYS = 30;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // A porta só é publicada em 127.0.0.1 na VPS: apenas o Nginx do host alcança o app.
    trustProxy: true,
    logger: deps.logger ?? false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'", 'https://www.instagram.com'],
        frameAncestors: ["'none'"],
      },
    },
    // O redirect do OAuth volta do instagram.com: o Referer padrão "no-referrer" não atrapalha, mas mantemos explícito.
    referrerPolicy: { policy: 'same-origin' },
  });
  await app.register(formbody);
  await app.register(secureSession, {
    key: Buffer.from(deps.config.SESSION_SECRET, 'base64'),
    cookieName: 'sid',
    expiry: SESSION_DAYS * 86_400,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.config.NODE_ENV === 'production',
      maxAge: SESSION_DAYS * 86_400,
    },
  });
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public/assets', import.meta.url)),
    prefix: '/assets/',
    maxAge: '7d',
  });

  await app.register(registerWebhookRoutes, deps);
  await app.register(registerPublicRoutes, deps);
  return app;
}
```


`src/webhooks/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { insertWebhookEvent } from '../db/repos/webhookEvents.js';
import { handleComment } from '../engine/matcher.js';
import { verifyHubSignature } from '../lib/crypto.js';
import { extractCommentEvents } from './parsePayload.js';

/** GET (verificação) e POST (eventos) em /webhooks/instagram — spec §6.1. */
export async function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Encapsulado neste plugin: o corpo JSON chega como Buffer bruto para validar a assinatura.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.get('/webhooks/instagram', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === deps.config.WEBHOOK_VERIFY_TOKEN) {
      return reply.type('text/plain').send(query['hub.challenge'] ?? '');
    }
    return reply.code(403).send('forbidden');
  });

  app.post('/webhooks/instagram', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const signature = request.headers['x-hub-signature-256'];
    if (!verifyHubSignature(raw, typeof signature === 'string' ? signature : undefined, deps.config.META_WEBHOOK_SECRETS)) {
      request.log.warn('webhook com assinatura inválida descartado');
      return reply.code(403).send('invalid signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send('invalid json');
    }

    insertWebhookEvent(deps.db, raw.toString('utf8'), deps.now());
    for (const event of extractCommentEvents(payload)) {
      try {
        const outcome = handleComment(
          { db: deps.db, now: deps.now, random: deps.random },
          { ...event, source: 'webhook' },
        );
        request.log.info({ commentId: event.commentId, outcome }, 'comentário processado');
      } catch (error) {
        request.log.error({ err: error, commentId: event.commentId }, 'erro ao processar comentário');
      }
    }
    return reply.code(200).send('EVENT_RECEIVED');
  });
}
```


`src/public/views.ts`:

```ts
import { html, type SafeHtml } from '../lib/html.js';

export function publicPage(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="bg-background text-foreground antialiased">
  <main class="prose-sm mx-auto max-w-2xl space-y-4 px-4 py-10 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">${body}</main>
</body>
</html>`.value;
}

export function privacyPolicy(input: { contactEmail: string; updatedAt: string }): SafeHtml {
  return html`
  <h1>Política de Privacidade</h1>
  <p><em>Atualizada em ${input.updatedAt}.</em></p>
  <p>Este sistema ("Respostas automáticas") é uma ferramenta de uso exclusivo dos titulares das contas profissionais do Instagram
    conectadas a ele. Ele responde comentários com palavras-chave definidas pelo titular e envia uma única mensagem privada a quem comentou,
    usando a API oficial da Meta (Instagram Platform).</p>
  <h2>Dados tratados</h2>
  <ul>
    <li>Da conta conectada: identificador, nome de usuário e token de acesso (armazenado criptografado).</li>
    <li>De quem comenta nos posts com automação ativa: identificador escopado do Instagram, nome de usuário, texto do comentário e o status das respostas enviadas.</li>
  </ul>
  <h2>Finalidade</h2>
  <p>Os dados são usados apenas para identificar comentários com palavras-chave, responder a eles e mostrar o histórico ao titular da conta.
    Não vendemos, compartilhamos ou usamos os dados para publicidade ou qualquer outra finalidade.</p>
  <h2>Retenção</h2>
  <p>Registros de comentários e respostas são apagados automaticamente após 90 dias; notificações técnicas recebidas da Meta, após 30 dias.
    Ao desconectar uma conta, o token de acesso é apagado imediatamente.</p>
  <h2>Exclusão de dados</h2>
  <p>O titular pode remover o app nas configurações do Instagram (Configurações › Apps e sites), o que dispara a exclusão automática dos dados
    da conta. Qualquer pessoa pode pedir a exclusão dos seus dados pelo e-mail <a href="mailto:${input.contactEmail}">${input.contactEmail}</a>.</p>

  <h1 lang="en">Privacy Policy (English)</h1>
  <p lang="en">This private tool is used only by the owners of the connected Instagram professional accounts. It replies to comments containing
    owner-defined keywords and sends one private reply to the commenter through Meta's official Instagram Platform API. We process the connected
    account's ID, username and access token (encrypted), and, for commenters on posts with an active automation, their Instagram-scoped ID,
    username, comment text and reply status. Data is used solely to provide this feature, is never sold or shared, and is deleted automatically after
    90 days (technical webhook logs after 30 days). Removing the app from Instagram triggers deletion of the account's data. Deletion requests:
    <a href="mailto:${input.contactEmail}">${input.contactEmail}</a>.</p>`;
}
```


`src/public/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { deleteAccount, disconnectAccount, findAccountsByAnyUserId } from '../db/repos/accounts.js';
import { findDeletionRequest, insertDeletionRequest } from '../db/repos/deletionRequests.js';
import { html } from '../lib/html.js';
import { parseSignedRequest, randomToken } from '../lib/crypto.js';
import { privacyPolicy, publicPage } from './views.js';

const HEALTH_MAX_WORKER_SILENCE_MS = 60_000;

/** Rotas públicas exigidas pela Meta (spec §12) + healthcheck. */
export async function registerPublicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const secrets = [deps.config.IG_APP_SECRET, deps.config.META_APP_SECRET];

  app.get('/healthz', async (_request, reply) => {
    deps.db.prepare('SELECT 1').get();
    const last = deps.health.lastWorkerTickAt;
    const workerOk = last !== null && deps.now() - last < HEALTH_MAX_WORKER_SILENCE_MS;
    return reply.code(workerOk ? 200 : 503).send({ status: workerOk ? 'ok' : 'worker_stalled' });
  });

  app.get('/privacidade', async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(publicPage('Política de Privacidade', privacyPolicy({ contactEmail: deps.config.CONTACT_EMAIL, updatedAt: '27/10/2026' }))),
  );

  app.post('/meta/deauthorize', async (request, reply) => {
    const payload = parseSignedRequest(String((request.body as { signed_request?: string })?.signed_request ?? ''), secrets);
    if (!payload) return reply.code(400).send({ error: 'invalid signed_request' });
    for (const account of findAccountsByAnyUserId(deps.db, payload.user_id)) disconnectAccount(deps.db, account.id, deps.now());
    return reply.send({ success: true });
  });

  app.post('/meta/data-deletion', async (request, reply) => {
    const payload = parseSignedRequest(String((request.body as { signed_request?: string })?.signed_request ?? ''), secrets);
    if (!payload) return reply.code(400).send({ error: 'invalid signed_request' });
    const code = randomToken(12);
    deps.db.transaction(() => {
      for (const account of findAccountsByAnyUserId(deps.db, payload.user_id)) deleteAccount(deps.db, account.id);
      insertDeletionRequest(deps.db, code, payload.user_id, deps.now());
    })();
    return reply.send({ url: `${deps.config.APP_BASE_URL}/meta/data-deletion/status?code=${code}`, confirmation_code: code });
  });

  app.get('/meta/data-deletion/status', async (request, reply) => {
    const code = String((request.query as { code?: string }).code ?? '');
    const found = code ? findDeletionRequest(deps.db, code) : undefined;
    const body = found
      ? html`<h1>Exclusão concluída</h1><p>Solicitação <code>${found.code}</code>: os dados da conta foram excluídos em
          ${new Date(found.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.</p>`
      : html`<h1>Solicitação não encontrada</h1><p>Verifique o código informado.</p>`;
    return reply.code(found ? 200 : 404).type('text/html; charset=utf-8').send(publicPage('Exclusão de dados', body));
  });
}
```


`public/assets/.gitkeep`:

_(arquivo vazio — só garante que a pasta exista no git)_


- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  87 passed (87)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/app.ts test/http-webhooks.test.ts test/http-public.test.ts src/http/session.ts src/http/redirect.ts src/app.ts src/webhooks/routes.ts src/public/views.ts src/public/routes.ts public/assets/.gitkeep
git commit -m "feat(http): webhook assinado, páginas públicas e healthcheck"
```

---

### Task 11: Painel: base visual, login e tela Contas (Business Login)

**Objetivo:** Primeira tela utilizável: login com limite de tentativas, CSRF, layout mobile-first no estilo shadcn, conexão de contas via Business Login (state, allowlist, permissões, subscribed_apps) e proxy de miniaturas.

**Files:**
- Test: `test/loginThrottle.test.ts`
- Test: `test/http-auth.test.ts`
- Test: `test/http-accounts.test.ts`
- Create: `src/panel/styles.css`
- Create: `public/assets/app.js`
- Create: `scripts/copy-assets.mjs`
- Create: `src/panel/views/components.ts`
- Create: `src/panel/views/messages.ts`
- Create: `src/panel/views/layout.ts`
- Create: `src/panel/views/loginPage.ts`
- Create: `src/panel/views/accountsPage.ts`
- Create: `src/panel/context.ts`
- Create: `src/panel/loginThrottle.ts`
- Create: `src/media/thumbnails.ts`
- Create: `src/accounts/connect.ts`
- Create: `src/panel/routes/auth.ts`
- Create: `src/panel/routes/accounts.ts`
- Create: `src/panel/register.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `AppDeps`/`buildApp` (Task 10), repositórios (Task 5), `InstagramClient`/`InstagramOAuth` (Task 4).
- Produces (`panel/context.ts`): `interface PanelContext extends AppDeps { thumbnails, render(request, reply, { title, body, nav?, status? }) }`.
- Produces (`panel/views/components.ts`) — **contrato do design system** (a Task 15 refina o visual sem mudar nomes/assinaturas): `icon(name, className?)`, `buttonClass(variant?, extra?)`, `badge(text, tone?)`, `card(content, extra?)`, `alertBox(tone, title, body?)`, `emptyState(icon, title, text, action?)`, `inputClass(extra?)`, `textareaClass(extra?)`, `fieldError(message, id)`, `csrfInput(token)`, `formatDateTime(ms)`; tokens CSS `--color-{background,foreground,card,primary,secondary,muted-foreground,accent,destructive,success,warning,border,input,ring}`.
- Produces: `layout(props: LayoutProps): string`, `type NavKey`, `accountStatus(account, now)`, `FAIL_REASON_TEXT`, `SKIP_REASON_TEXT`, `JOB_STATUS`, `createLoginThrottle`, `createThumbnailService(...)`/`ThumbnailService`, `completeConnection(deps, code)`/`ConnectError`, `OAUTH_CALLBACK_PATH = '/auth/instagram/callback'`, `registerPanel(app, deps)`.
- Rotas: `GET/POST /entrar`, `POST /sair`, `GET /` → `/automacoes`, `GET /contas`, `GET /contas/conectar`, `GET /auth/instagram/callback`, `POST /contas/:id/desconectar`, `GET /midia/:accountId/:mediaId`.
- CSP: sem handlers inline (`onclick`, `onsubmit`…); confirmações com `hx-confirm`; `htmx-config` desliga estilos inline do htmx.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/loginThrottle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLoginThrottle } from '../src/panel/loginThrottle.js';

describe('createLoginThrottle', () => {
  it('bloqueia após `max` falhas e libera ao fim da janela ou após sucesso', () => {
    let now = 0;
    const throttle = createLoginThrottle({ max: 2, windowMs: 1000, now: () => now });
    throttle.registerFailure('ip');
    expect(throttle.isBlocked('ip')).toBe(false);
    throttle.registerFailure('ip');
    expect(throttle.isBlocked('ip')).toBe(true);
    expect(throttle.isBlocked('outro-ip')).toBe(false);
    now = 1000;
    expect(throttle.isBlocked('ip')).toBe(false);
    throttle.registerFailure('ip');
    throttle.reset('ip');
    throttle.registerFailure('ip');
    expect(throttle.isBlocked('ip')).toBe(false);
  });
});
```


`test/http-auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp, cookieFrom, csrfFrom, form, login } from './helpers/app.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('login do painel', () => {
  it('redireciona para /entrar sem sessão', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ url: '/contas' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/entrar');
  });

  it('login correto dá acesso; sair encerra a sessão', async () => {
    const { app, db } = await buildTestApp();
    const session = await login(app, db);
    const page = await app.inject({ url: '/contas', headers: { cookie: session.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Conectar conta do Instagram');
    const out = await app.inject({ method: 'POST', url: '/sair', headers: { cookie: session.cookie, ...FORM }, payload: form({ _csrf: session.csrf }) });
    expect(out.headers.location).toBe('/entrar');
    const after = await app.inject({ url: '/contas', headers: { cookie: cookieFrom(out) } });
    expect(after.statusCode).toBe(302);
  });

  it('POST sem CSRF é recusado com 403', async () => {
    const { app, db } = await buildTestApp();
    const session = await login(app, db);
    const res = await app.inject({ method: 'POST', url: '/sair', headers: { cookie: session.cookie, ...FORM }, payload: '' });
    expect(res.statusCode).toBe(403);
  });

  it('senha errada mostra erro e bloqueia após 5 falhas', async () => {
    const { app } = await buildTestApp();
    const page = await app.inject({ url: '/entrar' });
    const cookie = cookieFrom(page);
    const attempt = () =>
      app.inject({ method: 'POST', url: '/entrar', headers: { cookie, ...FORM }, payload: form({ _csrf: csrfFrom(page.body), email: 'x@y.com', password: 'errada' }) });
    for (let i = 0; i < 5; i += 1) {
      const res = await attempt();
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('E-mail ou senha incorretos.');
    }
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain('Muitas tentativas');
  });
});
```


`test/http-accounts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getAccountByIgId } from '../src/db/repos/accounts.js';
import { buildTestApp, cookieFrom, form, login } from './helpers/app.js';
import { seedAccount } from './helpers/db.js';

async function startConnect(t: Awaited<ReturnType<typeof buildTestApp>>) {
  const session = await login(t.app, t.db);
  const res = await t.app.inject({ url: '/contas/conectar', headers: { cookie: session.cookie } });
  const state = new URL(String(res.headers.location)).searchParams.get('state')!;
  return { cookie: cookieFrom(res) || session.cookie, state, csrf: session.csrf };
}

describe('contas', () => {
  it('conecta a conta: troca tokens, assina comments e salva token criptografado', async () => {
    const t = await buildTestApp();
    t.client.getProfile.mockResolvedValue({ igId: 'IG9', appUserId: 'APP9', username: 'Loja', accountType: 'Business' });
    const { cookie, state } = await startConnect(t);
    const res = await t.app.inject({ url: `/auth/instagram/callback?code=abc&state=${state}`, headers: { cookie } });
    expect(res.headers.location).toBe('/contas');
    expect(t.client.subscribeToComments).toHaveBeenCalledWith('LONG');
    const account = getAccountByIgId(t.db, 'IG9')!;
    expect(account.tokenEnc).not.toBe('LONG');
    expect(t.cipher.decrypt(account.tokenEnc!)).toBe('LONG');
    const page = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(res) || cookie } });
    expect(page.body).toContain('Conta @Loja conectada!');
    expect(page.body).toContain('válido até');
  });

  it('recusa state inválido, conta fora da allowlist e permissões faltando', async () => {
    const t = await buildTestApp({ oauth: { exchangeCode: async () => ({ accessToken: 'S', permissions: ['instagram_business_basic'] }) } });
    const { cookie, state } = await startConnect(t);
    const wrongState = await t.app.inject({ url: '/auth/instagram/callback?code=abc&state=outro', headers: { cookie } });
    const page1 = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(wrongState) || cookie } });
    expect(page1.body).toContain('Link de conexão expirado');

    const again = await startConnect(t);
    const missing = await t.app.inject({ url: `/auth/instagram/callback?code=abc&state=${again.state}`, headers: { cookie: again.cookie } });
    const page2 = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(missing) || again.cookie } });
    expect(page2.body).toContain('Faltou autorizar todas as permissões');
    expect(state).toBeTruthy();
  });

  it('recusa conta que não está na allowlist (exceto em REVIEW_MODE)', async () => {
    const t = await buildTestApp();
    t.client.getProfile.mockResolvedValue({ igId: 'IGX', appUserId: 'APPX', username: 'estranha', accountType: 'Business' });
    const { cookie, state } = await startConnect(t);
    const res = await t.app.inject({ url: `/auth/instagram/callback?code=abc&state=${state}`, headers: { cookie } });
    const page = await t.app.inject({ url: '/contas', headers: { cookie: cookieFrom(res) || cookie } });
    expect(page.body).toContain('não está autorizada');
    expect(getAccountByIgId(t.db, 'IGX')).toBeUndefined();
  });

  it('desconectar via htmx responde HX-Redirect e apaga o token', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db);
    const session = await login(t.app, t.db);
    const res = await t.app.inject({
      method: 'POST', url: `/contas/${account.id}/desconectar`,
      headers: { cookie: session.cookie, 'hx-request': 'true', 'x-csrf-token': session.csrf, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({}),
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['hx-redirect']).toBe('/contas');
    expect(getAccountByIgId(t.db, 'IG1')).toMatchObject({ status: 'disconnected', tokenEnc: null });
  });

  it('proxy de miniatura só busca hosts do CDN do Instagram e usa placeholder nos demais casos', async () => {
    const images: string[] = [];
    const fetchImage = (async (url: string | URL | Request) => {
      images.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const t = await buildTestApp({ fetchImage });
    const account = seedAccount(t.db, { tokenEnc: '' });
    t.db.prepare('UPDATE ig_accounts SET token_enc = ? WHERE id = ?').run(t.cipher.encrypt('TOKEN'), account.id);
    const session = await login(t.app, t.db);
    t.client.getMedia.mockResolvedValueOnce({ id: '111', mediaType: 'IMAGE', permalink: 'p', timestamp: 't', mediaUrl: 'https://scontent.cdninstagram.com/a.jpg' });
    const ok = await t.app.inject({ url: `/midia/${account.id}/111`, headers: { cookie: session.cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    t.client.getMedia.mockResolvedValueOnce({ id: '222', mediaType: 'IMAGE', permalink: 'p', timestamp: 't', mediaUrl: 'https://evil.example.com/a.jpg' });
    const blocked = await t.app.inject({ url: `/midia/${account.id}/222`, headers: { cookie: session.cookie } });
    expect(blocked.headers['content-type']).toContain('image/svg+xml'); // placeholder, sem buscar o host desconhecido
    expect(images).toEqual(['https://scontent.cdninstagram.com/a.jpg']);
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/loginThrottle.test.ts test/http-auth.test.ts test/http-accounts.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/panel/styles.css`:

```css
@import "tailwindcss";

/* Varre os templates TypeScript em busca das classes usadas. */
@source "../";

/*
 * Tokens no estilo shadcn/ui (neutros + 1 cor de destaque). A Task de design com a skill
 * impeccable pode ajustar valores — os NOMES dos tokens são o contrato usado nos componentes.
 */
@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

  --color-background: hsl(0 0% 100%);
  --color-foreground: hsl(240 10% 3.9%);
  --color-card: hsl(0 0% 100%);
  --color-card-foreground: hsl(240 10% 3.9%);
  --color-primary: hsl(262 83% 58%);
  --color-primary-foreground: hsl(0 0% 100%);
  --color-secondary: hsl(240 4.8% 95.9%);
  --color-secondary-foreground: hsl(240 5.9% 10%);
  --color-muted-foreground: hsl(240 3.8% 46.1%);
  --color-accent: hsl(240 4.8% 95.9%);
  --color-accent-foreground: hsl(240 5.9% 10%);
  --color-destructive: hsl(0 72% 51%);
  --color-destructive-foreground: hsl(0 0% 100%);
  --color-success: hsl(142 72% 29%);
  --color-warning: hsl(32 95% 38%);
  --color-border: hsl(240 5.9% 90%);
  --color-input: hsl(240 5.9% 90%);
  --color-ring: hsl(262 83% 58%);
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-background: hsl(240 10% 3.9%);
    --color-foreground: hsl(0 0% 98%);
    --color-card: hsl(240 10% 5.5%);
    --color-card-foreground: hsl(0 0% 98%);
    --color-primary: hsl(263 70% 66%);
    --color-primary-foreground: hsl(240 10% 3.9%);
    --color-secondary: hsl(240 3.7% 15.9%);
    --color-secondary-foreground: hsl(0 0% 98%);
    --color-muted-foreground: hsl(240 5% 64.9%);
    --color-accent: hsl(240 3.7% 15.9%);
    --color-accent-foreground: hsl(0 0% 98%);
    --color-destructive: hsl(0 72% 60%);
    --color-success: hsl(142 60% 50%);
    --color-warning: hsl(38 92% 55%);
    --color-border: hsl(240 3.7% 15.9%);
    --color-input: hsl(240 3.7% 20%);
  }
}

@layer base {
  html {
    -webkit-tap-highlight-color: transparent;
  }
  :focus-visible {
    outline-color: var(--color-ring);
  }
}
```


`public/assets/app.js`:

```js
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
      preview.textContent = first ? first.replace(/\{usuario\}/gi, '@maria').replace(/\s{2,}/g, ' ') : 'Escreva uma versão para ver a prévia.';
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
```


`scripts/copy-assets.mjs`:

```js
import { copyFileSync, mkdirSync } from 'node:fs';

// Copia o htmx para ser servido pelo próprio app (CSP 'self', sem CDN).
mkdirSync('public/assets', { recursive: true });
copyFileSync('node_modules/htmx.org/dist/htmx.min.js', 'public/assets/htmx.min.js');
console.log('assets copiados');
```


`src/panel/views/components.ts`:

```ts
import * as lucide from 'lucide-static';
import { html, raw, type SafeHtml } from '../../lib/html.js';

// Componentes base no estilo shadcn/ui. A Task de design (skill impeccable) refina tokens e detalhes visuais;
// os nomes e parâmetros destas funções são o contrato usado pelas páginas.

export type IconName = keyof typeof lucide;

export function icon(name: IconName, className = 'size-4'): SafeHtml {
  const svg = String(lucide[name])
    .replace(/\swidth="24"/, '')
    .replace(/\sheight="24"/, '')
    .replace(/class="([^"]*)"/, `class="$1 ${className} shrink-0" aria-hidden="true"`);
  return raw(svg);
}

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 min-h-11 px-4';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
};

export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${extra}`.trim();
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  info: 'bg-primary/10 text-primary',
};

export function badge(text: string, tone: Tone = 'neutral'): SafeHtml {
  return html`<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}">${text}</span>`;
}

export function card(content: SafeHtml | SafeHtml[], extra = ''): SafeHtml {
  return html`<section class="rounded-xl border border-border bg-card text-card-foreground shadow-sm ${extra}">${content}</section>`;
}

export function alertBox(tone: Exclude<Tone, 'neutral'>, title: string, body?: SafeHtml | string): SafeHtml {
  const icons: Record<typeof tone, IconName> = { success: 'CircleCheck', warning: 'TriangleAlert', danger: 'CircleAlert', info: 'Info' };
  return html`<div role="${tone === 'danger' ? 'alert' : 'status'}" class="flex gap-3 rounded-lg border p-4 text-sm ${BADGE_TONES[tone]} border-current/20">
    ${icon(icons[tone], 'size-5 mt-0.5')}
    <div class="space-y-1"><p class="font-medium">${title}</p>${body ? html`<div class="opacity-90">${body}</div>` : ''}</div>
  </div>`;
}

export function emptyState(iconName: IconName, title: string, text: string, action?: SafeHtml): SafeHtml {
  return html`<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
    <div class="rounded-full bg-secondary p-3 text-muted-foreground">${icon(iconName, 'size-6')}</div>
    <h2 class="text-base font-semibold">${title}</h2>
    <p class="max-w-sm text-sm text-muted-foreground">${text}</p>
    ${action ?? ''}
  </div>`;
}

const INPUT_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm shadow-xs placeholder:text-muted-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive';

export function inputClass(extra = ''): string {
  return `${INPUT_CLASS} min-h-11 ${extra}`.trim();
}

export function textareaClass(extra = ''): string {
  return `${INPUT_CLASS} min-h-24 ${extra}`.trim();
}

export function fieldError(message: string | undefined, id: string): SafeHtml {
  return message ? html`<p id="${id}" class="text-sm text-destructive">${message}</p>` : html``;
}

export function csrfInput(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

export function formatDateTime(epochMs: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(epochMs);
}
```


`src/panel/views/messages.ts`:

```ts
import type { Account } from '../../db/repos/accounts.js';
import type { Tone } from './components.js';

/** Textos em português simples para a usuária (sem jargão técnico). */
export const FAIL_REASON_TEXT: Record<string, string> = {
  token_invalid: 'A conta precisa ser reconectada',
  rate_limited: 'Limite do Instagram atingido — tentando de novo mais tarde',
  messaging_disabled: 'A conta está com "Permitir acesso a mensagens" desativado',
  abuse_blocked: 'O Instagram pediu uma pausa — automações pausadas por 24h',
  comment_unavailable: 'Comentário apagado ou indisponível',
  window_expired: 'Passou do prazo de 7 dias ou a pessoa já recebeu a mensagem',
  permission_denied: 'O Instagram não permitiu esta ação',
  temporary_error: 'Instabilidade no Instagram — não foi possível enviar',
  unknown_error: 'Erro inesperado do Instagram',
};

export const SKIP_REASON_TEXT: Record<string, string> = {
  already_replied_to_person: 'Esta pessoa já recebeu resposta neste post',
};

export function accountStatus(account: Account, now: number): { label: string; tone: Tone; help?: string } {
  if (account.status === 'disconnected') return { label: 'Desconectada', tone: 'neutral' };
  if (account.status === 'reconnect_required') {
    return { label: 'Precisa reconectar', tone: 'danger', help: 'Toque em "Reconectar" e entre de novo com a conta do Instagram.' };
  }
  if (account.status === 'paused_by_safety' && account.pausedUntil && account.pausedUntil > now) {
    const until = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(account.pausedUntil);
    return {
      label: `Pausada por segurança até ${until}`,
      tone: 'warning',
      help: 'O Instagram sinalizou excesso de ações. As respostas voltam sozinhas depois da pausa.',
    };
  }
  if (account.messagingDisabled) {
    return {
      label: 'DMs bloqueadas',
      tone: 'warning',
      help: 'No app do Instagram: Configurações › Mensagens e respostas a stories › Ferramentas conectadas › ative "Permitir acesso a mensagens".',
    };
  }
  return { label: 'Funcionando', tone: 'success' };
}

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  done: { label: 'Enviada', tone: 'success' },
  pending: { label: 'Na fila', tone: 'info' },
  running: { label: 'Enviando', tone: 'info' },
  failed: { label: 'Falhou', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};
```


`src/panel/views/layout.ts`:

```ts
import type { Flash } from '../../http/session.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { alertBox, buttonClass, csrfInput, icon, type IconName } from './components.js';

export type NavKey = 'automacoes' | 'contas' | 'atividade';

export interface LayoutProps {
  title: string;
  body: SafeHtml;
  csrf: string;
  /** Ausente nas telas sem login (ex.: Entrar). */
  nav?: NavKey;
  flash?: Flash | null;
  /** Avisos persistentes (ex.: conta precisa reconectar). */
  alerts?: SafeHtml[];
}

const NAV: Array<{ key: NavKey; href: string; label: string; icon: IconName }> = [
  { key: 'automacoes', href: '/automacoes', label: 'Automações', icon: 'Zap' },
  { key: 'atividade', href: '/atividade', label: 'Atividade', icon: 'Activity' },
  { key: 'contas', href: '/contas', label: 'Contas', icon: 'Users' },
];

export function layout(props: LayoutProps): string {
  const navLink = (item: (typeof NAV)[number], mobile: boolean) => {
    const active = item.key === props.nav;
    return mobile
      ? html`<a href="${item.href}" class="flex flex-1 flex-col items-center gap-1 py-2 text-xs ${active ? 'text-foreground font-medium' : 'text-muted-foreground'}" ${active ? html`aria-current="page"` : ''}>${icon(item.icon, 'size-5')}${item.label}</a>`
      : html`<a href="${item.href}" class="rounded-md px-3 py-2 text-sm ${active ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}" ${active ? html`aria-current="page"` : ''}>${item.label}</a>`;
  };

  const page = html`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="htmx-config" content='{"includeIndicatorStyles": false}'>
  <title>${props.title} · Respostas automáticas</title>
  <link rel="stylesheet" href="/assets/app.css">
  <script src="/assets/htmx.min.js" defer></script>
  <script src="/assets/app.js" defer></script>
</head>
<body class="min-h-dvh bg-background text-foreground antialiased" hx-headers='{"x-csrf-token": "${props.csrf}"}'>
  ${props.nav
    ? html`<header class="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
        <div class="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-4">
          <a href="/automacoes" class="flex items-center gap-2 font-semibold">${icon('MessageCircleReply', 'size-5')}<span>Respostas automáticas</span></a>
          <nav class="hidden gap-1 sm:flex" aria-label="Principal">${NAV.map((item) => navLink(item, false))}</nav>
          <form method="post" action="/sair">${csrfInput(props.csrf)}<button class="${buttonClass('ghost', 'px-3')}" aria-label="Sair">${icon('LogOut')}</button></form>
        </div>
      </header>`
    : ''}
  <main class="mx-auto max-w-3xl space-y-6 px-4 pb-28 pt-6 sm:pb-12">
    ${props.flash ? alertBox(props.flash.kind === 'success' ? 'success' : 'danger', props.flash.message) : ''}
    ${props.alerts ?? []}
    ${props.body}
  </main>
  ${props.nav
    ? html`<nav class="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden" aria-label="Principal">${NAV.map((item) => navLink(item, true))}</nav>`
    : ''}
</body>
</html>`;
  return page.value;
}
```


`src/panel/views/loginPage.ts`:

```ts
import { html, type SafeHtml } from '../../lib/html.js';
import { buttonClass, card, csrfInput, fieldError, icon, inputClass } from './components.js';

export function loginPage(csrf: string, error?: string): SafeHtml {
  return html`<div class="mx-auto mt-10 max-w-sm space-y-6">
    <div class="space-y-2 text-center">
      <div class="mx-auto w-fit rounded-xl bg-primary p-3 text-primary-foreground">${icon('MessageCircleReply', 'size-6')}</div>
      <h1 class="text-2xl font-semibold tracking-tight">Respostas automáticas</h1>
      <p class="text-sm text-muted-foreground">Entre para gerenciar as automações do Instagram.</p>
    </div>
    ${card(html`<form method="post" action="/entrar" class="space-y-4 p-6">
      ${csrfInput(csrf)}
      <div class="space-y-2">
        <label for="email" class="text-sm font-medium">E-mail</label>
        <input id="email" name="email" type="email" autocomplete="username" required class="${inputClass()}">
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
```


`src/panel/views/accountsPage.ts`:

```ts
import type { Account } from '../../db/repos/accounts.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { badge, buttonClass, card, emptyState, formatDateTime, icon } from './components.js';
import { accountStatus } from './messages.js';

export function accountsPage(accounts: Account[], now: number): SafeHtml {
  const connect = html`<a href="/contas/conectar" class="${buttonClass('primary')}">${icon('Plus')}Conectar conta do Instagram</a>`;
  const list = accounts.map((account) => {
    const status = accountStatus(account, now);
    const needsReconnect = account.status === 'reconnect_required' || account.status === 'disconnected';
    return card(html`<div class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
      <div class="flex flex-1 items-center gap-3">
        <div class="grid size-11 place-items-center rounded-full bg-secondary text-sm font-semibold uppercase">${account.username.slice(0, 2)}</div>
        <div class="min-w-0 space-y-1">
          <p class="truncate font-medium">@${account.username}</p>
          ${badge(status.label, status.tone)}
          ${status.help ? html`<p class="text-sm text-muted-foreground">${status.help}</p>` : ''}
          ${account.tokenExpiresAt && account.status !== 'disconnected'
            ? html`<p class="text-xs text-muted-foreground">Acesso renovado automaticamente · válido até ${formatDateTime(account.tokenExpiresAt)}</p>`
            : ''}
        </div>
      </div>
      <div class="flex gap-2">
        ${needsReconnect ? html`<a href="/contas/conectar" class="${buttonClass('primary')}">${icon('RefreshCw')}Reconectar</a>` : ''}
        ${account.status !== 'disconnected'
          ? html`<button hx-post="/contas/${account.id}/desconectar" hx-confirm="Desconectar @${account.username}? As automações desta conta serão pausadas."
              class="${buttonClass('outline')}">${icon('Unlink')}Desconectar</button>`
          : ''}
      </div>
    </div>`);
  });
  return html`<div class="flex flex-wrap items-center justify-between gap-3">
      <div><h1 class="text-2xl font-semibold tracking-tight">Contas</h1><p class="text-sm text-muted-foreground">Contas do Instagram conectadas ao sistema.</p></div>
      ${accounts.length ? connect : ''}
    </div>
    ${accounts.length
      ? html`<div class="space-y-3">${list}</div>`
      : emptyState('Users', 'Nenhuma conta conectada', 'Conecte uma conta profissional do Instagram para começar a responder comentários.', connect)}`;
}
```


`src/panel/context.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import type { SafeHtml } from '../lib/html.js';
import type { ThumbnailService } from '../media/thumbnails.js';
import type { NavKey } from './views/layout.js';

export interface RenderPage {
  title: string;
  body: SafeHtml;
  nav?: NavKey;
  status?: number;
}

/** Dependências compartilhadas pelas rotas do painel. */
export interface PanelContext extends AppDeps {
  thumbnails: ThumbnailService;
  render: (request: FastifyRequest, reply: FastifyReply, page: RenderPage) => FastifyReply;
}
```


`src/panel/loginThrottle.ts`:

```ts
/** Limita tentativas de login com falha por chave (IP): `max` falhas a cada `windowMs`. */
export function createLoginThrottle(options: { max: number; windowMs: number; now: () => number }) {
  const failures = new Map<string, { count: number; resetAt: number }>();

  const current = (key: string) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= options.now()) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    isBlocked(key: string): boolean {
      return (current(key)?.count ?? 0) >= options.max;
    },
    registerFailure(key: string): void {
      const entry = current(key);
      if (entry) entry.count += 1;
      else failures.set(key, { count: 1, resetAt: options.now() + options.windowMs });
    },
    reset(key: string): void {
      failures.delete(key);
    },
  };
}
```


`src/media/thumbnails.ts`:

```ts
import type { FetchFn, InstagramClient, MediaItem } from '../instagram/client.js';

const ALLOWED_HOSTS = [/\.cdninstagram\.com$/, /\.fbcdn\.net$/];
const URL_TTL_MS = 60 * 60_000;

/**
 * Busca a miniatura de um post no servidor e a devolve ao navegador, evitando bloqueios de
 * Cross-Origin-Resource-Policy do CDN e mantendo a CSP do painel em img-src 'self'.
 */
export function createThumbnailService(deps: { client: InstagramClient; fetch?: FetchFn; now: () => number }) {
  const doFetch = deps.fetch ?? fetch;
  const urls = new Map<string, { url: string; at: number }>();

  const imageUrl = (media: MediaItem) => media.thumbnailUrl ?? media.mediaUrl;

  return {
    /** Guarda as URLs já obtidas numa listagem (evita uma chamada à API por miniatura). */
    remember(media: MediaItem[]): void {
      for (const item of media) {
        const url = imageUrl(item);
        if (url) urls.set(item.id, { url, at: deps.now() });
      }
    },

    async fetchImage(token: string, mediaId: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
      let cached = urls.get(mediaId);
      if (!cached || deps.now() - cached.at > URL_TTL_MS) {
        const url = imageUrl(await deps.client.getMedia(token, mediaId));
        if (!url) return null;
        cached = { url, at: deps.now() };
        urls.set(mediaId, cached);
      }
      const host = new URL(cached.url).hostname;
      if (!ALLOWED_HOSTS.some((pattern) => pattern.test(host))) return null;
      const response = await doFetch(cached.url, { signal: AbortSignal.timeout(10_000) });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.startsWith('image/')) {
        urls.delete(mediaId);
        return null;
      }
      return { body: await response.arrayBuffer(), contentType };
    },
  };
}

export type ThumbnailService = ReturnType<typeof createThumbnailService>;
```


`src/accounts/connect.ts`:

```ts
import type { Config } from '../config.js';
import type { DB } from '../db/database.js';
import { upsertConnectedAccount, type Account } from '../db/repos/accounts.js';
import type { InstagramClient } from '../instagram/client.js';
import { REQUIRED_SCOPES, type InstagramOAuth } from '../instagram/oauth.js';
import type { TokenCipher } from '../lib/crypto.js';

export class ConnectError extends Error {}

export interface ConnectDeps {
  config: Config;
  db: DB;
  client: InstagramClient;
  oauth: InstagramOAuth;
  cipher: TokenCipher;
  now: () => number;
}

/** Conclui o Business Login: troca de tokens, checagens (allowlist, tipo, permissões) e assinatura do webhook (spec §6.5). */
export async function completeConnection(deps: ConnectDeps, code: string): Promise<Account> {
  const short = await deps.oauth.exchangeCode(code);
  const missing = REQUIRED_SCOPES.filter((scope) => !short.permissions.includes(scope));
  if (missing.length) {
    throw new ConnectError('Faltou autorizar todas as permissões. Clique em reconectar e deixe todas as opções marcadas.');
  }
  const long = await deps.oauth.exchangeForLongLived(short.accessToken);
  const profile = await deps.client.getProfile(long.accessToken);

  const allowed = deps.config.REVIEW_MODE || deps.config.IG_ALLOWED_USERNAMES.includes(profile.username.toLowerCase());
  if (!allowed) throw new ConnectError(`A conta @${profile.username} não está autorizada a usar este sistema.`);
  if (profile.accountType && !['business', 'media_creator'].includes(profile.accountType.toLowerCase())) {
    throw new ConnectError('Apenas contas profissionais (Comercial ou Criador de conteúdo) podem ser conectadas.');
  }

  await deps.client.subscribeToComments(long.accessToken);
  const now = deps.now();
  return upsertConnectedAccount(
    deps.db,
    {
      igId: profile.igId,
      appUserId: profile.appUserId,
      username: profile.username,
      profilePictureUrl: profile.profilePictureUrl,
      tokenEnc: deps.cipher.encrypt(long.accessToken),
      tokenExpiresAt: now + long.expiresInSec * 1000,
    },
    now,
  );
}
```


`src/panel/routes/auth.ts`:

```ts
import { verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { findUserByEmail } from '../../db/repos/users.js';
import { ensureCsrfToken } from '../../http/session.js';
import { createLoginThrottle } from '../loginThrottle.js';
import type { PanelContext } from '../context.js';
import { loginPage } from '../views/loginPage.js';

export async function registerAuthRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  const throttle = createLoginThrottle({ max: 5, windowMs: 15 * 60_000, now: ctx.now });

  app.get('/entrar', async (request, reply) => {
    if (request.session.get('userId')) return reply.redirect('/automacoes');
    return ctx.render(request, reply, { title: 'Entrar', body: loginPage(ensureCsrfToken(request)) });
  });

  app.post('/entrar', async (request, reply) => {
    const { email = '', password = '' } = request.body as { email?: string; password?: string };
    const key = request.ip;
    if (throttle.isBlocked(key)) {
      return ctx.render(request, reply, {
        title: 'Entrar',
        status: 429,
        body: loginPage(ensureCsrfToken(request), 'Muitas tentativas. Aguarde 15 minutos e tente de novo.'),
      });
    }
    const user = findUserByEmail(ctx.db, email.trim());
    const ok = user ? await verify(user.passwordHash, password) : false;
    if (!user || !ok) {
      throttle.registerFailure(key);
      return ctx.render(request, reply, {
        title: 'Entrar',
        status: 401,
        body: loginPage(ensureCsrfToken(request), 'E-mail ou senha incorretos.'),
      });
    }
    throttle.reset(key);
    request.session.regenerate();
    request.session.set('userId', user.id);
    return reply.redirect('/automacoes');
  });

  app.post('/sair', async (request, reply) => {
    request.session.delete();
    return reply.redirect('/entrar');
  });
}
```


`src/panel/routes/accounts.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { ConnectError, completeConnection } from '../../accounts/connect.js';
import { disconnectAccount, getAccountById, listAccounts } from '../../db/repos/accounts.js';
import { redirectAfterAction } from '../../http/redirect.js';
import { setFlash } from '../../http/session.js';
import { randomToken } from '../../lib/crypto.js';
import type { PanelContext } from '../context.js';
import { accountsPage } from '../views/accountsPage.js';

export const OAUTH_CALLBACK_PATH = '/auth/instagram/callback';

// Mostrado quando a miniatura não pode ser carregada (sem <img onerror>, que a CSP bloqueia).
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#e4e4e7"/>' +
  '<path d="M30 62l12-14 9 10 7-8 8 12z" fill="#a1a1aa"/><circle cx="38" cy="36" r="5" fill="#a1a1aa"/></svg>';

export async function registerAccountRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  app.get('/contas', async (request, reply) =>
    ctx.render(request, reply, { title: 'Contas', nav: 'contas', body: accountsPage(listAccounts(ctx.db), ctx.now()) }),
  );

  app.get('/contas/conectar', async (request, reply) => {
    const state = randomToken();
    request.session.set('oauthState', state);
    return reply.redirect(ctx.oauth.authorizeUrl(state));
  });

  app.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const expected = request.session.get('oauthState');
    request.session.set('oauthState', undefined);
    if (query.error) {
      setFlash(request, { kind: 'error', message: 'Conexão cancelada no Instagram. Nenhuma alteração foi feita.' });
      return reply.redirect('/contas');
    }
    if (!query.code || !query.state || query.state !== expected) {
      setFlash(request, { kind: 'error', message: 'Link de conexão expirado. Tente conectar de novo.' });
      return reply.redirect('/contas');
    }
    try {
      const account = await completeConnection(ctx, query.code);
      setFlash(request, { kind: 'success', message: `Conta @${account.username} conectada!` });
    } catch (error) {
      request.log.warn({ err: error }, 'falha ao conectar conta');
      const message = error instanceof ConnectError ? error.message : 'Não foi possível conectar a conta agora. Tente de novo em alguns minutos.';
      setFlash(request, { kind: 'error', message });
    }
    return reply.redirect('/contas');
  });

  app.post('/contas/:id/desconectar', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const account = getAccountById(ctx.db, id);
    if (account) {
      disconnectAccount(ctx.db, id, ctx.now());
      setFlash(request, { kind: 'success', message: `Conta @${account.username} desconectada. As automações dela foram pausadas.` });
    }
    return redirectAfterAction(request, reply, '/contas');
  });

  app.get('/midia/:accountId/:mediaId', async (request, reply) => {
    const { accountId, mediaId } = request.params as { accountId: string; mediaId: string };
    const placeholder = () => reply.type('image/svg+xml').header('Cache-Control', 'private, max-age=300').send(PLACEHOLDER_SVG);
    const account = getAccountById(ctx.db, Number(accountId));
    if (!account?.tokenEnc || !/^\d+$/.test(mediaId)) return placeholder();
    try {
      const image = await ctx.thumbnails.fetchImage(ctx.cipher.decrypt(account.tokenEnc), mediaId);
      if (!image) return placeholder();
      return reply.type(image.contentType).header('Cache-Control', 'private, max-age=3600').send(Buffer.from(image.body));
    } catch (error) {
      request.log.warn({ err: error, mediaId }, 'falha ao carregar miniatura');
      return placeholder();
    }
  });
}
```


`src/panel/register.ts` (versão desta task: login + contas; as Tasks 12 e 13 acrescentam rotas):

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { listAccounts } from '../db/repos/accounts.js';
import { findUserById } from '../db/repos/users.js';
import { ensureCsrfToken, takeFlash, verifyCsrf } from '../http/session.js';
import { createThumbnailService } from '../media/thumbnails.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAuthRoutes } from './routes/auth.js';
import type { PanelContext } from './context.js';
import { alertBox } from './views/components.js';
import { layout } from './views/layout.js';
import { accountStatus } from './views/messages.js';

async function requireUser(request: FastifyRequest, reply: FastifyReply, deps: AppDeps): Promise<void> {
  const userId = request.session.get('userId');
  if (userId && findUserById(deps.db, userId)) return;
  if (request.headers['hx-request']) {
    await reply.header('HX-Redirect', '/entrar').code(401).send();
    return;
  }
  await reply.redirect('/entrar');
}

/** Painel: telas com login, CSRF em todo POST e layout comum (spec §8). */
export async function registerPanel(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const ctx: PanelContext = {
    ...deps,
    thumbnails: createThumbnailService({ client: deps.client, fetch: deps.fetchImage, now: deps.now }),
    render(request, reply, page) {
      const accounts = page.nav ? listAccounts(deps.db) : [];
      const now = deps.now();
      const alerts = accounts
        .filter((account) => account.status !== 'disconnected')
        .map((account) => ({ account, status: accountStatus(account, now) }))
        .filter(({ status }) => status.tone === 'danger' || status.tone === 'warning')
        .map(({ account, status }) => alertBox(status.tone === 'danger' ? 'danger' : 'warning', `@${account.username}: ${status.label}`, status.help));
      return reply
        .code(page.status ?? 200)
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(layout({ ...page, csrf: ensureCsrfToken(request), flash: takeFlash(request), alerts }));
    },
  };

  app.addHook('preHandler', verifyCsrf);

  await app.register(async (open) => {
    await registerAuthRoutes(open, ctx);
  });

  await app.register(async (protectedScope) => {
    protectedScope.addHook('preHandler', (request, reply) => requireUser(request, reply, deps));
    protectedScope.get('/', async (_request, reply) => reply.redirect('/automacoes'));
    await registerAccountRoutes(protectedScope, ctx);
  });
}
```


- [ ] **Step 3b: Registrar o painel em `src/app.ts`**

Adicione o import (junto aos outros imports locais):

```ts
import { registerPanel } from './panel/register.js';
```

E, no fim de `buildApp`, logo após `await app.register(registerPublicRoutes, deps);`:

```ts
  await app.register(registerPanel, deps);
```

- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  97 passed (97)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/loginThrottle.test.ts test/http-auth.test.ts test/http-accounts.test.ts src/panel/styles.css public/assets/app.js scripts/copy-assets.mjs src/panel/views/components.ts src/panel/views/messages.ts src/panel/views/layout.ts src/panel/views/loginPage.ts src/panel/views/accountsPage.ts src/panel/context.ts src/panel/loginThrottle.ts src/media/thumbnails.ts src/accounts/connect.ts src/panel/routes/auth.ts src/panel/routes/accounts.ts src/panel/register.ts src/app.ts
git commit -m "feat(painel): login, layout base e conexão de contas"
```

---

### Task 12: Painel: automações (lista, criar, editar, pausar, excluir)

**Objetivo:** Fluxo principal da usuária: escolher conta e post (grade com miniaturas), palavras-chave, 3+ variações e DM, com validação clara em português.

**Files:**
- Test: `test/http-automations.test.ts`
- Create: `src/panel/views/automationPages.ts`
- Create: `src/panel/automationForm.ts`
- Create: `src/panel/routes/automations.ts`
- Modify: `src/panel/register.ts`

**Interfaces:**
- Consumes: `PanelContext` (Task 11), repositórios de automações (Task 5), `parseKeywords`/`utf8ByteLength` (Task 3).
- Produces: `readAutomationForm(body)`, `validateAutomationForm(values)` → `{ ok: true, data } | { ok: false, errors }`, `LIMITS`; views `automationsPage`, `automationCard`, `automationFormPage`, `mediaPicker`, `type AutomationFormValues`, `type FormErrors`.
- Rotas: `GET /automacoes`, `GET /automacoes/nova`, `GET /automacoes/posts` (parcial htmx), `POST /automacoes`, `GET /automacoes/:id/editar`, `POST /automacoes/:id`, `POST /automacoes/:id/ativar|pausar` (devolve o card), `POST /automacoes/:id/excluir`.

- [ ] **Step 1: Escrever os testes (falhando)**

`test/http-automations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { listActiveAutomations } from '../src/db/repos/automations.js';
import { validateAutomationForm } from '../src/panel/automationForm.js';
import { buildTestApp, form, login } from './helpers/app.js';
import { seedAccount, seedAutomation } from './helpers/db.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const validBody = (accountId: number, csrf: string) => ({
  _csrf: csrf,
  accountId: String(accountId),
  mediaId: '1790001',
  keywords: 'EU QUERO, link',
  variations: ['Oi {usuario}, te mandei no direct!', 'Enviado {usuario} 💌', 'Olha o direct {usuario}'],
  dmText: 'Aqui está: https://exemplo.com (mensagem automática)',
});

describe('validateAutomationForm', () => {
  it('exige palavra-chave, 3 variações distintas e DM ≤ 1000 bytes', () => {
    const result = validateAutomationForm({ accountId: 1, mediaId: '1', keywords: ' , ', variations: ['a', 'A', ''], dmText: 'ã'.repeat(501) });
    expect(result).toEqual({
      ok: false,
      errors: {
        keywords: 'Informe pelo menos uma palavra-chave.',
        variations: 'Escreva pelo menos 3 versões diferentes da resposta.',
        dmText: 'A mensagem do Direct está longa demais. Encurte um pouco.',
      },
    });
    const ok = validateAutomationForm({ accountId: 1, mediaId: '1', keywords: 'a, b', variations: ['x', 'y', 'z'], dmText: 'oi' });
    expect(ok).toMatchObject({ ok: true, data: { keywords: ['a', 'b'], publicVariations: ['x', 'y', 'z'] } });
  });
});

describe('automações (rotas)', () => {
  it('cria automação com dados do post confirmados na API', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db, { tokenEnc: t.cipher.encrypt('TOKEN') });
    const session = await login(t.app, t.db);
    t.client.getMedia.mockResolvedValue({ id: '1790001', mediaType: 'IMAGE', permalink: 'https://instagram.com/p/x', caption: 'Promo', timestamp: 't' });
    const res = await t.app.inject({ method: 'POST', url: '/automacoes', headers: { cookie: session.cookie, ...FORM }, payload: form(validBody(account.id, session.csrf)) });
    expect(res.statusCode).toBe(302);
    expect(t.client.getMedia).toHaveBeenCalledWith('TOKEN', '1790001');
    expect(listActiveAutomations(t.db)[0]).toMatchObject({ mediaId: '1790001', keywords: ['EU QUERO', 'link'], mediaCaption: 'Promo' });
  });

  it('mostra erros de validação (422) mantendo o que foi digitado', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db);
    const session = await login(t.app, t.db);
    const body = { ...validBody(account.id, session.csrf), variations: ['só uma'] };
    const res = await t.app.inject({ method: 'POST', url: '/automacoes', headers: { cookie: session.cookie, ...FORM }, payload: form(body) });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Escreva pelo menos 3 versões diferentes da resposta.');
    expect(res.body).toContain('só uma');
    // ganchos do /assets/app.js: contador de bytes, inserir {usuario} e prévia
    expect(res.body).toContain('data-max-bytes="1000"');
    expect(res.body).toContain('data-insert-token="{usuario}"');
    expect(res.body).toContain('data-reply-preview');
  });

  it('impede segunda automação no mesmo post', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db, { tokenEnc: t.cipher.encrypt('TOKEN') });
    seedAutomation(t.db, account.id, { mediaId: '1790001' });
    const session = await login(t.app, t.db);
    t.client.getMedia.mockResolvedValue({ id: '1790001', mediaType: 'IMAGE', permalink: 'p', timestamp: 't' });
    const res = await t.app.inject({ method: 'POST', url: '/automacoes', headers: { cookie: session.cookie, ...FORM }, payload: form(validBody(account.id, session.csrf)) });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Este post já tem uma automação.');
  });

  it('pausar via htmx devolve o card atualizado', async () => {
    const t = await buildTestApp();
    const automation = seedAutomation(t.db, seedAccount(t.db).id);
    const session = await login(t.app, t.db);
    const res = await t.app.inject({
      method: 'POST', url: `/automacoes/${automation.id}/pausar`,
      headers: { cookie: session.cookie, 'hx-request': 'true', 'x-csrf-token': session.csrf, ...FORM }, payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('aria-checked="false"');
    expect(listActiveAutomations(t.db)).toHaveLength(0);
  });

  it('lista posts da conta marcando os que já têm automação', async () => {
    const t = await buildTestApp();
    const account = seedAccount(t.db, { tokenEnc: t.cipher.encrypt('TOKEN') });
    seedAutomation(t.db, account.id, { mediaId: '1' });
    const session = await login(t.app, t.db);
    t.client.listMedia.mockResolvedValue([
      { id: '1', mediaType: 'IMAGE', permalink: 'p1', timestamp: 't' },
      { id: '2', mediaType: 'VIDEO', permalink: 'p2', timestamp: 't', thumbnailUrl: 'https://scontent.cdninstagram.com/t.jpg' },
    ]);
    const res = await t.app.inject({ url: `/automacoes/posts?accountId=${account.id}`, headers: { cookie: session.cookie, 'hx-request': 'true' } });
    expect(res.body).toContain('value="2"');
    expect(res.body).toContain('Já tem automação');
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/http-automations.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/panel/views/automationPages.ts`:

```ts
import type { Account } from '../../db/repos/accounts.js';
import type { AutomationSummary } from '../../db/repos/automations.js';
import type { MediaItem } from '../../instagram/client.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { badge, buttonClass, card, csrfInput, emptyState, fieldError, icon, inputClass, textareaClass } from './components.js';

export function automationsPage(items: AutomationSummary[], hasAccounts: boolean): SafeHtml {
  const create = html`<a href="/automacoes/nova" class="${buttonClass('primary')}">${icon('Plus')}Nova automação</a>`;
  if (!items.length) {
    return html`<h1 class="text-2xl font-semibold tracking-tight">Automações</h1>
      ${hasAccounts
        ? emptyState('Zap', 'Nenhuma automação ainda', 'Escolha um post, as palavras-chave e as respostas. O resto é automático.', create)
        : emptyState('Users', 'Conecte uma conta primeiro', 'Para criar automações, conecte uma conta do Instagram.', html`<a href="/contas" class="${buttonClass('primary')}">Ir para Contas</a>`)}`;
  }
  return html`<div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Automações</h1>${create}
    </div>
    <div class="space-y-3">${items.map((item) => automationCard(item))}</div>`;
}

export function automationCard(item: AutomationSummary): SafeHtml {
  return html`<div id="automacao-${item.id}">${card(html`<div class="flex gap-4 p-4">
    <img src="/midia/${item.accountId}/${item.mediaId}" alt="" loading="lazy" class="size-20 shrink-0 rounded-lg bg-secondary object-cover">
    <div class="min-w-0 flex-1 space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="truncate text-sm text-muted-foreground">@${item.accountUsername}</p>
          <p class="line-clamp-2 text-sm">${item.mediaCaption || 'Post sem legenda'}</p>
        </div>
        <button hx-post="/automacoes/${item.id}/${item.isActive ? 'pausar' : 'ativar'}" hx-target="#automacao-${item.id}" hx-swap="outerHTML"
          role="switch" aria-checked="${item.isActive ? 'true' : 'false'}" aria-label="${item.isActive ? 'Pausar automação' : 'Ativar automação'}"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${item.isActive ? 'bg-primary' : 'bg-input'}">
          <span class="inline-block size-5 rounded-full bg-background shadow transition-transform ${item.isActive ? 'translate-x-5' : 'translate-x-0.5'}"></span>
        </button>
      </div>
      <div class="flex flex-wrap gap-1">${item.keywords.map((keyword) => badge(keyword, 'info'))}</div>
      <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>${item.repliesToday} hoje · ${item.repliesTotal} no total</span>
        <a href="/automacoes/${item.id}/editar" class="${buttonClass('ghost', 'min-h-9 px-2')}">Editar${icon('ChevronRight')}</a>
      </div>
    </div>
  </div>`)}</div>`;
}

export interface AutomationFormValues {
  accountId?: number;
  mediaId?: string;
  mediaPermalink?: string;
  mediaCaption?: string;
  mediaType?: string;
  keywords: string;
  variations: string[];
  dmText: string;
}

export type FormErrors = Partial<Record<'account' | 'media' | 'keywords' | 'variations' | 'dmText' | 'general', string>>;

export function automationFormPage(input: {
  csrf: string;
  accounts: Account[];
  values: AutomationFormValues;
  errors: FormErrors;
  editingId?: number;
}): SafeHtml {
  const { values, errors, editingId } = input;
  const variations = values.variations.length >= 3 ? values.variations : [...values.variations, '', '', ''].slice(0, 3);
  const action = editingId ? `/automacoes/${editingId}` : '/automacoes';
  return html`<div class="space-y-1">
      <a href="/automacoes" class="text-sm text-muted-foreground hover:text-foreground">← Automações</a>
      <h1 class="text-2xl font-semibold tracking-tight">${editingId ? 'Editar automação' : 'Nova automação'}</h1>
    </div>
    ${errors.general ? html`<p class="text-sm text-destructive">${errors.general}</p>` : ''}
    <form method="post" action="${action}" class="space-y-6">
      ${csrfInput(input.csrf)}
      ${editingId
        ? html`<input type="hidden" name="accountId" value="${values.accountId}"><input type="hidden" name="mediaId" value="${values.mediaId}">`
        : card(html`<div class="space-y-4 p-4">
            <h2 class="font-medium">1. Conta e post</h2>
            <div class="space-y-2">
              <label for="accountId" class="text-sm font-medium">Conta</label>
              <select id="accountId" name="accountId" class="${inputClass()}" hx-get="/automacoes/posts" hx-target="#post-picker" hx-trigger="change, load"
                hx-vals='{"selected": "${values.mediaId ?? ''}"}'>
                ${input.accounts.map((a) => html`<option value="${a.id}" ${a.id === values.accountId ? 'selected' : ''}>@${a.username}</option>`)}
              </select>
              ${fieldError(errors.account, 'account-error')}
            </div>
            <fieldset class="space-y-2">
              <legend class="text-sm font-medium">Post</legend>
              <div id="post-picker" class="min-h-24 text-sm text-muted-foreground">Carregando posts…</div>
              ${fieldError(errors.media, 'media-error')}
            </fieldset>
          </div>`)}
      ${card(html`<div class="space-y-2 p-4">
        <h2 class="font-medium">${editingId ? '1' : '2'}. Palavras-chave</h2>
        <p class="text-sm text-muted-foreground">Separe por vírgula. Não importa maiúscula ou acento. Ex.: EU QUERO, link</p>
        <input name="keywords" value="${values.keywords}" class="${inputClass()}" ${errors.keywords ? html`aria-invalid="true"` : ''} required>
        ${fieldError(errors.keywords, 'keywords-error')}
      </div>`)}
      ${card(html`<div class="space-y-3 p-4">
        <h2 class="font-medium">${editingId ? '2' : '3'}. Resposta no comentário</h2>
        <p class="text-sm text-muted-foreground">Escreva pelo menos 3 versões — o sistema sorteia uma a cada resposta. Use {usuario} para mencionar a pessoa.</p>
        <div id="variations" class="space-y-2">
          ${variations.map((value, index) => html`<textarea name="variations" rows="2" maxlength="300" class="${textareaClass('min-h-16')}" aria-label="Versão ${index + 1}" placeholder="Ex.: Oi {usuario}, te mandei no direct! 💌">${value}</textarea>`)}
        </div>
        <button type="button" data-insert-token="{usuario}" class="${buttonClass('outline', 'min-h-9 px-3 text-xs')}">${icon('AtSign')}Inserir {usuario}</button>
        ${fieldError(errors.variations, 'variations-error')}
        <div class="rounded-md bg-secondary px-3 py-2 text-sm">
          <p class="text-xs text-muted-foreground">Prévia</p>
          <p data-reply-preview aria-live="polite"></p>
        </div>
      </div>`)}
      ${card(html`<div class="space-y-2 p-4">
        <h2 class="font-medium">${editingId ? '3' : '4'}. Mensagem no Direct</h2>
        <p class="text-sm text-muted-foreground">Enviada uma vez para quem comentou. Pode incluir link. Termine com "(mensagem automática)" — é o recomendado pela Meta. Limite: 1000 caracteres simples (emojis e acentos contam mais).</p>
        <textarea id="dmText" name="dmText" rows="5" data-max-bytes="1000" class="${textareaClass()}" placeholder="Ex.: Oi! Aqui está o link: https://… (mensagem automática)" required ${errors.dmText ? html`aria-invalid="true"` : ''}>${values.dmText}</textarea>
        <p class="text-right text-xs text-muted-foreground" data-counter-for="dmText" aria-live="polite"></p>
        ${fieldError(errors.dmText, 'dm-error')}
      </div>`)}
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <a href="/automacoes" class="${buttonClass('outline')}">Cancelar</a>
        <button class="${buttonClass('primary')}">${editingId ? 'Salvar alterações' : 'Criar automação'}</button>
      </div>
    </form>
    ${editingId
      ? html`<div class="flex justify-end">
          <button hx-post="/automacoes/${editingId}/excluir" hx-confirm="Excluir esta automação? Esta ação não pode ser desfeita."
            class="${buttonClass('ghost', 'text-destructive')}">${icon('Trash2')}Excluir automação</button>
        </div>`
      : ''}`;
}

export function mediaPicker(accountId: number, media: MediaItem[], takenMediaIds: Set<string>, selected?: string): SafeHtml {
  if (!media.length) return html`<p class="text-sm text-muted-foreground">Nenhum post encontrado nesta conta.</p>`;
  return html`<div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
    ${media.map((item) => {
      const taken = takenMediaIds.has(item.id);
      return html`<label class="group relative block aspect-square overflow-hidden rounded-lg border-2 border-transparent has-[:checked]:border-primary ${taken ? 'opacity-40' : 'cursor-pointer'}">
        <input type="radio" name="mediaId" value="${item.id}" class="peer sr-only" ${taken ? 'disabled' : ''} ${item.id === selected ? 'checked' : ''} required>
        <img src="/midia/${accountId}/${item.id}" alt="${item.caption?.slice(0, 80) ?? 'Post'}" loading="lazy" class="size-full bg-secondary object-cover">
        <span class="absolute right-1 top-1 hidden rounded-full bg-primary p-0.5 text-primary-foreground peer-checked:block">${icon('Check', 'size-3')}</span>
        ${taken ? html`<span class="absolute inset-x-1 bottom-1 rounded bg-background/90 px-1 text-[10px]">Já tem automação</span>` : ''}
      </label>`;
    })}
  </div>`;
}
```


`src/panel/automationForm.ts`:

```ts
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

/** Lê o corpo do formulário (como enviado pelo navegador) em valores para re-exibir. */
export function readAutomationForm(body: Record<string, unknown>): AutomationFormValues {
  const accountId = Number(body.accountId);
  return {
    accountId: Number.isInteger(accountId) && accountId > 0 ? accountId : undefined,
    mediaId: typeof body.mediaId === 'string' && /^\d+$/.test(body.mediaId) ? body.mediaId : undefined,
    keywords: typeof body.keywords === 'string' ? body.keywords : '',
    variations: asArray(body.variations),
    dmText: typeof body.dmText === 'string' ? body.dmText.trim() : '',
  };
}

/** Regras da spec §8.2: ≥ 1 palavra-chave, ≥ 3 variações, DM ≤ 1000 bytes. */
export function validateAutomationForm(
  values: AutomationFormValues,
): { ok: true; data: ValidAutomationInput } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const keywords = parseKeywords(values.keywords);
  const variations = values.variations.map((v) => v.trim()).filter(Boolean);

  if (!values.accountId) errors.account = 'Escolha a conta.';
  if (!values.mediaId) errors.media = 'Escolha o post.';
  if (keywords.length === 0) errors.keywords = 'Informe pelo menos uma palavra-chave.';
  else if (keywords.length > LIMITS.maxKeywords) errors.keywords = `Use no máximo ${LIMITS.maxKeywords} palavras-chave.`;
  else if (keywords.some((k) => k.length > LIMITS.maxKeywordLength)) errors.keywords = 'Cada palavra-chave pode ter até 50 caracteres.';

  if (variations.length < LIMITS.minVariations) errors.variations = 'Escreva pelo menos 3 versões diferentes da resposta.';
  else if (variations.length > LIMITS.maxVariations) errors.variations = `Use no máximo ${LIMITS.maxVariations} versões.`;
  else if (new Set(variations.map((v) => v.toLowerCase())).size !== variations.length) errors.variations = 'As versões precisam ser diferentes entre si.';
  else if (variations.some((v) => v.length > LIMITS.maxVariationLength)) errors.variations = 'Cada versão pode ter até 300 caracteres.';

  if (!values.dmText) errors.dmText = 'Escreva a mensagem do Direct.';
  else if (utf8ByteLength(values.dmText) > LIMITS.maxDmBytes) errors.dmText = 'A mensagem do Direct está longa demais. Encurte um pouco.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: { accountId: values.accountId!, mediaId: values.mediaId!, keywords, publicVariations: variations, dmText: values.dmText },
  };
}
```


`src/panel/routes/automations.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { getAccountById, listAccounts } from '../../db/repos/accounts.js';
import {
  createAutomation,
  deleteAutomation,
  DuplicateAutomationError,
  getAutomation,
  listAutomationSummaries,
  setAutomationActive,
  updateAutomationContent,
} from '../../db/repos/automations.js';
import { redirectAfterAction } from '../../http/redirect.js';
import { setFlash } from '../../http/session.js';
import { html } from '../../lib/html.js';
import { readAutomationForm, validateAutomationForm } from '../automationForm.js';
import type { PanelContext } from '../context.js';
import { automationCard, automationFormPage, automationsPage, mediaPicker, type AutomationFormValues } from '../views/automationPages.js';

function startOfTodayInSaoPaulo(now: number): number {
  const offset = 3 * 60 * 60_000; // America/Sao_Paulo é UTC-3 (sem horário de verão desde 2019)
  return Math.floor((now - offset) / 86_400_000) * 86_400_000 + offset;
}

export async function registerAutomationRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  const connectedAccounts = () => listAccounts(ctx.db).filter((a) => a.status !== 'disconnected');
  const summary = (id: number) => listAutomationSummaries(ctx.db, startOfTodayInSaoPaulo(ctx.now())).find((a) => a.id === id);

  app.get('/automacoes', async (request, reply) =>
    ctx.render(request, reply, {
      title: 'Automações',
      nav: 'automacoes',
      body: automationsPage(listAutomationSummaries(ctx.db, startOfTodayInSaoPaulo(ctx.now())), connectedAccounts().length > 0),
    }),
  );

  const renderForm = (
    request: Parameters<PanelContext['render']>[0],
    reply: Parameters<PanelContext['render']>[1],
    values: AutomationFormValues,
    errors = {},
    editingId?: number,
  ) =>
    ctx.render(request, reply, {
      title: editingId ? 'Editar automação' : 'Nova automação',
      nav: 'automacoes',
      status: Object.keys(errors).length ? 422 : 200,
      body: automationFormPage({ csrf: request.session.get('csrf') ?? '', accounts: connectedAccounts(), values, errors, editingId }),
    });

  app.get('/automacoes/nova', async (request, reply) => {
    if (connectedAccounts().length === 0) return reply.redirect('/contas');
    return renderForm(request, reply, { keywords: '', variations: [], dmText: '' });
  });

  /** Parcial htmx: grade com os posts recentes da conta escolhida. */
  app.get('/automacoes/posts', async (request, reply) => {
    const { accountId, selected } = request.query as { accountId?: string; selected?: string };
    const account = getAccountById(ctx.db, Number(accountId));
    if (!account?.tokenEnc) return reply.type('text/html').send(html`<p class="text-sm text-destructive">Conta indisponível. Reconecte em Contas.</p>`.value);
    try {
      const media = await ctx.client.listMedia(ctx.cipher.decrypt(account.tokenEnc), 24);
      ctx.thumbnails.remember(media);
      const taken = new Set(listAutomationSummaries(ctx.db, 0).filter((a) => a.accountId === account.id).map((a) => a.mediaId));
      return reply.type('text/html').send(mediaPicker(account.id, media, taken, selected).value);
    } catch (error) {
      request.log.warn({ err: error }, 'falha ao listar posts');
      return reply.type('text/html').send(html`<p class="text-sm text-destructive">Não foi possível carregar os posts agora. Tente de novo.</p>`.value);
    }
  });

  app.post('/automacoes', async (request, reply) => {
    const values = readAutomationForm(request.body as Record<string, unknown>);
    const result = validateAutomationForm(values);
    if (!result.ok) return renderForm(request, reply, values, result.errors);
    const account = getAccountById(ctx.db, result.data.accountId);
    if (!account?.tokenEnc) return renderForm(request, reply, values, { account: 'Conta indisponível. Reconecte em Contas.' });
    try {
      const media = await ctx.client.getMedia(ctx.cipher.decrypt(account.tokenEnc), result.data.mediaId);
      createAutomation(
        ctx.db,
        { ...result.data, mediaType: media.mediaType, mediaPermalink: media.permalink, mediaCaption: media.caption?.slice(0, 300) },
        ctx.now(),
      );
    } catch (error) {
      if (error instanceof DuplicateAutomationError) return renderForm(request, reply, values, { media: 'Este post já tem uma automação.' });
      request.log.warn({ err: error }, 'falha ao criar automação');
      return renderForm(request, reply, values, { general: 'Não foi possível confirmar o post no Instagram. Tente de novo.' });
    }
    setFlash(request, { kind: 'success', message: 'Automação criada e ativa!' });
    return reply.redirect('/automacoes');
  });

  app.get('/automacoes/:id/editar', async (request, reply) => {
    const automation = getAutomation(ctx.db, Number((request.params as { id: string }).id));
    if (!automation) return reply.redirect('/automacoes');
    return renderForm(
      request,
      reply,
      {
        accountId: automation.accountId,
        mediaId: automation.mediaId,
        keywords: automation.keywords.join(', '),
        variations: automation.publicVariations,
        dmText: automation.dmText,
      },
      {},
      automation.id,
    );
  });

  app.post('/automacoes/:id', async (request, reply) => {
    const automation = getAutomation(ctx.db, Number((request.params as { id: string }).id));
    if (!automation) return reply.redirect('/automacoes');
    const values = { ...readAutomationForm(request.body as Record<string, unknown>), accountId: automation.accountId, mediaId: automation.mediaId };
    const result = validateAutomationForm(values);
    if (!result.ok) return renderForm(request, reply, values, result.errors, automation.id);
    updateAutomationContent(ctx.db, automation.id, result.data, ctx.now());
    setFlash(request, { kind: 'success', message: 'Automação atualizada.' });
    return reply.redirect('/automacoes');
  });

  for (const [action, active] of [['ativar', true], ['pausar', false]] as const) {
    app.post(`/automacoes/:id/${action}`, async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!getAutomation(ctx.db, id)) return reply.code(404).send();
      setAutomationActive(ctx.db, id, active, ctx.now());
      const item = summary(id)!;
      if (request.headers['hx-request']) return reply.type('text/html').send(automationCard(item).value);
      return reply.redirect('/automacoes');
    });
  }

  app.post('/automacoes/:id/excluir', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (getAutomation(ctx.db, id)) {
      deleteAutomation(ctx.db, id);
      setFlash(request, { kind: 'success', message: 'Automação excluída.' });
    }
    return redirectAfterAction(request, reply, '/automacoes');
  });
}
```


- [ ] **Step 3b: Registrar as rotas em `src/panel/register.ts`**

Adicione o import:

```ts
import { registerAutomationRoutes } from './routes/automations.js';
```

E dentro do escopo protegido, logo após `await registerAccountRoutes(protectedScope, ctx);`:

```ts
    await registerAutomationRoutes(protectedScope, ctx);
```

- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  103 passed (103)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/http-automations.test.ts src/panel/views/automationPages.ts src/panel/automationForm.ts src/panel/routes/automations.ts src/panel/register.ts
git commit -m "feat(painel): criação e gestão de automações"
```

---

### Task 13: Painel: Atividade (histórico com motivos em português)

**Objetivo:** Mostrar o que aconteceu com cada comentário (resposta pública e DM), com filtros por conta/situação e paginação.

**Files:**
- Test: `test/http-activity.test.ts`
- Create: `src/panel/views/activityPage.ts`
- Create: `src/panel/routes/activity.ts`
- Modify: `src/panel/register.ts`

**Interfaces:**
- Consumes: `listActivity` (Task 5), `PanelContext` (Task 11), textos de `messages.ts` (Task 11).
- Produces: `activityPage({ rows, accounts, filter, hasNext })`; rota `GET /atividade?conta=&status=&pagina=` (20 por página).

- [ ] **Step 1: Escrever os testes (falhando)**

`test/http-activity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { insertInteraction } from '../src/db/repos/interactions.js';
import { buildTestApp, login } from './helpers/app.js';
import { seedAccount, seedAutomation, T0 } from './helpers/db.js';

describe('atividade (rota)', () => {
  it('mostra os motivos em português', async () => {
    const t = await buildTestApp();
    const automation = seedAutomation(t.db, seedAccount(t.db).id);
    insertInteraction(t.db, {
      automationId: automation.id, commentId: 'C1', commenterIgsid: 'U1', commenterUsername: 'ana', commentText: 'eu quero de novo',
      matchedKeyword: 'eu quero', source: 'webhook', status: 'skipped', skipReason: 'already_replied_to_person',
    }, T0);
    const session = await login(t.app, t.db);
    const res = await t.app.inject({ url: '/atividade', headers: { cookie: session.cookie } });
    expect(res.body).toContain('@ana');
    expect(res.body).toContain('Esta pessoa já recebeu resposta neste post');
  });

  it('filtra por situação e pagina', async () => {
    const t = await buildTestApp();
    const automation = seedAutomation(t.db, seedAccount(t.db).id);
    for (let i = 0; i < 25; i += 1) {
      insertInteraction(t.db, {
        automationId: automation.id, commentId: `C${i}`, commenterIgsid: `U${i}`, commenterUsername: `pessoa${i}`,
        commentText: 'eu quero', matchedKeyword: 'eu quero', source: 'webhook', status: 'skipped', skipReason: 'already_replied_to_person',
      }, T0 + i);
    }
    const session = await login(t.app, t.db);
    const first = await t.app.inject({ url: '/atividade?status=skipped', headers: { cookie: session.cookie } });
    expect(first.body).toContain('@pessoa24');
    expect(first.body).not.toContain('@pessoa4<');
    expect(first.body).toContain('Mais antigas');
    const second = await t.app.inject({ url: '/atividade?status=skipped&pagina=2', headers: { cookie: session.cookie } });
    expect(second.body).toContain('@pessoa4<');
    const none = await t.app.inject({ url: '/atividade?status=failed', headers: { cookie: session.cookie } });
    expect(none.body).toContain('Nada por aqui ainda');
  });
});
```


- [ ] **Step 2: Rodar e confirmar a falha**

```bash
npx vitest run test/http-activity.test.ts
```

Esperado: **FAIL** — `Failed to load url ../src/...` / `Cannot find module` (a implementação ainda não existe).

- [ ] **Step 3: Implementar**

`src/panel/views/activityPage.ts`:

```ts
import type { Account } from '../../db/repos/accounts.js';
import type { ActivityRow, InteractionStatus } from '../../db/repos/interactions.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { badge, buttonClass, card, emptyState, formatDateTime, icon, inputClass } from './components.js';
import { FAIL_REASON_TEXT, JOB_STATUS, SKIP_REASON_TEXT } from './messages.js';

function jobBadge(label: string, status: string | null, reason: string | null): SafeHtml {
  if (!status) return html``;
  const info = JOB_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return html`<div class="space-y-0.5"><div class="flex items-center gap-2 text-xs"><span class="text-muted-foreground">${label}</span>${badge(info.label, info.tone)}</div>
    ${status === 'failed' || status === 'cancelled' ? html`<p class="text-xs text-muted-foreground">${FAIL_REASON_TEXT[reason ?? ''] ?? 'Não foi possível enviar'}</p>` : ''}</div>`;
}

const STATUS_FILTERS: Array<{ value: '' | InteractionStatus; label: string }> = [
  { value: '', label: 'Tudo' },
  { value: 'done', label: 'Enviadas' },
  { value: 'queued', label: 'Na fila' },
  { value: 'partial', label: 'Parciais' },
  { value: 'failed', label: 'Falhas' },
  { value: 'skipped', label: 'Ignoradas' },
];

export function activityPage(input: {
  rows: ActivityRow[];
  accounts: Account[];
  filter: { accountId?: number; status?: InteractionStatus; page: number };
  hasNext: boolean;
}): SafeHtml {
  const { rows, filter } = input;
  const query = (page: number) =>
    new URLSearchParams({
      ...(filter.accountId ? { conta: String(filter.accountId) } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      pagina: String(page),
    }).toString();
  return html`<h1 class="text-2xl font-semibold tracking-tight">Atividade</h1>
    <form method="get" action="/atividade" class="flex flex-wrap gap-2"
      hx-get="/atividade" hx-trigger="change" hx-target="body" hx-push-url="true">
      <select name="conta" class="${inputClass('w-auto')}" aria-label="Conta">
        <option value="">Todas as contas</option>
        ${input.accounts.map((a) => html`<option value="${a.id}" ${a.id === filter.accountId ? 'selected' : ''}>@${a.username}</option>`)}
      </select>
      <select name="status" class="${inputClass('w-auto')}" aria-label="Situação">
        ${STATUS_FILTERS.map((s) => html`<option value="${s.value}" ${s.value === (filter.status ?? '') ? 'selected' : ''}>${s.label}</option>`)}
      </select>
      <noscript><button class="${buttonClass('outline')}">Filtrar</button></noscript>
    </form>
    ${rows.length
      ? html`<ul class="space-y-3">${rows.map((row) => html`<li>${card(html`<div class="space-y-3 p-4">
          <div class="flex items-start justify-between gap-2 text-sm">
            <div class="min-w-0"><p class="font-medium">@${row.commenterUsername ?? 'usuário'}</p><p class="truncate text-muted-foreground">em @${row.accountUsername} · ${formatDateTime(row.createdAt)}</p></div>
            ${row.mediaPermalink ? html`<a href="${row.mediaPermalink}" target="_blank" rel="noopener" class="${buttonClass('ghost', 'min-h-9 px-2')}" aria-label="Abrir post">${icon('ExternalLink')}</a>` : ''}
          </div>
          <blockquote class="rounded-md bg-secondary px-3 py-2 text-sm">“${row.commentText ?? ''}”</blockquote>
          ${row.status === 'skipped'
            ? html`<p class="text-xs text-muted-foreground">${SKIP_REASON_TEXT[row.skipReason ?? ''] ?? 'Ignorado'}</p>`
            : html`<div class="flex flex-wrap gap-4">${jobBadge('Comentário', row.publicStatus, row.publicFailReason)}${jobBadge('Direct', row.dmStatus, row.dmFailReason)}</div>`}
        </div>`)}</li>`)}</ul>`
      : emptyState('Activity', 'Nada por aqui ainda', 'Quando alguém comentar uma palavra-chave, a resposta aparece aqui.')}
    <div class="flex justify-between">
      ${filter.page > 1 ? html`<a href="/atividade?${query(filter.page - 1)}" class="${buttonClass('outline')}">Anteriores</a>` : html`<span></span>`}
      ${input.hasNext ? html`<a href="/atividade?${query(filter.page + 1)}" class="${buttonClass('outline')}">Mais antigas</a>` : ''}
    </div>`;
}
```


`src/panel/routes/activity.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { listAccounts } from '../../db/repos/accounts.js';
import { listActivity, type InteractionStatus } from '../../db/repos/interactions.js';
import type { PanelContext } from '../context.js';
import { activityPage } from '../views/activityPage.js';

const PAGE_SIZE = 20;
const STATUSES: InteractionStatus[] = ['queued', 'done', 'partial', 'failed', 'skipped'];

export async function registerActivityRoutes(app: FastifyInstance, ctx: PanelContext): Promise<void> {
  app.get('/atividade', async (request, reply) => {
    const query = request.query as { conta?: string; status?: string; pagina?: string };
    const accountId = Number(query.conta) || undefined;
    const status = STATUSES.find((s) => s === query.status);
    const page = Math.max(1, Number(query.pagina) || 1);
    const rows = listActivity(ctx.db, { accountId, status, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
    return ctx.render(request, reply, {
      title: 'Atividade',
      nav: 'atividade',
      body: activityPage({
        rows: rows.slice(0, PAGE_SIZE),
        accounts: listAccounts(ctx.db),
        filter: { accountId, status, page },
        hasNext: rows.length > PAGE_SIZE,
      }),
    });
  });
}
```


- [ ] **Step 3b: Registrar as rotas em `src/panel/register.ts`**

Adicione o import:

```ts
import { registerActivityRoutes } from './routes/activity.js';
```

E dentro do escopo protegido, logo após `await registerAutomationRoutes(protectedScope, ctx);`:

```ts
    await registerActivityRoutes(protectedScope, ctx);
```

- [ ] **Step 4: Rodar typecheck e toda a suíte**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  105 passed (105)`, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add test/http-activity.test.ts src/panel/views/activityPage.ts src/panel/routes/activity.ts src/panel/register.ts
git commit -m "feat(painel): tela de atividade"
```

---

### Task 14: Servidor executável, agendador e CLI de usuários

**Objetivo:** Compor tudo em `src/server.ts` (banco, cliente, OAuth, app, worker 1 s, reconciler 10 min, manutenção 6 h, shutdown gracioso) e um CLI que cria/reseta usuários do painel gerando a senha.

**Files:**
- Create: `src/server.ts`
- Create: `src/cli/users.ts`

**Interfaces:**
- Consumes: tudo das Tasks 1–13.
- Comandos: `node dist/server.js`; `node dist/cli/users.js create <email>`; `node dist/cli/users.js reset-password <email>`.

- [ ] **Step 1: Escrever os arquivos**

`src/server.ts`:

```ts
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db/database.js';
import { resetRunningJobs } from './db/repos/jobs.js';
import { refreshExpiringTokens, runHousekeeping } from './engine/maintenance.js';
import { reconcileOnce } from './engine/reconciler.js';
import { startScheduler, type Health } from './engine/scheduler.js';
import { runWorkerTick } from './engine/worker.js';
import { createInstagramClient } from './instagram/client.js';
import { createInstagramOAuth } from './instagram/oauth.js';
import { createTokenCipher } from './lib/crypto.js';
import { OAUTH_CALLBACK_PATH } from './panel/routes/accounts.js';

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
migrate(db);

const now = () => Date.now();
const random = () => Math.random();
const health: Health = { lastWorkerTickAt: null };
const cipher = createTokenCipher(config.ENCRYPTION_KEY);
const client = createInstagramClient({ version: config.GRAPH_API_VERSION });
const oauth = createInstagramOAuth({
  appId: config.IG_APP_ID,
  appSecret: config.IG_APP_SECRET,
  redirectUri: `${config.APP_BASE_URL}${OAUTH_CALLBACK_PATH}`,
});

const app = await buildApp({
  config,
  db,
  client,
  oauth,
  cipher,
  health,
  now,
  random,
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: ['req.headers.cookie', 'req.headers["x-hub-signature-256"]', 'req.query.code', '*.access_token', '*.token'],
  },
});
const log = app.log;

resetRunningJobs(db, now());
const decryptToken = (encoded: string) => cipher.decrypt(encoded);
const scheduler = startScheduler(
  [
    {
      name: 'worker',
      intervalMs: 1_000,
      run: async () => {
        await runWorkerTick({ db, client, decryptToken, now, random, maxActionsPerHour: config.MAX_ACTIONS_PER_HOUR, log });
        health.lastWorkerTickAt = now();
      },
      runOnStart: true,
    },
    { name: 'reconciler', intervalMs: 10 * 60_000, run: () => reconcileOnce({ db, client, decryptToken, now, random, log }) },
    {
      name: 'maintenance',
      intervalMs: 6 * 60 * 60_000,
      runOnStart: true,
      run: async () => {
        const tokens = await refreshExpiringTokens({ db, refresh: oauth.refresh, encrypt: cipher.encrypt, decrypt: decryptToken, now, log });
        const housekeeping = runHousekeeping(db, now());
        log.info({ tokens, housekeeping }, 'manutenção concluída');
      },
    },
  ],
  log,
);

await app.listen({ host: '0.0.0.0', port: config.PORT });

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'encerrando');
    await scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
```


`src/cli/users.ts`:

```ts
import { hash } from '@node-rs/argon2';
import { migrate, openDatabase } from '../db/database.js';
import { createUser, findUserByEmail, setUserPassword } from '../db/repos/users.js';
import { randomToken } from '../lib/crypto.js';

// Uso: node dist/cli/users.js create <email>   |   node dist/cli/users.js reset-password <email>
// Gera uma senha forte aleatória e a mostra UMA vez (não há tela de cadastro, por segurança).

const [command, email] = process.argv.slice(2);
if (!command || !email || !['create', 'reset-password'].includes(command) || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Uso: users <create|reset-password> <email>');
  process.exit(1);
}

const db = openDatabase(process.env.DATABASE_PATH ?? './data/app.db');
migrate(db);
const password = randomToken(12);
const passwordHash = await hash(password);

if (command === 'create') {
  if (findUserByEmail(db, email)) {
    console.error('Já existe um usuário com este e-mail. Use reset-password.');
    process.exit(1);
  }
  createUser(db, email, passwordHash, Date.now());
} else if (!setUserPassword(db, email, passwordHash)) {
  console.error('Usuário não encontrado.');
  process.exit(1);
}

console.log(`Usuário: ${email.toLowerCase()}\nSenha:   ${password}\nGuarde a senha agora — ela não será exibida de novo.`);
db.close();
```


- [ ] **Step 2: Typecheck e testes**

```bash
npx tsc --noEmit && npx vitest run
```

Esperado: **PASS** — `Tests  105 passed (105)`.

- [ ] **Step 3: Smoke test local** (crie um `.env` de desenvolvimento a partir do `.env.example`, com `APP_BASE_URL=http://localhost:3000`, `IG_ALLOWED_USERNAMES=<suas contas>` e segredos gerados com `openssl`)

```bash
npm run build
node --env-file=.env dist/cli/users.js create voce@exemplo.com      # imprime a senha gerada
node --env-file=.env dist/server.js &
curl -s localhost:3000/healthz                                      # {"status":"ok"}
curl -s "localhost:3000/webhooks/instagram?hub.mode=subscribe&hub.verify_token=$(grep WEBHOOK_VERIFY_TOKEN .env | cut -d= -f2)&hub.challenge=42"   # 42
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/privacidade  # 200
kill %1
```

Abra `http://localhost:3000/entrar`, entre com a senha impressa e navegue por Contas/Automações/Atividade.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/cli/users.ts
git commit -m "feat: servidor com agendador e CLI de usuários"
```

---

### Task 15: Polimento visual com a skill **impeccable** (obrigatório)

**Objetivo:** Levar o painel do visual-base (funcional, estilo shadcn) ao acabamento final — moderno, minimalista, profissional, intuitivo e mobile-first — **usando a skill `impeccable`**, sem quebrar contratos nem testes.

**Files:**
- Create: `scripts/seed-demo.mjs`, `scripts/screenshots.mjs`
- Modify (livremente, respeitando o contrato): `src/panel/styles.css`, `src/panel/views/*.ts`, `public/assets/app.js`

**Interfaces (contrato que NÃO muda):** nomes e assinaturas exportadas de `src/panel/views/components.ts`, `layout.ts`, `loginPage.ts`, `accountsPage.ts`, `automationPages.ts`, `activityPage.ts`; nomes dos tokens CSS (`--color-*`); atributos usados por testes/JS: `name="_csrf"`, `hx-headers` com `x-csrf-token`, `name="variations"`, `name="keywords"`, `name="dmText"`/`id="dmText"`, `data-max-bytes`, `data-counter-for`, `data-insert-token`, `data-reply-preview`, `role="switch"` + `aria-checked`, `/midia/:accountId/:mediaId`; e os textos verificados nos testes (mensagens de erro/flash em `test/http-*.test.ts`).

- [ ] **Step 1: Ferramentas de revisão visual**

`scripts/seed-demo.mjs`:

```js
// Popula um banco SEPARADO com dados fictícios para revisar o visual do painel (Task 15).
// Uso: npm run build && DATABASE_PATH=./data-demo/app.db node --env-file=.env scripts/seed-demo.mjs
import { migrate, openDatabase } from '../dist/db/database.js';
import { setMessagingDisabled, upsertConnectedAccount } from '../dist/db/repos/accounts.js';
import { createAutomation } from '../dist/db/repos/automations.js';
import { insertInteraction, refreshInteractionStatus } from '../dist/db/repos/interactions.js';
import { completeJob, enqueueJob, failJob } from '../dist/db/repos/jobs.js';
import { createTokenCipher } from '../dist/lib/crypto.js';

if (process.env.NODE_ENV === 'production' || !process.env.DATABASE_PATH?.includes('demo')) {
  console.error('Use apenas com um DATABASE_PATH de demonstração (ex.: ./data-demo/app.db), nunca em produção.');
  process.exit(1);
}

const db = openDatabase(process.env.DATABASE_PATH);
migrate(db);
const cipher = createTokenCipher(process.env.ENCRYPTION_KEY);
const now = Date.now();
const day = 86_400_000;

const loja = upsertConnectedAccount(db, { igId: '17840001', appUserId: 'demo1', username: 'loja.demo', tokenEnc: cipher.encrypt('demo'), tokenExpiresAt: now + 50 * day }, now);
const atelie = upsertConnectedAccount(db, { igId: '17840002', appUserId: 'demo2', username: 'atelie.demo', tokenEnc: cipher.encrypt('demo'), tokenExpiresAt: now + 50 * day }, now);
setMessagingDisabled(db, atelie.id, true, now);

const promo = createAutomation(db, {
  accountId: loja.id, mediaId: '17900001', mediaPermalink: 'https://www.instagram.com/',
  mediaCaption: 'Promoção de outubro! Comente EU QUERO que eu te mando o link com desconto 💜',
  keywords: ['EU QUERO', 'link'],
  publicVariations: ['Oi {usuario}, te mandei no direct! 💌', 'Prontinho {usuario}, olha o direct!', 'Enviado, {usuario}! Confere sua caixa de mensagens.'],
  dmText: 'Oi! Aqui está o link com desconto: https://exemplo.com/promo\n\n(mensagem automática)',
}, now - 3 * day);
createAutomation(db, {
  accountId: atelie.id, mediaId: '17900002', mediaCaption: 'Novo curso de bordado — comente CURSO',
  keywords: ['curso'], publicVariations: ['Te mandei, {usuario}!', 'Olha o direct, {usuario}', 'Enviado {usuario} ✨'], dmText: 'Inscrições: https://exemplo.com/curso',
}, now - day);

const samples = [
  ['ana.souza', 'Eu quero!!', 'done', 'done'],
  ['bia_m', 'EU QUERO 😍', 'done', 'failed'],
  ['carla.rp', 'eu quero também', 'pending', 'pending'],
  ['ana.souza', 'eu quero de novo', null, null],
];
samples.forEach(([user, text, pub, dm], i) => {
  const id = insertInteraction(db, {
    automationId: promo.id, commentId: `demo-${i}`, commenterIgsid: user, commenterUsername: user, commentText: text,
    matchedKeyword: 'EU QUERO', source: 'webhook', status: pub ? 'queued' : 'skipped', skipReason: pub ? undefined : 'already_replied_to_person',
  }, now - i * 600_000);
  if (!id || !pub) return;
  enqueueJob(db, { interactionId: id, accountId: loja.id, type: 'public_reply', runAt: now + 365 * day }, now);
  enqueueJob(db, { interactionId: id, accountId: loja.id, type: 'private_reply', runAt: now + 365 * day }, now);
  const [publicJob, dmJob] = db.prepare('SELECT id FROM jobs WHERE interaction_id = ? ORDER BY id').all(id);
  if (pub === 'done') completeJob(db, publicJob.id, 'demo', now);
  if (dm === 'done') completeJob(db, dmJob.id, 'demo', now);
  if (dm === 'failed') failJob(db, dmJob.id, { reason: 'messaging_disabled' }, now);
  refreshInteractionStatus(db, id);
});
console.log('Dados de demonstração criados em', process.env.DATABASE_PATH);
db.close();
```


`scripts/screenshots.mjs`:

```js
// Captura as telas do painel (mobile claro + desktop escuro) para revisão visual.
// Uso: BASE_URL=http://localhost:3000 LOGIN_EMAIL=... LOGIN_PASSWORD=... node scripts/screenshots.mjs
// Requer: npm i -D playwright@^1.64.1 && npx playwright install chromium
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
```


```bash
npm i -D playwright@^1.64.1 && npx playwright install chromium
npm run build
DATABASE_PATH=./data-demo/app.db node --env-file=.env scripts/seed-demo.mjs
DATABASE_PATH=./data-demo/app.db node --env-file=.env dist/cli/users.js create demo@exemplo.com   # anote a senha
DATABASE_PATH=./data-demo/app.db node --env-file=.env dist/server.js &
BASE_URL=http://localhost:3000 LOGIN_EMAIL=demo@exemplo.com LOGIN_PASSWORD=<senha> node scripts/screenshots.mjs
```

Esperado: imagens `screenshots/{mobile,desktop}-*.png` e **nenhum erro de console** (miniaturas aparecem como placeholder, pois os dados são fictícios).

- [ ] **Step 2: Invocar a skill `impeccable`** (ex.: `Skill: anthropic-skills:impeccable`) com este briefing:

> Painel web em português para UMA usuária não técnica (esposa) gerenciar respostas automáticas a comentários do Instagram. Mobile-first (uso principal no celular), estilo shadcn/ui, minimalista, moderno, profissional, calmo. Stack: HTML renderizado no servidor (templates em `src/panel/views/*.ts` com a função `html`), Tailwind CSS v4 (`src/panel/styles.css`, tokens `--color-*`), htmx, ícones lucide-static. Restrições: CSP `default-src 'self'` (nada de JS/CSS inline, fontes ou scripts externos — se quiser fonte própria, sirva o arquivo de `public/assets`); manter nomes/assinaturas exportadas e atributos listados no contrato; textos em português claro; alvos de toque ≥ 44 px; contraste AA em claro e escuro; respeitar `prefers-reduced-motion`. Telas: Entrar, Automações (lista + nova/editar com grade de posts), Atividade, Contas. Faça auditoria (hierarquia, espaçamento, tipografia, estados vazio/erro/carregando, foco, responsividade 360–1280 px) e aplique o polimento.

Pontos já identificados para a auditoria: indicador de carregamento na grade de posts (`hx-indicator`); altura dos campos de variação; destaque visual do post selecionado; espaçamento do cabeçalho em telas ≤ 360 px; feedback ao alternar o switch.

- [ ] **Step 3: Validar**

```bash
npx tsc --noEmit && npx vitest run      # Tests 105 passed
npm run build && node scripts/screenshots.mjs   # (com o servidor demo rodando)
```

Critérios de aceite: suíte verde; screenshots sem quebra de layout em 390 px e 1280 px, nos dois temas; nenhum erro de console/CSP; `docs/GUIA_DE_USO.md` continua correspondendo aos rótulos da interface.

- [ ] **Step 4: Commit**

```bash
git add src/panel public/assets/app.js scripts/seed-demo.mjs scripts/screenshots.mjs package.json package-lock.json
git commit -m "feat(painel): polimento visual (impeccable)"
```

---

### Task 16: Docker e deploy em `dm.adriancampana.cloud`

**Objetivo:** Imagem mínima e segura, Compose publicando só em `127.0.0.1:3010`, Nginx do host com HTTPS (Certbot), backup diário e runbook de operação.

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `deploy/nginx/dm.adriancampana.cloud.conf`, `deploy/backup.sh`, `docs/DEPLOY.md`

- [ ] **Step 1: Arquivos de container**

`Dockerfile`:

```dockerfile
# ---- build ----------------------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: os módulos nativos (better-sqlite3, argon2, sodium) já trazem binários pré-compilados,
# e não executar scripts de instalação reduz o risco de pacotes maliciosos.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime --------------------------------------------------------------------------------------
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```


`docker-compose.yml`:

```yaml
services:
  ig-autoreply:
    build: .
    image: ig-autoreply:latest
    container_name: ig-autoreply
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: "3000"
      DATABASE_PATH: /app/data/app.db
    ports:
      - "127.0.0.1:3010:3000" # só o Nginx do host alcança o app
    volumes:
      - ./data:/app/data
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```


`.dockerignore`:

```
node_modules
dist
data
data-demo
screenshots
public/assets/app.css
public/assets/htmx.min.js
.env
.env.*
test
docs
.git
```


- [ ] **Step 2: Nginx, backup e runbook**

`deploy/nginx/dm.adriancampana.cloud.conf`:

```nginx
# /etc/nginx/sites-available/dm.adriancampana.cloud  (ln -s para sites-enabled)
# Depois de ativar: sudo certbot --nginx -d dm.adriancampana.cloud  (o Certbot adiciona o bloco 443 e o redirect)
server {
    listen 80;
    listen [::]:80;
    server_name dm.adriancampana.cloud;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```


`deploy/backup.sh`:

```bash
#!/usr/bin/env bash
# Backup diário do SQLite (cópia consistente com o app rodando). Mantém 14 dias.
# crontab -e  →  15 3 * * * /opt/ig-autoreply/deploy/backup.sh >> /var/log/ig-autoreply-backup.log 2>&1
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/ig-autoreply}"
DEST="$APP_DIR/data/backups"
mkdir -p "$DEST"
sqlite3 "$APP_DIR/data/app.db" ".backup '$DEST/app-$(date +%F).db'"
find "$DEST" -name 'app-*.db' -mtime +14 -delete
echo "$(date -Is) backup ok"
```


`docs/DEPLOY.md`:

````markdown
# Deploy na VPS — dm.adriancampana.cloud

Pré-requisitos na VPS: Docker + Docker Compose, Nginx no host, Certbot (`python3-certbot-nginx`) e `sqlite3`.

## 1. DNS

No provedor do domínio, crie um registro `A` para `dm` apontando para o IP da VPS (e `AAAA` se a VPS tiver IPv6).
Confira com `dig +short dm.adriancampana.cloud`.

## 2. Código e configuração

```bash
sudo mkdir -p /opt/ig-autoreply && sudo chown $USER /opt/ig-autoreply
git clone <URL-DO-REPOSITORIO> /opt/ig-autoreply
cd /opt/ig-autoreply
cp .env.example .env && chmod 600 .env
# Preencha o .env. Gere os segredos:
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -base64 32   # SESSION_SECRET
openssl rand -hex 24      # WEBHOOK_VERIFY_TOKEN
mkdir -p data && sudo chown 1000:1000 data   # o container roda como usuário "node" (uid 1000)
```

> Guarde uma cópia do `ENCRYPTION_KEY` num gerenciador de senhas: sem ele, os tokens salvos não podem ser lidos
> (seria preciso reconectar as contas).

## 3. Subir o container

```bash
docker compose up -d --build
docker compose ps            # STATUS deve ficar "healthy" em ~30 s
curl -s http://127.0.0.1:3010/healthz   # {"status":"ok"}
```

## 4. Nginx + HTTPS

```bash
sudo cp deploy/nginx/dm.adriancampana.cloud.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/dm.adriancampana.cloud.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dm.adriancampana.cloud --redirect
curl -sI https://dm.adriancampana.cloud/privacidade | head -1   # HTTP/2 200
```

## 5. Usuários do painel

```bash
docker compose exec ig-autoreply node dist/cli/users.js create esposa@exemplo.com
docker compose exec ig-autoreply node dist/cli/users.js create voce@exemplo.com
# esqueceu a senha?
docker compose exec ig-autoreply node dist/cli/users.js reset-password esposa@exemplo.com
```

A senha é gerada e exibida **uma única vez**.

## 6. Backup diário

```bash
sudo crontab -e
# adicione:
15 3 * * * APP_DIR=/opt/ig-autoreply /opt/ig-autoreply/deploy/backup.sh >> /var/log/ig-autoreply-backup.log 2>&1
```

Recomendado: sincronizar `data/backups/` para fora da VPS (ex.: `rclone` para um storage).
Para restaurar: `docker compose down`, copie o backup para `data/app.db` e rode `docker compose up -d`.

## 7. Atualizar

```bash
cd /opt/ig-autoreply && git pull && docker compose up -d --build
```

As migrações do banco rodam automaticamente na inicialização.

## 8. Logs e diagnóstico

```bash
docker compose logs -f --since 1h ig-autoreply
docker compose exec ig-autoreply node -e "const D=require('better-sqlite3');const d=new D('/app/data/app.db',{readonly:true});console.log(d.prepare(\"select status,count(*) n from jobs group by status\").all())"
```
````


- [ ] **Step 3: Validar a imagem localmente**

```bash
chmod +x deploy/backup.sh
docker build -t ig-autoreply:local .
docker run --rm --entrypoint ls ig-autoreply:local public/assets     # app.css  app.js  htmx.min.js
```

- [ ] **Step 4: Deploy na VPS** — siga `docs/DEPLOY.md` (seções 1–6). Verificações:

```bash
docker compose ps                                          # ig-autoreply ... (healthy)
curl -sI https://dm.adriancampana.cloud/privacidade | head -1   # HTTP/2 200
curl -s https://dm.adriancampana.cloud/healthz             # {"status":"ok"}
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore deploy docs/DEPLOY.md
git commit -m "chore(deploy): docker, nginx, backup e runbook"
```

---

### Task 17: Configurar o app na Meta e testar com contas reais (modo Desenvolvimento)

**Objetivo:** Ligar o app da Meta ao serviço em produção e validar o fluxo ponta a ponta com as contas testers, antes do App Review.

- [ ] **Step 1: Business login settings** (*Instagram › API setup with Instagram login › Set up Instagram business login › Business login settings*):
  - OAuth redirect URI: `https://dm.adriancampana.cloud/auth/instagram/callback` (confira se o painel não acrescentou `/` no fim — deve ser idêntico ao do código).
  - Deauthorize callback URL: `https://dm.adriancampana.cloud/meta/deauthorize`
  - Data deletion request URL: `https://dm.adriancampana.cloud/meta/data-deletion`
  - Copie **Instagram app ID** e **Instagram app secret** para `IG_APP_ID`/`IG_APP_SECRET`; *App settings › Basic › App secret* para `META_APP_SECRET`; *Privacy Policy URL* = `https://dm.adriancampana.cloud/privacidade`. Rode `docker compose up -d`.
- [ ] **Step 2: Webhooks** (*Configure webhooks*): Callback URL `https://dm.adriancampana.cloud/webhooks/instagram`, Verify token = `WEBHOOK_VERIFY_TOKEN` › *Verify and save*. **Desassine todos os campos exceto `comments`** (o painel assina vários por padrão).
- [ ] **Step 3: Descobrir qual segredo assina os webhooks** (spec §15): defina `META_WEBHOOK_SECRETS=<META_APP_SECRET>` e reinicie; clique **Test** no campo `comments`; veja `docker compose logs --since 5m | grep -E "assinatura inválida|EVENT_RECEIVED|comentário processado"`. Se aparecer "assinatura inválida", troque para o `IG_APP_SECRET` e repita. Deixe **apenas** o segredo correto.
- [ ] **Step 4: Conectar as contas** — no painel: *Contas › Conectar conta do Instagram* (uma de cada vez; a tela do Instagram pede usuário/senha da conta certa). Esperado: "Conta @x conectada!".
- [ ] **Step 5: Teste ponta a ponta** — crie uma automação num post de teste; de **outra conta tester**, comente a palavra-chave. Em até ~2 min (webhook) ou ~10 min (reconciliador, caso o webhook ainda não chegue sem Advanced Access), confira em *Atividade*. Checklist (spec §14):
  1. comentário com palavra-chave → resposta pública + DM ✓
  2. mesma pessoa comenta de novo → "Esta pessoa já recebeu resposta neste post"
  3. comentário sem palavra-chave → nada
  4. post sem automação → nada
  5. comentário da própria conta → nada
  6. desligar "Permitir acesso a mensagens" → aviso "DMs bloqueadas" e DM com falha; religar
  7. remover o app em *Configurações › Apps e sites* do Instagram → conta "Desconectada" (callback) ou "Precisa reconectar"; reconectar
  8. botão **Test** do webhook → `200`
- [ ] **Step 6: Registrar o resultado** — anote o que funcionou em modo Desenvolvimento (a Meta avisa que webhooks de comentário exigem Advanced Access e que dados gerados nesse modo podem ficar visíveis só para quem tem função no app). Isso não bloqueia: a validação final acontece na Task 19.

---

### Task 18: Verificação de Negócio + App Review

**Objetivo:** Obter Advanced Access para as 3 permissões e deixar o app pronto para o modo Live.

**Files:**
- Create: `docs/APP_REVIEW.md`

`docs/APP_REVIEW.md`:

````markdown
# Kit do App Review (Instagram API with Instagram Login)

Referência: https://developers.facebook.com/documentation/instagram-platform/app-review

## Antes de enviar

- [ ] Verificação de Negócio **aprovada** e app conectado ao portfólio (App settings › Basic › Verification).
- [ ] App settings › Basic: ícone 1024×1024, **Privacy Policy URL** = `https://dm.adriancampana.cloud/privacidade`,
      categoria (ex.: "Business and Pages"), e-mail de contato.
- [ ] Business login settings: OAuth redirect URI = `https://dm.adriancampana.cloud/auth/instagram/callback`,
      Deauthorize callback = `https://dm.adriancampana.cloud/meta/deauthorize`,
      Data deletion request = `https://dm.adriancampana.cloud/meta/data-deletion`.
- [ ] Pelo menos **1 chamada bem-sucedida** de cada permissão nos últimos dias (conectar conta + resposta + DM de teste).
- [ ] Na VPS: `REVIEW_MODE=true` no `.env` e `docker compose up -d` (libera a conta de teste do revisor).
- [ ] Crie um usuário do painel para o revisor: `docker compose exec ig-autoreply node dist/cli/users.js create reviewer@adriancampana.cloud`.
- [ ] Permissões solicitadas: **somente** `instagram_business_basic`, `instagram_business_manage_comments`,
      `instagram_business_manage_messages`. Desmarque `instagram_business_content_publish`, `instagram_business_manage_insights`
      e o recurso **Human Agent** (se não for possível desmarcá-lo, explique que não é usado).

## Textos para colar (em inglês)

### App verification — instructions for reviewers

```
1. Open https://dm.adriancampana.cloud/entrar and sign in with the panel credentials below.
2. Go to "Contas" (Accounts) and click "Conectar conta do Instagram" (Connect Instagram account).
   Log in with an Instagram professional account and grant all requested permissions.
3. Go to "Automações" (Automations) › "Nova automação" (New automation). Select the account and one of its posts,
   type a keyword (e.g. "INFO"), write three public reply variations and the private message text, then save.
4. From another Instagram account, comment "INFO" on that post.
5. Within ~2 minutes the app replies publicly to the comment (instagram_business_manage_comments) and sends one
   private reply to the commenter (instagram_business_manage_messages). The result is listed under "Atividade" (Activity).

Panel credentials: reviewer@adriancampana.cloud / <SENHA GERADA PELO CLI>
The UI is in Portuguese; the screencasts include English captions.
```

### instagram_business_basic

```
Used to identify the Instagram professional account that the business owner connects (user ID, username, profile picture),
to list the account's own recent posts so the owner can choose which post an automation applies to, and to refresh the
long-lived access token. This data is shown only to the account owner inside our private panel.
```

### instagram_business_manage_comments

```
Used to receive the "comments" webhook for the owner's own posts, read new comments on posts where the owner enabled an
automation, and publish a single public reply to comments that contain the owner-defined keyword. We never comment on
third-party content, and each commenter receives at most one public reply per post.
```

### instagram_business_manage_messages

```
Used exclusively to send one Private Reply (POST /<IG_ID>/messages with recipient.comment_id) to a person who commented a
keyword on the owner's post, within the 7-day window, containing the information the commenter asked for (e.g. a link).
We do not send unsolicited messages, follow-ups or bulk messages, and the message is identified as automated.
```

## Roteiro dos vídeos (1 por permissão, ~1–2 min cada, legendas em inglês)

1. **basic**: login no painel → Contas → "Conectar conta do Instagram" → tela de permissões do Instagram → volta com
   "Conta @x conectada!" → Nova automação mostrando a grade de posts da conta.
2. **manage_comments**: criar automação com palavra-chave → em outro celular/conta, comentar a palavra → mostrar a
   resposta pública aparecendo no post → tela Atividade com "Comentário: Enviada".
3. **manage_messages**: mesmo fluxo, mostrando a DM recebida pela conta que comentou (pasta Solicitações/Principal) →
   Atividade com "Direct: Enviada".

Dica: grave a tela do computador (painel) e do celular (Instagram) lado a lado; adicione legendas curtas explicando
cada botão ("Contas = Accounts", "Automações = Automations"...).

## Depois da aprovação

- `REVIEW_MODE=false` e `docker compose up -d`.
- Remova o usuário do revisor do banco (ou faça `reset-password` para invalidar a senha).
- Desconecte a conta de teste do revisor, se ela tiver sido conectada.
````


- [ ] **Step 1:** Confirmar a Verificação de Negócio **aprovada** (Task 0) e o app conectado ao portfólio verificado.
- [ ] **Step 2:** Preencher *App settings › Basic* (ícone, privacidade, categoria, e-mail) e garantir chamadas bem-sucedidas recentes de cada permissão (Task 17).
- [ ] **Step 3:** `REVIEW_MODE=true` na VPS + usuário do revisor via CLI.
- [ ] **Step 4:** Gravar os 3 vídeos (roteiro acima, legendas em inglês) e enviar em *Instagram › API setup with Instagram login › Complete app review › Continue to app review › Edit*.
- [ ] **Step 5:** Se reprovado: ler o motivo em *App Review › Requests*, ajustar exatamente o ponto citado (texto, vídeo ou instruções) e reenviar.
- [ ] **Step 6: Commit**

```bash
git add docs/APP_REVIEW.md
git commit -m "docs: kit do App Review"
```

---

### Task 19: Go-live e entrega

**Objetivo:** App em modo Live, validação final com uma conta comum (sem função no app) e entrega do guia de uso.

**Files:**
- Create: `docs/GUIA_DE_USO.md`

`docs/GUIA_DE_USO.md`:

```markdown
# Guia rápido — Respostas automáticas

Endereço: **https://dm.adriancampana.cloud** (dica: no celular, "Adicionar à tela inicial").

## Criar uma automação

1. Toque em **Automações › Nova automação**.
2. Escolha a **conta** e toque no **post** (os que já têm automação aparecem apagados).
3. **Palavras-chave**: o que a pessoa precisa comentar. Ex.: `EU QUERO, link`. Maiúsculas e acentos não importam.
4. **Resposta no comentário**: escreva **3 versões diferentes** (o sistema sorteia uma). Use `{usuario}` para marcar
   a pessoa. Ex.: `Oi {usuario}, te mandei no direct! 💌`
5. **Mensagem no Direct**: o que a pessoa recebe no privado (pode ter link). Termine com "(mensagem automática)".
6. Toque em **Criar automação**. Pronto — ela já está ativa.

## No dia a dia

- **Pausar/ativar**: use a chavinha no card da automação.
- **Atividade**: mostra cada comentário respondido. ✓ verde = enviado. Se algo falhar, o motivo aparece em português.
- Cada pessoa recebe **uma** resposta e **uma** DM por post, mesmo se comentar várias vezes (isso protege a conta).
- As respostas saem entre 15 segundos e 2 minutos depois do comentário — é proposital, para parecer natural.

## Avisos que podem aparecer

| Aviso | O que fazer |
|---|---|
| **Precisa reconectar** | Em **Contas**, toque em **Reconectar** e entre com a conta do Instagram. |
| **DMs bloqueadas** | No app do Instagram: Configurações › Mensagens e respostas a stories › Ferramentas conectadas › ative **Permitir acesso a mensagens**. |
| **Pausada por segurança** | O Instagram pediu uma pausa. Não faça nada: volta sozinho em 24 h. Se repetir, fale com o Adrian. |

## Boas práticas (para não ter problema com o Instagram)

- Use automação em posts com chamada clara ("comente EU QUERO que te mando o link").
- Não peça para as pessoas comentarem várias vezes.
- Varie as respostas e evite textos só com link.
```


- [ ] **Step 1:** Com a aprovação: publique o app (*Publish* / modo **Live**). Na VPS: `REVIEW_MODE=false`, `docker compose up -d`; invalide o usuário do revisor (`reset-password`) e desconecte a conta de teste dele, se conectada.
- [ ] **Step 2:** Repita o checklist da Task 17 (Step 5) comentando de uma **conta comum que não é tester** — valida a visibilidade pública da resposta e a entrega da DM (pasta *Solicitações* se a pessoa não segue a conta).
- [ ] **Step 3: Monitorar a 1ª semana** — diariamente: tela *Atividade* (falhas?), `docker compose logs --since 24h | grep -E '"level":(40|50)'`, `docker compose ps` (healthy), e o arquivo de backup do dia em `data/backups/`.
- [ ] **Step 4: Entregar** — envie `docs/GUIA_DE_USO.md` (ou imprima) para sua esposa; adicione o painel à tela inicial do celular dela; crie juntos a primeira automação real.
- [ ] **Step 5: Manutenção recorrente** — lembrete **semestral**: ler o changelog da Instagram Platform/Graph API, atualizar `GRAPH_API_VERSION` antes do fim do suporte da versão atual, `npm outdated`/atualizações de segurança, e testar a restauração de um backup.
- [ ] **Step 6: Commit**

```bash
git add docs/GUIA_DE_USO.md
git commit -m "docs: guia de uso do painel"
```

---

## Mapa spec → tasks

| Spec | Onde |
|---|---|
| §3 decisões / §4.1 setup Instagram Login | Tasks 1, 4 |
| §4.2 caminho completo (BV → App Review → Live) | Tasks 0, 17, 18, 19 |
| §4.3 permissões mínimas | Task 4 (`REQUIRED_SCOPES`), 11 (checagem no callback), 18 |
| §4.4 endpoints | Task 4 |
| §4.5 regras/limites | Tasks 7, 8, 12 (1000 bytes), 9 (7 dias) |
| §4.6 dois formatos de payload | Task 6 |
| §5 arquitetura/módulos | Tasks 1–14 |
| §6.1 webhook | Task 10 |
| §6.2 matcher (7 regras) | Task 7 |
| §6.3 worker / §10 anti-spam / §9 erros | Tasks 4, 7, 8 |
| §6.4 reconciler | Task 9 |
| §6.5 ciclo de vida da conta | Tasks 9, 11 |
| §7 modelo de dados | Tasks 2, 5 |
| §8 painel + requisito impeccable | Tasks 11–13, 15 |
| §11 segurança | Tasks 3, 10, 11, 16 |
| §12 privacidade/conformidade | Tasks 10, 9 (retenção) |
| §13 deploy | Task 16 |
| §14 testes | todas (TDD) + Task 17 (manual) |
| §15 riscos (segredo do webhook, modo dev) | Tasks 1 (`META_WEBHOOK_SECRETS`), 9, 17 |
| §16 roteiro | Visão geral + Tasks 0–19 |
