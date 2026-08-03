#!/bin/bash
# scripts/backup-db.sh
#
# Purpose: nightly pg_dump of the OwnMind database, run BY CRON ON THE SERVER
#          (unlike scripts/health-report-daily.sh, which runs locally and SSHes in).
#
# Usage:
#   bash scripts/backup-db.sh                    # dump into ./backups/
#   BACKUP_DIR=/mnt/x bash scripts/backup-db.sh  # dump elsewhere
#   RETENTION_DAYS=30 bash scripts/backup-db.sh  # keep longer
#
# Why this exists
# ---------------
# Found 2026-08-03: production had no backups of any kind — no cron dump, no
# backups directory, one docker volume and nothing else. It surfaced the hard
# way. A test interaction against the live console changed one bug_reports row,
# and because there was no dump to read the previous values out of, two columns
# (resolved_at, status_reason) were lost permanently. Only `status` could be
# restored, and only because a screenshot happened to exist.
#
# Design notes, each one guarding a way a backup script can lie about its work:
#
#   - Atomic promote. Dump to `.tmp` and `mv` into place only after the file
#     passes its checks. A truncated dump left behind by a crash or a full disk
#     is worse than no dump: it looks like a backup until the day you need it.
#   - The checks are gzip integrity AND a grep for a real schema marker. A
#     pg_dump that connects to an empty or wrong database produces a small,
#     perfectly valid .gz — file existence proves nothing.
#   - `set -euo pipefail` so a pg_dump failure mid-pipe fails the run instead of
#     writing whatever reached gzip before the error.
#   - `umask 077`. These dumps contain every user's api_key in plaintext.
#   - Retention deletes only files matching this script's own name pattern, so
#     pointing BACKUP_DIR at a populated directory cannot wipe unrelated files.

set -euo pipefail
umask 077

REPO_DIR="${REPO_DIR:-/VinService/ownmind}"
BACKUP_DIR="${BACKUP_DIR:-${REPO_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_USER="${DB_USER:-ownmind}"
DB_NAME="${DB_NAME:-ownmind}"

# A dump smaller than this is assumed to be a failure, not a small database.
# The real database compresses to tens of MB; anything under 10 KB means the
# dump produced a schema stub or nothing at all.
MIN_BYTES="${MIN_BYTES:-10240}"

STAMP=$(date +%F_%H%M%S)
TARGET="${BACKUP_DIR}/ownmind-${STAMP}.sql.gz"
TMP="${TARGET}.tmp"

log() { echo "[backup-db] $(date '+%F %T') $*"; }
fail() { log "FAILED: $*"; exit 1; }

cleanup() { [ -f "$TMP" ] && rm -f "$TMP"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
cd "$REPO_DIR"

log "dumping ${DB_NAME} -> ${TARGET}"
docker compose exec -T db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$TMP" \
  || fail "pg_dump pipeline returned non-zero"

# Check 1: the gzip stream is complete and undamaged.
gzip -t "$TMP" || fail "gzip integrity check failed — dump is truncated"

# Check 2: the dump is big enough to be real.
SIZE=$(wc -c < "$TMP")
[ "$SIZE" -ge "$MIN_BYTES" ] || fail "dump is only ${SIZE} bytes (min ${MIN_BYTES}) — likely empty"

# Check 3: it actually contains schema. Guards the case where pg_dump succeeds
# against the wrong or an empty database.
gunzip -c "$TMP" | grep -q "CREATE TABLE" || fail "no CREATE TABLE in dump — wrong or empty database"

mv "$TMP" "$TARGET"
log "ok: $(du -h "$TARGET" | cut -f1) $(basename "$TARGET")"

# Retention. Name pattern is this script's own, so an unrelated file sharing the
# directory is never a candidate for deletion.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name 'ownmind-*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
log "retention: kept ${RETENTION_DAYS}d, removed ${DELETED} old dump(s)"

KEPT=$(find "$BACKUP_DIR" -maxdepth 1 -name 'ownmind-*.sql.gz' | wc -l)
log "done: ${KEPT} dump(s) on disk, $(df -h "$BACKUP_DIR" | awk 'NR==2{print $4}') free"
