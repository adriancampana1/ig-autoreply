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

O `.env` precisa ter todas as variáveis obrigatórias preenchidas: `IG_APP_ID`, `IG_APP_SECRET`, `META_APP_SECRET`,
`WEBHOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY`, `SESSION_SECRET` e `IG_ALLOWED_USERNAMES` (além de `APP_BASE_URL` e
`CONTACT_EMAIL`, já preenchidas no exemplo). Cada uma tem um comentário em `.env.example` dizendo onde obter o valor. Se
faltar algo, o app recusa subir e o motivo aparece em `docker compose logs` (exceção: `IG_ALLOWED_USERNAMES`, abaixo).

`IG_ALLOWED_USERNAMES` é a lista, separada por vírgula e sem `@`, dos nomes de usuário do Instagram que
podem ser conectados no painel (ex.: `IG_ALLOWED_USERNAMES=loja.um,loja_dois`). Vazio, **ninguém** consegue conectar uma
conta (a menos que `REVIEW_MODE=true`, usado só durante o App Review); nesse caso o app sobe, mas registra um aviso no log.

> Guarde uma cópia do `ENCRYPTION_KEY` num gerenciador de senhas: sem ele, os tokens salvos não podem ser lidos
> (seria preciso reconectar as contas).

## 3. Subir o container

```bash
docker compose up -d --build
docker compose ps            # STATUS deve ficar "healthy" em ~30 s
curl -s http://127.0.0.1:3010/healthz   # {"status":"ok"}
```

Se o container não ficar `healthy` (ou ficar reiniciando), veja o motivo com `docker compose logs --tail 50 ig-autoreply`
(normalmente uma variável do `.env` ausente ou inválida, ou `./data` sem permissão para o uid 1000).

O container segue o mínimo necessário: roda como usuário `node` (não root), com sistema de arquivos raiz somente leitura
(`read_only: true`; só `./data` e `/tmp` são graváveis), `no-new-privileges` e a porta publicada apenas em
`127.0.0.1:3010` — só o Nginx do host alcança o app. A imagem inclui `public/` (CSS, JS, htmx e a fonte Geist
hospedada em `public/assets/fonts/`, com a licença `OFL.txt`); nada é carregado de CDN.

## 4. Nginx + HTTPS

```bash
sudo cp deploy/nginx/dm.adriancampana.cloud.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/dm.adriancampana.cloud.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dm.adriancampana.cloud --redirect
curl -sI https://dm.adriancampana.cloud/privacidade | head -1   # HTTP/2 200
```

O login do painel só funciona depois do Certbot: em produção o cookie de sessão é `Secure` e o navegador não o envia por
HTTP puro. Acesse sempre por `https://`.

O bloco de proxy define `X-Forwarded-For` como `$remote_addr` (e **não** `$proxy_add_x_forwarded_for`). O app confia
em exatamente um salto de proxy (`trustProxy` em `src/app.ts`) e usa a entrada mais à direita do `X-Forwarded-For`
como IP do cliente (limite de tentativas de login, logs). Ao sobrescrever o cabeçalho com o IP que o Nginx de fato
viu, um cliente não consegue forjar o próprio IP mandando um `X-Forwarded-For`. Se algum dia colocar outro proxy/CDN
na frente do Nginx, revise essa configuração. Os assets (inclusive a fonte em `/assets/fonts/`) passam pelo mesmo
`location /`; não há regra que os bloqueie.

## 5. Usuários do painel

```bash
docker compose exec ig-autoreply node dist/cli/users.js create esposa@exemplo.com
docker compose exec ig-autoreply node dist/cli/users.js create voce@exemplo.com
# esqueceu a senha?
docker compose exec ig-autoreply node dist/cli/users.js reset-password esposa@exemplo.com
```

A senha é gerada e exibida **uma única vez**.

## 6. Configurar o app na Meta

Faça isto depois do HTTPS (seção 4): a Meta só aceita URLs `https://` que respondam. No App Dashboard do app:

1. **Business login settings** (*Instagram › API setup with Instagram login › Set up Instagram business login › Business login settings*):
   - OAuth redirect URI: `https://dm.adriancampana.cloud/auth/instagram/callback` (confira se o painel não acrescentou
     `/` no fim — precisa ser idêntico ao do código).
   - Deauthorize callback URL: `https://dm.adriancampana.cloud/meta/deauthorize`
   - Data deletion request URL: `https://dm.adriancampana.cloud/meta/data-deletion`
   - Copie **Instagram app ID** e **Instagram app secret** para `IG_APP_ID`/`IG_APP_SECRET` no `.env`; *App settings ›
     Basic › App secret* para `META_APP_SECRET`; em *Privacy Policy URL* use `https://dm.adriancampana.cloud/privacidade`.
     Depois de editar o `.env`, rode `docker compose up -d --force-recreate` (o `restart` não relê o `.env`).
2. **Webhooks** (*Configure webhooks*): Callback URL `https://dm.adriancampana.cloud/webhooks/instagram` e Verify token =
   o valor de `WEBHOOK_VERIFY_TOKEN` › *Verify and save*. **Desassine todos os campos exceto `comments`** (o painel
   assina vários por padrão; o app só usa `comments`).
3. **Descobrir qual segredo assina os webhooks**: com `META_WEBHOOK_SECRETS` vazio o app aceita os dois segredos
   (`META_APP_SECRET` e `IG_APP_SECRET`); deixe só o correto. Defina `META_WEBHOOK_SECRETS=<valor do META_APP_SECRET>`,
   rode `docker compose up -d --force-recreate`, clique **Test** no campo `comments` e veja:

   ```bash
   docker compose logs --since 5m ig-autoreply | grep -E "assinatura inválida|webhooks/instagram"
   ```

   Se aparecer "webhook com assinatura inválida descartado", troque para o valor do `IG_APP_SECRET` e repita. Fica
   valendo o segredo com o qual o teste passa sem esse aviso (resposta `200`).

Depois disso, conecte as contas no painel (*Contas › Conectar conta do Instagram*, uma de cada vez) — só as que estão em
`IG_ALLOWED_USERNAMES` (seção 2).

## 7. Backup diário

```bash
chmod +x deploy/backup.sh
sudo crontab -e
# adicione:
15 3 * * * APP_DIR=/opt/ig-autoreply /opt/ig-autoreply/deploy/backup.sh >> /var/log/ig-autoreply-backup.log 2>&1
```

O script usa o `.backup` do SQLite (cópia consistente com o app rodando e o banco em modo WAL), grava em
`data/backups/app-AAAA-MM-DD.db` com permissão `600`, mantém 14 dias e só imprime a data e "backup ok" (nenhum
segredo vai para o log). Ele grava primeiro num arquivo temporário, confere com `pragma integrity_check` e só então
renomeia para o nome com data; se `data/app.db` não existir ou a cópia estiver corrompida, sai com código 1 e uma mensagem
em stderr. Teste uma vez à mão: `sudo APP_DIR=/opt/ig-autoreply deploy/backup.sh`.

Recomendado: sincronizar `data/backups/` para fora da VPS (ex.: `rclone` para um storage). Lembre que o backup só é útil
junto com o `ENCRYPTION_KEY` (seção 2).

Para restaurar:

Os backups pertencem ao root (modo 600) e `data/` ao uid 1000, então a restauração usa `sudo`. Troque `AAAA-MM-DD` pela data:

```bash
cd /opt/ig-autoreply
docker compose down
sudo sh -c 'rm -f data/app.db-wal data/app.db-shm && cp data/backups/app-AAAA-MM-DD.db data/app.db && chown 1000:1000 data/app.db && chmod 600 data/app.db'
docker compose up -d
```

## 8. Atualizar

```bash
cd /opt/ig-autoreply && git pull && docker compose up -d --build
docker image prune -f   # remove as imagens antigas que sobram a cada build
```

As migrações do banco rodam automaticamente na inicialização.

## 9. Logs e diagnóstico

```bash
docker compose logs -f --since 1h ig-autoreply
docker compose exec ig-autoreply node -e "const D=require('better-sqlite3');const d=new D('/app/data/app.db',{readonly:true});console.log(d.prepare(\"select status,count(*) n from jobs group by status\").all())"
```
