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

## 6. Backup diário

```bash
chmod +x deploy/backup.sh
sudo crontab -e
# adicione:
15 3 * * * APP_DIR=/opt/ig-autoreply /opt/ig-autoreply/deploy/backup.sh >> /var/log/ig-autoreply-backup.log 2>&1
```

O script usa o `.backup` do SQLite (cópia consistente com o app rodando e o banco em modo WAL), grava em
`data/backups/app-AAAA-MM-DD.db` com permissão `600`, mantém 14 dias e só imprime a data e "backup ok" (nenhum
segredo vai para o log). Teste uma vez à mão: `sudo APP_DIR=/opt/ig-autoreply deploy/backup.sh`.

Recomendado: sincronizar `data/backups/` para fora da VPS (ex.: `rclone` para um storage). Lembre que o backup só é útil
junto com o `ENCRYPTION_KEY` (seção 2).

Para restaurar:

```bash
docker compose down
rm -f data/app.db-wal data/app.db-shm
cp data/backups/app-AAAA-MM-DD.db data/app.db && sudo chown 1000:1000 data/app.db
docker compose up -d
```

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
