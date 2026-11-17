#!/bin/bash
# Backup ig-autoreply: SQLite + config, cifrados com age (só a chave PÚBLICA fica na VPS), enviados ao B2.
# Mesmo esquema do backup-lumeri: usa /etc/backup (age.pub, rclone.conf, bucket) e guarda 3 dias em /var/backups.
# Na VPS: /usr/local/sbin/backup-ig-autoreply (root 700), disparado por deploy/systemd/backup-ig-autoreply.timer.
set -Eeuo pipefail
umask 077 # o banco contém hashes de senha e tokens cifrados: só o dono lê
CONF=/etc/backup
APP=/opt/services/ig-autoreply
DIR=/var/backups/ig-autoreply
BUCKET=$(cat "$CONF/bucket")
HC=$(cat "$CONF/hc-url-ig-autoreply" 2>/dev/null || true)
R=$(cat "$CONF/age.pub")
hc() { if [[ -n "$HC" ]]; then curl -fsS -m 10 --retry 3 -o /dev/null "$HC$1" || true; fi; }
trap 'hc /fail' ERR
hc /start
TS=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
[[ -s "$APP/data/app.db" ]] || { echo "ERRO: $APP/data/app.db não existe"; false; }
# .backup = cópia consistente com o app rodando (WAL). Roda como uid 1000 (o "node" do container): se o sqlite3
# precisar criar app.db-wal/-shm, eles não ficam com dono root e o app continua conseguindo gravar.
chown 1000:1000 "$TMP"
setpriv --reuid=1000 --regid=1000 --clear-groups \
  sqlite3 -cmd '.timeout 5000' "$APP/data/app.db" ".backup '$TMP/app.db'"
[[ $(sqlite3 "$TMP/app.db" 'pragma integrity_check;') == ok ]] || { echo "ERRO: integrity_check reprovou a cópia"; false; }
DB="$DIR/ig-autoreply-db-$TS.db.age"
CFG="$DIR/ig-autoreply-config-$TS.tar.gz.age"
age -r "$R" -o "$DB" "$TMP/app.db"
tar -C / -cz --exclude=opt/services/ig-autoreply/data opt/services/ig-autoreply etc/nginx/conf.d/ig-autoreply.conf \
  | age -r "$R" -o "$CFG"
for f in "$DB" "$CFG"; do
  rclone --config "$CONF/rclone.conf" copyto --no-check-dest --retries 5 \
    "$f" "offsite:$BUCKET/ig-autoreply/$(date -u +%Y/%m)/$(basename "$f")"
done
find "$DIR" -type f -name 'ig-autoreply-*' -mtime +3 -delete
hc ""
echo "ok $TS db=$(stat -c %s "$DB")B cfg=$(stat -c %s "$CFG")B"
