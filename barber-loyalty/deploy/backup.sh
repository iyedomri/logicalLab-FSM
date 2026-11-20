#!/bin/bash
# Sauvegarde quotidienne de la base (fidèles + tampons) — à mettre en cron :
#   0 3 * * * /opt/barber-loyalty/deploy/backup.sh >> /var/log/barbier-backup.log 2>&1
set -euo pipefail
DEST=/var/backups/barbier
mkdir -p "$DEST"
cp /opt/barber-loyalty/data/db.json "$DEST/db-$(date +%F-%H%M).json"
# conserver 30 jours d’historique
ls -1t "$DEST"/db-*.json | tail -n +31 | xargs -r rm --
echo "backup ok → $DEST/db-$(date +%F-%H%M).json"
