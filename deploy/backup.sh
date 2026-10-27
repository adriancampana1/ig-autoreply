#!/usr/bin/env bash
# Backup diário do SQLite (cópia consistente com o app rodando). Mantém 14 dias.
# crontab -e  →  15 3 * * * /opt/ig-autoreply/deploy/backup.sh >> /var/log/ig-autoreply-backup.log 2>&1
set -euo pipefail
umask 077 # o banco contém hashes de senha e tokens cifrados: só o dono lê
APP_DIR="${APP_DIR:-/opt/ig-autoreply}"
DEST="$APP_DIR/data/backups"
mkdir -p "$DEST"
sqlite3 "$APP_DIR/data/app.db" ".backup '$DEST/app-$(date +%F).db'"
find "$DEST" -name 'app-*.db' -mtime +14 -delete
echo "$(date -Is) backup ok"
