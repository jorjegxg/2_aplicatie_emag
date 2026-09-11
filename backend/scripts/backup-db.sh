#!/usr/bin/env bash
# Backup orar Postgres (container emag-db) via pg_dump.
# Retenție: păstrează ultimele KEEP dump-uri (default 48 = ~2 zile la 1h).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env"
  set +a
fi

CONTAINER="${BACKUP_DB_CONTAINER:-emag-db}"
PGUSER="${POSTGRES_USER:-emag}"
PGDB="${POSTGRES_DB:-emag}"
KEEP="${BACKUP_KEEP:-48}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups/postgres}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/emag_${STAMP}.sql.gz"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  log "ERROR: container $CONTAINER nu rulează"
  exit 1
fi

TMP="$(mktemp "$BACKUP_DIR/.tmp.XXXXXX.sql.gz")"
trap 'rm -f "$TMP"' EXIT

if ! docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-emag}" "$CONTAINER" \
  pg_dump -U "$PGUSER" -d "$PGDB" --no-owner --no-acl -F p \
  | gzip -c >"$TMP"; then
  log "ERROR: pg_dump a eșuat"
  exit 1
fi

if [[ ! -s "$TMP" ]]; then
  log "ERROR: dump gol"
  exit 1
fi

mv -f "$TMP" "$OUT"
trap - EXIT

SIZE="$(du -h "$OUT" | awk '{print $1}')"
log "OK $OUT ($SIZE)"

# Șterge dump-urile vechi, păstrează ultimele KEEP
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/emag_*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" || true)
if ((${#OLD[@]} > 0)); then
  rm -f "${OLD[@]}"
  log "removed ${#OLD[@]} old backup(s); keep=$KEEP"
fi
