#!/bin/bash
# Laintown database backup — daily SQLite backups with 7-day rotation
#
# Backs up all character databases to /opt/local-lain/backups/
# Uses SQLite's .backup command for safe hot-backup.
# Keeps 7 days of backups, auto-deletes older ones.
#
# Run via systemd timer (lain-backup.timer) or manually.

set -euo pipefail

BACKUP_DIR="/opt/local-lain/backups"
DATE=$(date '+%Y-%m-%d')
RETENTION_DAYS=7

# All character databases
DBS=(
  "wired-lain:/root/.lain-wired/lain.db"
  "lain:/root/.lain/lain.db"
  "dr-claude:/root/.lain-dr-claude/lain.db"
  "pkd:/root/.lain-pkd/lain.db"
  "mckenna:/root/.lain-mckenna/lain.db"
  "john:/root/.lain-john/lain.db"
  "hiru:/root/.lain-hiru/lain.db"
)

mkdir -p "$BACKUP_DIR"

echo "[$(date '+%H:%M:%S')] Starting Laintown database backup"

BACKED_UP=0
FAILED=0

for entry in "${DBS[@]}"; do
  IFS=':' read -r NAME DB_PATH <<< "$entry"
  DEST="${BACKUP_DIR}/${NAME}-${DATE}.db"

  if [ ! -f "$DB_PATH" ]; then
    echo "  SKIP $NAME — database not found at $DB_PATH"
    continue
  fi

  # Use SQLite .backup for safe hot-backup
  if sqlite3 "$DB_PATH" ".backup '$DEST'" 2>/dev/null; then
    # Compress the backup
    gzip -f "$DEST" 2>/dev/null && DEST="${DEST}.gz"
    SIZE=$(du -h "$DEST" 2>/dev/null | cut -f1)
    echo "  OK   $NAME → $DEST ($SIZE)"
    BACKED_UP=$((BACKED_UP + 1))
  else
    # Fallback: plain file copy
    if cp "$DB_PATH" "$DEST" 2>/dev/null; then
      gzip -f "$DEST" 2>/dev/null && DEST="${DEST}.gz"
      SIZE=$(du -h "$DEST" 2>/dev/null | cut -f1)
      echo "  OK   $NAME → $DEST (copy fallback, $SIZE)"
      BACKED_UP=$((BACKED_UP + 1))
    else
      echo "  FAIL $NAME — could not backup"
      FAILED=$((FAILED + 1))
    fi
  fi
done

# Prune old backups
PRUNED=0
find "$BACKUP_DIR" -name "*.db.gz" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null && \
  PRUNED=$(find "$BACKUP_DIR" -name "*.db.gz" -mtime +"$RETENTION_DAYS" 2>/dev/null | wc -l) || true
# Also clean uncompressed leftovers
find "$BACKUP_DIR" -name "*.db" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

echo "[$(date '+%H:%M:%S')] Backup complete: $BACKED_UP OK, $FAILED failed, pruned old backups"

# Report disk usage of backup dir
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
echo "  Backup directory: $BACKUP_DIR ($TOTAL_SIZE total)"

[ "$FAILED" -eq 0 ] && exit 0 || exit 1
