# ig-autoreply — Design (spec)

> Automação própria de resposta a comentários do Instagram (resposta pública + DM), sem Manychat.
> Data: 2026-10-27 · Versão da Graph API de referência: **v26.0** · Status: **aguardando revisão**

---

## 1. Contexto e objetivo

Responder automaticamente comentários nos posts de **contas próprias** do Instagram (mais de uma conta), seguindo à risca a documentação e as políticas da Meta para evitar bloqueio de conta ou do app.

- **Usuária principal:** esposa do desenvolvedor (não é dev). A interface precisa ser simples, clara e pensada para celular.
- **Uso:** exclusivamente próprio. Não será comercializado nem oferecido a terceiros.
- **Hospedagem:** VPS própria em `https://dm.adriancampana.cloud`.

### Critérios de sucesso

1. Um comentário com a palavra-chave configurada em um post com automação ativa recebe **uma resposta pública** (variação sorteada, com @menção) e **uma DM** (*private reply*) em até ~2 minutos.
2. Nenhum comentário recebe resposta duplicada, mesmo com reentregas de webhook.
3. A esposa consegue criar, pausar e editar automações e entender falhas **sem ajuda técnica**.
4. Nenhuma ação viola os limites e regras documentados pela Meta (seção 4).

## 2. Escopo

**Dentro do escopo**
- Várias contas Instagram profissionais (Comercial/Criador, públicas) conectadas via Business Login for Instagram.
- Automação **por post**, com gatilho de **palavras-chave**.
- Resposta pública com **variações sorteadas** e DM única por comentário (*private reply*).
- Painel web: login, contas, automações, atividade.
- Recebimento em tempo real (webhook `comments`) mais reconciliação periódica.
- Deploy Docker na VPS existente (Nginx do host + Certbot).

**Fora do escopo (YAGNI)**
- Respostas geradas por IA.
- Fluxos de conversa em várias etapas, follow-ups, botões/quick replies e "verificação de seguidor".
- Automação para Stories, Lives (`live_comments`), anúncios e menções.
- Uso por terceiros, multi-tenant, cobrança.
- Notificações externas (e-mail/Telegram). Os alertas ficam no painel.

## 3. Decisões tomadas

| Tema | Decisão |
|---|---|
| Ação | Responder publicamente **e** enviar DM (*private reply*) |
| Gatilho | Palavras-chave **por post** |
| Conteúdo | Resposta pública com ≥ 3 **variações sorteadas** e `{usuario}`; DM com texto fixo por automação |
| Contas | Todas profissionais e públicas |
| Caminho Meta | **Oficial completo:** Verificação de Negócio (CNPJ) → App Review (Advanced Access) → app **Live** → webhooks |
| Setup de API | **Instagram API with Instagram Login** (`graph.instagram.com`, Business Login for Instagram), sem Página do Facebook |
| Arquitetura | **Serviço único** Node.js + TypeScript (Fastify), SQLite, painel renderizado no servidor + htmx |
| Infra | Docker Compose; Nginx no host com Certbot; subdomínio `dm.adriancampana.cloud` |
| UI | **Obrigatório:** construída com a skill **impeccable**; visual moderno, minimalista, profissional, intuitivo, *mobile-first*, componentes no estilo shadcn/ui |

## 4. Análise da documentação da Meta (outubro/2026)

Fonte: páginas oficiais em `developers.facebook.com/documentation/...`, versão atual **v26.0** (lançada em 29/07/2026). Os links completos estão na seção 17.

### 4.1 Setups de API disponíveis

A Meta oferece três setups:
- **Unified Login:** a Meta o **recomenda para novas integrações** e diz que *novos recursos da API são lançados só nele*. Exige app pertencente a um portfólio empresarial, configuração de login e token de *Business Integration System User*. Seu vocabulário e fluxo são voltados a "clientes" que conectam ativos.
- **Instagram Login:** marcado como "existing Instagram Login integrations".
- **Facebook Login:** exige Página do Facebook.

**Escolha: Instagram Login.** Os motivos:
1. Não exige Página do Facebook nem portfólio no fluxo de login.
2. Suporta tudo o que precisamos: moderação de comentários, *private replies* e mensagens.
3. A documentação de comentários, *private replies* e webhooks tem exemplos completos para esse setup.
4. Todos os recursos necessários já existem; não dependemos de nada "só do Unified".

**Trade-off assumido:** recursos futuros podem sair só no Unified Login. A migração é documentada (*Migrate to the Instagram API with Unified Login*: trocar host para `graph.facebook.com`, permissões `instagram_*` e token), e o `instagram-client` isola host, versão e token para tornar essa troca localizada. Acompanhar o changelog semestralmente (seção 15).

### 4.2 Níveis de acesso e por que precisamos do caminho completo

A documentação **se contradiz** quanto ao "uso próprio":

| Página | Afirmação |
|---|---|
| App Review for Instagram API | "Meu app é só para um negócio que eu possuo" + Instagram Login → **Standard Access, App Review não exigido** |
| Webhooks › Setup | "**Advanced Access is required for `comments` and `live_comments` notifications**"; "Your app must be published or **Live** to receive notifications"; Business Verification "required for production access" |
| Create a Meta app | "You're required to connect your app to a business that has completed **Business Verification** before you can **publish** your app" |
| App Modes | Em modo Desenvolvimento, "data generated while an app is in Development mode … can only be seen by role users" |
| Messaging API | Standard Access: "Some features may not work properly until your app has been granted Advanced Access" |

**Conclusão.** Para ter, com garantia documental, (a) webhooks de comentário em tempo real, (b) respostas e DMs visíveis para quem comentou (usuários sem função no app) e (c) o app em modo Live, o caminho seguro é:

**Verificação de Negócio → App Review (Advanced Access para as 3 permissões) → app Live.**

É o mesmo caminho que ferramentas como o Manychat percorrem.

### 4.3 Permissões necessárias (Instagram Login)

| Permissão (`scope`) | Uso |
|---|---|
| `instagram_business_basic` | Perfil, lista de mídias, renovação de token |
| `instagram_business_manage_comments` | Ler comentários, responder (`/replies`), webhook `comments`, campo `username` do autor |
| `instagram_business_manage_messages` | Enviar *private reply* (`/messages` com `recipient.comment_id`) |

Não pedir: `instagram_business_content_publish`, `instagram_business_manage_insights` nem o recurso Human Agent. Pedir permissões que o app não usa é motivo documentado de reprovação no App Review.

### 4.4 Endpoints utilizados

Host `https://graph.instagram.com/v26.0`, com token de usuário do Instagram em `Authorization: Bearer`.

| Operação | Endpoint |
|---|---|
| Autorização | `https://www.instagram.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state` (embed URL do painel) |
| Code → token curto (1h) | `POST https://api.instagram.com/oauth/access_token` (`client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code`) |
| Token curto → longo (60 dias) | `GET /access_token?grant_type=ig_exchange_token&client_secret&access_token` |
| Renovar token longo | `GET /refresh_access_token?grant_type=ig_refresh_token&access_token`. Exige token com ≥ 24h e ainda válido; renova por mais 60 dias |
| Dados da conta | `GET /me?fields=user_id,username,name,profile_picture_url,account_type` (`user_id` = `ig_id` dos webhooks) |
| Inscrever a conta nos webhooks | `POST /me/subscribed_apps?subscribed_fields=comments` |
| Listar posts | `GET /me/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp` |
| Ler comentários (reconciliação) | `GET /{media_id}/comments?fields=id,text,timestamp,from{id,username},hidden` (máx. 50 por página, ordem cronológica reversa, sem filtro por data) |
| Resposta pública | `POST /{comment_id}/replies` com `message` |
| *Private reply* (DM) | `POST /{ig_id}/messages` com `{"recipient":{"comment_id":"…"},"message":{"text":"…"}}` |

Observações (conferidas na página *Business Login for Instagram* e no *Get Started*, v26.0):
- O code de autorização vale **1 hora** e é de **uso único**. Remover o sufixo `#_` que a Meta anexa ao redirect.
- O `user_id` devolvido na troca do code é um ID *escopado do app*, que **não** é o ID usado nos webhooks. O ID da conta (`ig_id`, igual a `entry.id` nos webhooks) vem de `GET /me?fields=user_id,username`.
- A resposta da troca do code aparece na doc envolvida em `{"data":[{...}]}`. O parser deve aceitar esse formato e também o formato plano.
- `account_type` retorna `Business` ou `Media_Creator`.
- `/access_token` e `/refresh_access_token` são chamados **sem** prefixo de versão (`graph.instagram.com/access_token`).
- `media_url` pode vir ausente em vídeos com áudio protegido (changelog de 30/07/2026). Usar `thumbnail_url` ou `permalink` como alternativa.

### 4.5 Regras e limites relevantes

**Respostas públicas**
- Só se responde a comentários de nível superior; resposta a uma resposta vai para o comentário raiz.
- Não é possível responder comentário oculto nem comentário de Live.

**Private replies**
- **1 mensagem** por comentário, enviada em **até 7 dias** da criação do comentário.
- Inclui automaticamente um link para o post.
- Vai para a caixa **Principal**, se a pessoa segue a conta, ou para **Solicitações**, se não segue.
- Follow-ups só são permitidos se a pessoa responder, e dentro de 24h. **Não fazemos follow-ups.**

**Mensagens**
- Texto UTF-8 com no máximo **1000 bytes**.
- A conta precisa estar com **"Permitir acesso a mensagens"** ativado. Caso contrário, a API retorna o erro `#200 … disabled access to Instagram Direct Messaging Outside of Instagram App`.

**Limites de chamadas**
- **Private replies:** 750 chamadas por hora por conta profissional (posts e reels).
- **Demais endpoints:** `4800 × impressões da conta nas últimas 24h`, por par app↔conta. O consumo vem no header `X-Business-Use-Case-Usage`.

**Webhooks**
- Exigem HTTPS com certificado válido (autoassinado não é aceito).
- O verify token é ecoado em `hub.challenge`.
- Assinatura `X-Hub-Signature-256: sha256=…` (HMAC-SHA256 do corpo com o App Secret).
- O endpoint deve responder **200 rapidamente**.
- Entregas em lote de até 1000; reenvios por até **36h**, então pode haver duplicatas.
- **Não há histórico** de eventos na Meta.
- A conta dona da mídia precisa ser **pública**.
- Não é possível escolher campos por conta: todas recebem os campos assinados no app.

**Automação de chat**
- A Meta recomenda (e algumas leis exigem) informar que a mensagem é automática.
- As políticas aplicáveis estão listadas na seção 17.

### 4.6 Formato do webhook `comments` (Business Login for Instagram)

A documentação mostra **duas variações** para o mesmo evento: com o envelope `changes[]` (página *Self Messaging*) e com `field`/`value` diretamente na `entry` (páginas *Comment Moderation* e *Webhook Examples*). **O parser deve aceitar as duas.**

```json
{ "object": "instagram",
  "entry": [{
    "id": "<IG_ID_DA_CONTA>", "time": 1700000000,
    "changes": [{ "field": "comments",
      "value": {
        "id": "<COMMENT_ID>",
        "from": { "id": "<IGSID_AUTOR>", "username": "<USERNAME>", "self_ig_scoped_id": "<presente se autor = a própria conta>" },
        "text": "<TEXTO>",
        "parent_id": "<presente se for resposta a comentário>",
        "media": { "id": "<MEDIA_ID>", "media_product_type": "FEED|REELS|STORY|AD" }
      } }]
  }]
}
```

As respostas publicadas pelo próprio app também geram webhook `comments`, com `from.id` igual ao ID da conta. Elas **precisam ser ignoradas** para evitar loop.

## 5. Arquitetura

```
Instagram ──webhook──► Nginx (host, TLS/Certbot) ──► container ig-autoreply (Fastify :3000, publicado em 127.0.0.1:3010)
                                                        ├─ webhooks   (GET verify / POST eventos)
                                                        ├─ matcher    (regras → interações)
                                                        ├─ queue+worker (jobs com retry/backoff, ritmo por conta)
                                                        ├─ reconciler (varredura periódica dos posts ativos)
                                                        ├─ accounts   (Business Login, tokens, subscribed_apps, refresh)
                                                        ├─ instagram-client (Graph API v26.0, rate-limit aware)
                                                        ├─ panel      (SSR + htmx, Tailwind, estilo shadcn)
                                                        └─ public     (privacidade, desautorização, exclusão de dados)
                                                     SQLite (volume ./data)
```

### 5.1 Módulos e responsabilidades

Cada módulo tem uma interface pequena e é testável isoladamente.

| Módulo | Responsabilidade | Depende de |
|---|---|---|
| `config` | Carregar e validar o `.env` (zod); falhar ao subir se faltar algo | — |
| `db` | Conexão SQLite (better-sqlite3, modo WAL), migrações SQL versionadas, repositórios | `config` |
| `crypto` | AES-256-GCM para tokens; HMAC para webhooks e `signed_request` | `config` |
| `instagram-client` | Chamadas HTTP à Graph API; parse do header de uso; classificação de erros (seção 9) | `config` |
| `webhooks` | Validar assinatura, gravar evento bruto, extrair comentários (os dois formatos), responder 200 | `crypto`, `db`, `matcher` |
| `matcher` | Decidir se um comentário vira interação (seção 6.2) e enfileirar jobs | `db` |
| `queue` / `worker` | Executar jobs com ritmo humano, retries e disjuntor | `db`, `instagram-client` |
| `reconciler` | A cada 10 min, ler os comentários recentes dos posts com automação ativa e passar pelo `matcher` | `instagram-client`, `matcher` |
| `accounts` | Business Login (state CSRF), troca e renovação de tokens, `subscribed_apps`, allowlist, status | `instagram-client`, `crypto`, `db` |
| `scheduler` | Timers internos: worker (1s), reconciler (10 min), refresh de token (diário), limpeza de retenção (diária) | todos acima |
| `panel` | Rotas e templates do painel; autenticação; CSRF | `db`, `accounts` |
| `public` | Páginas e callbacks públicos exigidos pela Meta | `crypto`, `db` |

### 5.2 Stack

- **Runtime e servidor:** Node.js 24 LTS, TypeScript (strict), Fastify, `@fastify/formbody`, `@fastify/cookie`, `@fastify/secure-session` (ou sessão em SQLite), `@fastify/helmet`, `@fastify/rate-limit` e `@fastify/static`.
- **Dados e validação:** better-sqlite3 com migrações SQL simples; zod para validar env, payloads e formulários.
- **Templates:** JSX/TSX no servidor via `@kitajs/html` ou equivalente type-safe; htmx para interações sem SPA.
- **Estilo:** Tailwind CSS v4 (build no Dockerfile) e ícones Lucide (SVG). Componentes visuais no estilo shadcn/ui, implementados como partials do servidor.
- **Qualidade:** pino (logs JSON com redação de segredos), Vitest e `undici` MockAgent, ESLint e Prettier.

## 6. Fluxo de dados

### 6.1 Recebimento (webhook)

1. `GET /webhooks/instagram`: se `hub.mode=subscribe` e `hub.verify_token` confere, responder `hub.challenge` em texto puro; senão, 403.
2. `POST /webhooks/instagram`:
   1. Ler o **corpo bruto**, validar `X-Hub-Signature-256` com `timingSafeEqual` (aceitando o segredo configurado em `META_WEBHOOK_SECRETS`, ver seção 15). Inválido → 403.
   2. Gravar em `webhook_events` (payload bruto).
   3. Extrair os comentários (`field = comments`) nos dois formatos possíveis.
   4. Para cada comentário, chamar `matcher.handle(...)` de forma síncrona e barata (só SQLite).
   5. Responder **200** em seguida. Nenhuma chamada à Graph API acontece no ciclo da requisição.

### 6.2 Regras do matcher

Um comentário vira **interação** somente se **todas** as condições forem verdadeiras:

1. `entry.id` corresponde a uma conta conectada e com status ativo.
2. O autor **não** é a própria conta: `from.id ≠ ig_id` e sem `self_ig_scoped_id`.
3. `media.id` tem uma automação **ativa**.
4. O texto normalizado contém alguma palavra-chave normalizada. A normalização é: minúsculas, remoção de acentos (NFD), colapso de espaços e casamento por palavra ou frase inteira (`\b`), para evitar que "link" case dentro de "linkedin".
5. O comentário tem menos de 7 dias (no webhook, assume-se recente; no reconciler, usa-se `timestamp`).
6. Ainda **não** existe interação com o mesmo `comment_id` (índice único).
7. A pessoa (`from.id`) ainda **não** recebeu ação nesta automação. A regra é: **1 resposta pública + 1 DM por pessoa por post**. Casos que não cumprem a regra 7 são gravados como `skipped` com o motivo.

Para cada interação são criados 2 jobs:
- `public_reply`: `run_at = agora + aleatório(15–90s)`;
- `private_reply`: `run_at = run_at da pública + aleatório(3–10s)`.

Se o comentário for resposta a outro comentário (`parent_id`), a resposta pública vai para o fio do comentário raiz (comportamento da API).

### 6.3 Worker

- Laço a cada 1s: pega o próximo job `pending` com `run_at ≤ agora`, **um por conta por vez** (serialização por conta).
- **Ritmo:**
  - intervalo mínimo de 8s entre ações da mesma conta;
  - teto configurável de **200 ações por hora por conta** (padrão); ao atingir, reagenda.
- **Execução:**
  - `public_reply`: sorteia uma variação diferente da última usada nessa automação, substitui `{usuario}` por `@username` e chama `POST /{comment_id}/replies`.
  - `private_reply`: chama `POST /{ig_id}/messages` com `recipient.comment_id`.
- **Resultado:** grava `done` com o ID retornado ou aplica a política de erro (seção 9). Os dois jobs são independentes: a DM é enviada mesmo que a resposta pública falhe, e vice-versa.

### 6.4 Reconciler

A cada 10 minutos, para cada automação ativa (conta ok), lê `/{media_id}/comments` e pagina até encontrar um `comment_id` já conhecido ou um comentário com mais de 7 dias. Cada comentário novo passa pelo mesmo `matcher`.

Isso cobre webhooks perdidos e permite testar o fluxo antes da aprovação do App Review. O custo é baixo: 1 chamada por post ativo a cada 10 min, muito abaixo do limite de `4800 × impressões`.

### 6.5 Ciclo de vida da conta

1. **Conectar:** o painel redireciona para a embed URL, com `state` aleatório guardado na sessão.
2. **Callback:** trata `error=access_denied` com mensagem amigável; valida o `state`; troca o code pelo token curto e o token curto pelo longo; chama `GET /me` para obter o `ig_id` (campo `user_id`).
3. **Checagens:** confere a **allowlist** (`IG_ALLOWED_USERNAMES`) e se `account_type` ∈ {`Business`, `Media_Creator`}, e se as 3 permissões foram concedidas (se faltar alguma, o painel pede para reconectar marcando todas). Grava o token criptografado e a expiração.
4. **Inscrição:** `POST /me/subscribed_apps?subscribed_fields=comments`.
5. **Refresh diário:** renova tokens com ≥ 24h de idade e vencimento em ≤ 30 dias. Se falhar com 190, marca a conta como `reconnect_required`.
6. **Desconectar** (pelo painel ou pelo callback de desautorização): apaga o token e pausa as automações da conta.

## 7. Modelo de dados (SQLite)

```sql
users(id, email UNIQUE, password_hash, created_at)
sessions(id, user_id, expires_at)                       -- se não usar cookie selado
ig_accounts(id, ig_id UNIQUE, username, profile_picture_url,
            token_enc, token_expires_at, token_refreshed_at,
            status CHECK IN ('ok','reconnect_required','messaging_disabled','paused_by_safety','disconnected'),
            paused_until, last_error, connected_at, updated_at)
automations(id, account_id, media_id, media_permalink, media_thumbnail_url, media_caption,
            keywords_json, public_variations_json, dm_text,
            is_active, last_variation_index, created_at, updated_at,
            UNIQUE(account_id, media_id))
webhook_events(id, received_at, signature_ok, payload_json)        -- retenção 30 dias
interactions(id, automation_id, comment_id UNIQUE, commenter_igsid, commenter_username,
             comment_text, matched_keyword, source CHECK IN ('webhook','reconciler'),
             status CHECK IN ('queued','done','partial','failed','skipped'), skip_reason,
             created_at)                                          -- retenção 90 dias
jobs(id, interaction_id, account_id, type CHECK IN ('public_reply','private_reply'),
     status CHECK IN ('pending','running','done','failed','cancelled'),
     attempts, run_at, last_error_code, last_error_message, result_id, updated_at,
     UNIQUE(interaction_id, type))
```

Índices: `jobs(status, run_at)`, `interactions(automation_id, commenter_igsid)` e `interactions(created_at)`.

## 8. Painel (UX)

### 8.1 Requisito de design (obrigatório)

- Toda a interface deve ser construída **usando a skill `impeccable`**.
- **Visual:** moderno, minimalista, profissional, intuitivo e **mobile-first**, no **estilo shadcn/ui** (não precisa usar a biblioteca).
- **Componentes:** cards, badges de status, switches, inputs com rótulo, campo de "etiquetas", dialogs/sheets, toasts, *empty states* e *skeletons*.
- **Base visual:** tipografia limpa (ex.: Geist/Inter), bordas sutis, raio médio, paleta neutra com uma cor de destaque, modo claro e escuro.
- **Acessibilidade:** contraste AA, foco visível, alvos de toque ≥ 44px, textos em **português claro**, sem jargão técnico.

### 8.2 Telas

1. **Entrar:** e-mail e senha. Usuários são criados por comando de CLI (`npm run user:create`); não há cadastro público.
2. **Contas:**
   - um card por conta (foto, @, status em linguagem simples, validade do token);
   - botão **Conectar conta do Instagram**, que é também o "login button" exigido pelo App Review;
   - ações: reconectar e desconectar;
   - mensagens de status: "Funcionando"; "Precisa reconectar"; "DMs bloqueadas: no app do Instagram, vá em Configurações › Mensagens e respostas a stories › Ferramentas conectadas e ative *Permitir acesso a mensagens*"; "Pausada por segurança até HH:MM".
3. **Automações:**
   - lista: miniatura, conta, palavras-chave, switch Ativa/Pausada e contadores (hoje e total);
   - **Nova/Editar** em uma página:
     1. conta;
     2. post, escolhido numa grade com os ~24 posts e reels mais recentes;
     3. palavras-chave (etiquetas);
     4. variações da resposta pública (mínimo 3, com botão "inserir {usuario}");
     5. texto da DM (contador de bytes até 1000, sugestão de rodapé "Mensagem automática");
     6. pré-visualização e salvar.
4. **Atividade:**
   - lista paginada das interações: data, conta, post, @, trecho do comentário e status da resposta pública e da DM (✓/✗/⏳/—) com o motivo em português;
   - filtros por conta e por status;
   - banner no topo quando houver conta com problema.

## 9. Tratamento de erros da Graph API

| Classe | Exemplos (código/subcódigo) | Ação |
|---|---|---|
| Token inválido | 190 | Conta → `reconnect_required`; jobs da conta ficam `pending` até reconectar (cancelados se passarem de 7 dias) |
| Limite de chamadas | 4, 17, 32, 613, 80002 | Reagendar conforme `estimated_time_to_regain_access` (ou backoff); não conta como tentativa falha |
| Mensagens desativadas | 200 ("disabled access to Instagram Direct Messaging…") | Conta → `messaging_disabled`; job `failed`; respostas públicas continuam |
| Abuso ou bloqueio | 368 ou mensagens de "blocked"/"spam" | **Disjuntor:** conta → `paused_by_safety` por 24h; todos os jobs da conta adiados; alerta no painel |
| Permanente | 100 (objeto inexistente/apagado), comentário oculto, janela de 7 dias expirada, *private reply* já enviada, 10 (permissão) | Job `failed` com motivo; sem retry |
| Transitório | HTTP 5xx, timeout, erro de rede | Retry com backoff 1min → 5min → 15min → 1h → 3h (máx. 5); depois `failed` |

A tabela de códigos fica em um único módulo (`instagram-client/errors.ts`), coberto por testes. Códigos desconhecidos são tratados como transitórios até 2 tentativas e depois como permanentes, sempre registrados no log.

## 10. Proteções anti-spam e anti-bloqueio

1. Toda ação é **resposta a uma ação do usuário** (comentário em post próprio). Não há DMs frias, follow-ups nem interação com posts de terceiros.
2. Atrasos aleatórios, serialização por conta, intervalo mínimo de 8s e teto de 200 ações por hora por conta.
3. Mínimo de 3 variações, sem repetir a mesma em sequência, e `{usuario}` torna cada resposta única.
4. No máximo 1 resposta pública + 1 DM por pessoa por post.
5. Disjuntor automático de 24h ao primeiro sinal de bloqueio (seção 9).
6. Respeito estrito a: 1 *private reply* por comentário, janela de 7 dias, não responder comentário oculto e ignorar comentários da própria conta.
7. Sugestão de identificar a DM como automática.
8. Só as permissões estritamente necessárias e **allowlist** de contas.

## 11. Segurança

- **Webhook:** HMAC-SHA256 sobre o corpo bruto, com `crypto.timingSafeEqual`; sem assinatura válida → 403 e evento descartado.
- **Painel:**
  - argon2id para senhas e rate-limit no login (5 tentativas a cada 15 min por IP);
  - cookie `HttpOnly`, `Secure` e `SameSite=Lax`, com sessão de 30 dias;
  - token CSRF em formulários e em requisições htmx;
  - `@fastify/helmet` com CSP restritiva (só recursos próprios), HSTS e `trustProxy` configurado para o Nginx.
- **OAuth:**
  - `state` aleatório de uso único e `redirect_uri` exata;
  - troca de tokens **apenas no servidor**;
  - o segredo nunca chega ao navegador.
- **Segredos:** em `.env` (`chmod 600`, fora do git). Tokens criptografados no banco com AES-256-GCM (chave em `ENCRYPTION_KEY`).
- **Logs:** pino com `redact` para `access_token`, `client_secret`, cabeçalhos de assinatura e cookies.
- **Container:** usuário não-root e sistema de arquivos somente leitura, exceto `/app/data`.

## 12. Privacidade e conformidade

Rotas públicas exigidas pelo App Review e pelas configurações do Business Login:

- **`/privacidade`:** política de privacidade em português e inglês. Cobre quais dados são tratados (ID e @ de quem comenta, texto do comentário), a finalidade, a retenção de 90 dias e como pedir exclusão. A página precisa ser acessível publicamente e rastreável pela Meta.
- **`/meta/deauthorize`:** recebe um `signed_request`, valida com HMAC usando o App Secret, apaga o token e desconecta a conta.
- **`/meta/data-deletion`:** valida o `signed_request`, apaga os dados ligados ao usuário e responde `{ url, confirmation_code }`.
- **`/meta/data-deletion/status?code=…`:** página de status da exclusão.

Retenção: `webhook_events` por 30 dias e `interactions`/`jobs` por 90 dias, com limpeza diária.

## 13. Deploy

- **`Dockerfile`:**
  - multi-stage: build com toolchain para better-sqlite3 e Tailwind; runtime Node 24 LTS slim;
  - usuário `node`;
  - `HEALTHCHECK` em `GET /healthz`, que verifica o banco e a idade do último ciclo do worker.
- **`docker-compose.yml`:** serviço `ig-autoreply`, `ports: ["127.0.0.1:3010:3000"]`, `volumes: ["./data:/app/data"]`, `env_file: .env`, `restart: unless-stopped`.
- **DNS:** registro `A` (e `AAAA`, se houver) `dm.adriancampana.cloud` → IP da VPS.
- **Nginx (host):**
  - `server_name dm.adriancampana.cloud`;
  - `proxy_pass http://127.0.0.1:3010`;
  - cabeçalhos `X-Forwarded-*`, `client_max_body_size 1m` e sem buffering que altere o corpo do webhook.
  - HTTPS: `certbot --nginx -d dm.adriancampana.cloud`, com renovação automática pelo timer do Certbot.
- **Backup:** cron no host, diário, com `sqlite3 data/app.db ".backup data/backups/app-$(date +%F).db"`; mantém 14 dias. Recomenda-se uma cópia fora da VPS.
- **Atualização:** `git pull && docker compose up -d --build`. As migrações rodam na inicialização.

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `APP_BASE_URL` | `https://dm.adriancampana.cloud` |
| `IG_APP_ID` / `IG_APP_SECRET` | Instagram app ID e secret (*API setup with Instagram login › Business login settings*) |
| `META_APP_SECRET` | App Secret do app Meta (*App settings › Basic*) |
| `META_WEBHOOK_SECRETS` | Lista de segredos aceitos na assinatura do webhook (ver seção 15) |
| `WEBHOOK_VERIFY_TOKEN` | String aleatória cadastrada no painel de Webhooks |
| `GRAPH_API_VERSION` | `v26.0` |
| `ENCRYPTION_KEY` | 32 bytes em base64 (tokens) |
| `SESSION_SECRET` | 32+ bytes (sessão) |
| `IG_ALLOWED_USERNAMES` | Allowlist, separada por vírgula |
| `REVIEW_MODE` | `true` só durante o App Review (desliga a allowlist) |
| `MAX_ACTIONS_PER_HOUR` | Padrão 200 |

## 14. Estratégia de testes

TDD com Vitest em todos os módulos de lógica.

- **Unitários:**
  - normalização e casamento de palavras-chave (acentos, maiúsculas, palavra inteira, emojis);
  - sorteio de variações sem repetição;
  - substituição de `{usuario}`;
  - validação de assinatura (válida, inválida, ausente);
  - parse dos **dois formatos** de payload;
  - regras do matcher (cada uma das 7 condições);
  - classificação de erros;
  - cálculo de backoff, ritmo e teto por hora;
  - disjuntor;
  - criptografia ida e volta;
  - validação de `signed_request`.
- **Integração** (Fastify `inject` + SQLite em memória + `undici` MockAgent):
  - webhook ponta a ponta até os jobs;
  - worker executando os jobs contra a Graph API simulada (sucesso, 190, 200, 368, 5xx);
  - callback do OAuth;
  - reconciler com paginação;
  - deduplicação com reentrega do mesmo payload.
- **Manual com contas reais** (checklist na fase de testes e no go-live):
  1. comentar com palavra-chave a partir de outra conta → resposta pública + DM;
  2. comentar de novo com a mesma conta → `skipped`;
  3. comentar sem palavra-chave → nada;
  4. post sem automação → nada;
  5. comentário da própria conta → nada;
  6. desativar "Permitir acesso a mensagens" → status correto;
  7. revogar o app no Instagram → "Precisa reconectar";
  8. botão "Test" do painel da Meta → evento aceito.

## 15. Riscos e pontos a validar na implementação

| Risco/dúvida | Mitigação |
|---|---|
| A doc diz apenas "App Secret" para assinar webhooks; no Instagram Login existem o App Secret (Meta) e o Instagram App Secret | `META_WEBHOOK_SECRETS` aceita ambos; confirmar com o botão **Test** do painel e com um comentário real; depois deixar só o correto |
| Formato do payload `comments` varia entre páginas da doc | Parser tolerante aos dois formatos, com testes; payload bruto guardado 30 dias |
| Antes do App Review (Standard Access, modo Desenvolvimento), webhooks de comentário podem não chegar e respostas podem ficar visíveis só para usuários com função | Desenvolver e testar com as **próprias contas testers**, comentando de outra conta também tester; o reconciler cobre a ausência de webhook; a validação final ocorre após a aprovação |
| Verificação de Negócio ou App Review reprovados ou demorados | Iniciar a verificação **imediatamente** (etapa 0); seguir o guia de submissão (vídeo claro, instruções detalhadas, só as permissões usadas); verificar o domínio via DNS |
| Mudanças de versão da API (ciclo de ~2 anos por versão) | `GRAPH_API_VERSION` em env; revisão semestral do changelog |
| Instagram Login marcado pela Meta como setup para "integrações existentes"; recursos novos só no Unified Login | `instagram-client` isola host, versão e token; migração documentada pela Meta, se um dia for necessária |
| Webhooks com entrega irregular | Reconciler a cada 10 min |
| Token revogado (troca de senha, etc.) | Status "Precisa reconectar" e banner no painel |

## 16. Roteiro de entrega (alto nível)

| Etapa | Responsável | Entregável |
|---|---|---|
| **0 — Burocracia Meta (iniciar já, em paralelo)** | vocês | Portfólio empresarial com CNPJ e **Verificação de Negócio** iniciada; verificação do domínio `adriancampana.cloud`; conta de desenvolvedor; app **Business** (caso de uso "Other") conectado ao portfólio; produto Instagram › *API setup with Instagram login*; contas adicionadas como testers; "Permitir acesso a mensagens" ativado em cada conta |
| 1 — Fundação + deploy | dev | Projeto, config, banco, login do painel, páginas públicas, Docker, Nginx, HTTPS no ar |
| 2 — Contas | dev | Business Login, tokens (troca e refresh), `subscribed_apps`, allowlist, tela Contas |
| 3 — Motor | dev | Webhook, matcher, fila, worker, erros, disjuntor, reconciler |
| 4 — Painel completo | dev (skill **impeccable**) | Automações, Atividade, estados vazios e de erro, polimento mobile |
| 5 — App Review | vocês + dev | Ícone 1024px, URL de privacidade, categoria, e-mail; instruções e credenciais para o revisor (`REVIEW_MODE`); vídeo por permissão (UI em inglês ou legendas); ≥ 1 chamada bem-sucedida por permissão |
| 6 — Go-live | vocês + dev | App em **Live**; webhooks só com `comments`; `REVIEW_MODE=false`; checklist manual; monitorar a 1ª semana; guia de 1 página para a usuária |

O plano de implementação detalhado (tarefas, arquivos e testes) será escrito em `docs/superpowers/plans/` após a aprovação desta spec.

## 17. Fontes oficiais consultadas (27/10/2026)

- Instagram Platform Overview — https://developers.facebook.com/documentation/instagram-platform/overview
- Comment Moderation — https://developers.facebook.com/documentation/instagram-platform/comment-moderation
- Private Replies — https://developers.facebook.com/documentation/instagram-platform/private-replies
- IG Comment Replies (ref.) — https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies
- IG Media Comments (ref.) — https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments
- Send Messages (Instagram Login) — https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
- Business Login for Instagram — https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
- Refresh Access Token — https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token
- Webhooks — https://developers.facebook.com/documentation/instagram-platform/webhooks
- Webhooks › Setup — https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
- Webhooks › Fields — https://developers.facebook.com/documentation/instagram-platform/webhooks/fields
- Webhooks › Examples — https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
- Self Messaging — https://developers.facebook.com/documentation/instagram-platform/self-messaging
- App Review for Instagram API — https://developers.facebook.com/documentation/instagram-platform/app-review
- Create a Meta app for the Instagram API — https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app
- Instagram API with Unified Login — https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login
- Business Verification — https://developers.facebook.com/documentation/development/release/business-verification
- App Modes — https://developers.facebook.com/documentation/development/build-and-test/app-modes
- Instagram Platform Changelog — https://developers.facebook.com/documentation/instagram-platform/changelog
- Graph API v26.0 — https://developers.facebook.com/docs/graph-api/changelog/version26.0
- Políticas: Developer Policies (https://developers.facebook.com/devpolicy), Meta Platform Terms (https://developers.facebook.com/terms/), Automated chats on Instagram (https://help.instagram.com/655277382759165), Community Standards (https://transparency.meta.com/policies/community-standards/)
