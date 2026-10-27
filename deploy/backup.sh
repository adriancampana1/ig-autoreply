#!/usr/bin/env bash
# Backup diário do SQLite (cópia consistente com o app rodando). Mantém 14 dias.
# crontab -e  →  15 3 * * * /opt/ig-autoreply/deploy/backup.sh >> /var/log/ig-autoreply-backup.log 2>&1
set -euo pipefail
umask 077 # o banco contém hashes de senha e tokens cifrados: só o dono lê
APP_DIR="${APP_DIR:-/opt/ig-autoreply}"
DB="$APP_DIR/data/app.db"
DEST="$APP_DIR/data/backups"
if [ ! -f "$DB" ]; then
  echo "$(date -Is) backup FALHOU: $DB não existe" >&2
  exit 1
fi
mkdir -p "$DEST"
TMP="$(mktemp "$DEST/.app-tmp-XXXXXX")"
trap 'rm -f "$TMP"' EXIT
rm -f "$TMP" # o .backup exige destino novo; mktemp só reservou um nome único
sqlite3 -cmd '.timeout 5000' "$DB" ".backup '$TMP'"
if [ "$(sqlite3 "$TMP" 'pragma integrity_check;')" != "ok" ]; then
  echo "$(date -Is) backup FALHOU: integrity_check reprovou a cópia" >&2
  exit 1
fi
mv "$TMP" "$DEST/app-$(date +%F).db"
find "$DEST" -name 'app-*.db' -mtime +14 -delete
echo "$(date -Is) backup ok"
