#!/bin/bash
# scripts/migrate-to-fapa.sh
#
# One-off data migration: move every user's memories from the kkvin box to the
# FAPA host. Runs FROM A LAPTOP and SSHes out; it is not installed on either
# server.
#
# Usage:
#   bash scripts/migrate-to-fapa.sh check      # both sides reachable, row counts, disk. Changes nothing.
#   bash scripts/migrate-to-fapa.sh cutover    # the real move. Source API stops, so this is the outage.
#   bash scripts/migrate-to-fapa.sh rollback   # bring the source API back up. Nothing else is undone.
#
# Targets are overridable so the same script rehearses against the staging host:
#   DST_HOST=root@test-fapa.welcometw.com bash scripts/migrate-to-fapa.sh cutover
#
# Design notes, each one guarding a way a migration can quietly lose data:
#
#   - One SSH session per host per phase. Every remote step is written to a file
#     and piped in through `bash -s`, never assembled as a command argument
#     (long argument strings get truncated on some clients, silently).
#   - The source API is STOPPED, not asked nicely to stop writing. There is no
#     read-only mode in the product, and a dump taken while writes land is a
#     dump missing rows nobody will notice for weeks.
#   - The dump is verified three ways before anything on the destination is
#     touched: gzip integrity, a size floor, and a grep for real schema. A
#     pg_dump against an empty or wrong database produces a perfectly valid tiny
#     file — existence proves nothing.
#   - The destination schema is dropped and recreated before the restore. A
#     fresh deploy has already run the migrations, so restoring on top of it
#     collides on every table; a half-applied restore is worse than none.
#   - Row counts are compared per table after the restore, and a mismatch is a
#     hard failure. This is the only step that proves the move worked.
#   - The source is left stopped but intact. Rollback is `rollback`, and it
#     costs seconds, because nothing on kkvin was deleted.

set -euo pipefail
umask 077

SRC_HOST="${SRC_HOST:-root@kkvin.com}"
SRC_DIR="${SRC_DIR:-/VinService/ownmind}"
DST_HOST="${DST_HOST:-root@fapa.welcometw.com}"
DST_DIR="${DST_DIR:-/opt/deploy/ownmind}"
DB_USER="${DB_USER:-ownmind}"
DB_NAME="${DB_NAME:-ownmind}"

# Deliberately outside the repo. These dumps contain every user's api_key in
# plaintext, and a working directory inside the checkout is one `git add -A`
# away from being committed.
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/ownmind-migrate}"
MIN_BYTES="${MIN_BYTES:-10240}"

# Tables whose row counts must match exactly on both sides. Not every table —
# these are the ones holding user data, where a silent shortfall is the failure
# that matters.
VERIFY_TABLES="users memories memory_history secrets session_logs handoffs"

log()  { echo "[migrate] $(date '+%F %T') $*"; }
fail() { echo "[migrate] FAILED: $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "$1 not found on this machine"; }

# ---------------------------------------------------------------- remote steps

# Row counts as `table<TAB>count`, one per line, sorted. Same shape from both
# hosts so the comparison is a plain diff.
counts_script() {
  cat <<EOF
set -euo pipefail
cd "\$DEPLOY_DIR"
for t in $VERIFY_TABLES; do
  n=\$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM \$t" 2>/dev/null || echo "ERR")
  echo "\$t	\$n"
done
EOF
}

remote_counts() {
  local host="$1" dir="$2"
  { echo "DEPLOY_DIR='$dir'"; counts_script; } | ssh "$host" 'bash -s'
}

# ---------------------------------------------------------------------- check

cmd_check() {
  log "source: $SRC_HOST:$SRC_DIR"
  { echo "DEPLOY_DIR='$SRC_DIR'"; cat <<'EOF'
set -euo pipefail
cd "$DEPLOY_DIR"
echo "--- version"
docker compose exec -T api node -p "require('/app/package.json').version" 2>/dev/null || echo "api not running"
echo "--- containers"
docker compose ps
echo "--- disk"
df -h . | awk 'NR==2{print $4" free"}'
EOF
  } | ssh "$SRC_HOST" 'bash -s'

  log "destination: $DST_HOST:$DST_DIR"
  { echo "DEPLOY_DIR='$DST_DIR'"; cat <<'EOF'
set -euo pipefail
cd "$DEPLOY_DIR"
echo "--- containers"
docker compose ps
echo "--- disk"
df -h . | awk 'NR==2{print $4" free"}'
EOF
  } | ssh "$DST_HOST" 'bash -s'

  log "row counts on source"
  remote_counts "$SRC_HOST" "$SRC_DIR"
  log "row counts on destination (expected to be zero or near-zero before the move)"
  remote_counts "$DST_HOST" "$DST_DIR" || true

  log "check done, nothing was changed"
}

# -------------------------------------------------------------------- cutover

cmd_cutover() {
  need_cmd ssh
  need_cmd scp
  mkdir -p "$WORK_DIR"

  local stamp dump
  stamp=$(date +%F_%H%M%S)
  dump="${WORK_DIR}/ownmind-${stamp}.sql.gz"

  # --- source: stop writes, dump, verify -----------------------------------
  log "stopping the source API and dumping (outage starts now)"
  { echo "DEPLOY_DIR='$SRC_DIR'"; echo "DB_USER='$DB_USER'"; echo "DB_NAME='$DB_NAME'";
    echo "MIN_BYTES='$MIN_BYTES'"; echo "STAMP='$stamp'"; cat <<'EOF'
set -euo pipefail
umask 077
cd "$DEPLOY_DIR"

# Stop only the API. The database stays up because the dump reads through it.
docker compose stop api
echo "[remote] api stopped"

OUT="/tmp/ownmind-${STAMP}.sql.gz"
docker compose exec -T db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$OUT"

gzip -t "$OUT" || { echo "[remote] gzip integrity failed" >&2; exit 1; }

SIZE=$(wc -c < "$OUT")
[ "$SIZE" -ge "$MIN_BYTES" ] || { echo "[remote] dump is only ${SIZE} bytes" >&2; exit 1; }

# grep -q closes the pipe early and gunzip dies of SIGPIPE, so pipefail is
# scoped off here and grep's own status is what gets tested.
set +o pipefail
gunzip -c "$OUT" | grep -q "CREATE TABLE" && OK=1 || OK=0
set -o pipefail
[ "$OK" -eq 1 ] || { echo "[remote] no CREATE TABLE in dump" >&2; exit 1; }

echo "[remote] dump ok: $(du -h "$OUT" | cut -f1) $OUT"
EOF
  } | ssh "$SRC_HOST" 'bash -s' || fail "source dump failed — the API may still be stopped, run: $0 rollback"

  # Counted only now, with the API already stopped. Counting before the freeze
  # would race any write that lands between the count and the shutdown, and the
  # comparison at the end would then fail on a migration that actually worked.
  log "recording source row counts (API is stopped, so these are stable)"
  local before="${WORK_DIR}/counts-source-${stamp}.txt"
  remote_counts "$SRC_HOST" "$SRC_DIR" > "$before"
  cat "$before"

  # --- transfer -------------------------------------------------------------
  log "downloading the dump"
  scp -q "${SRC_HOST}:/tmp/ownmind-${stamp}.sql.gz" "$dump" || fail "download failed"
  gzip -t "$dump" || fail "the downloaded dump is damaged"
  log "local copy: $(du -h "$dump" | cut -f1) $dump"

  log "uploading to the destination"
  scp -q "$dump" "${DST_HOST}:/tmp/ownmind-${stamp}.sql.gz" || fail "upload failed"

  # --- destination: drop schema, restore ------------------------------------
  log "restoring on the destination"
  { echo "DEPLOY_DIR='$DST_DIR'"; echo "DB_USER='$DB_USER'"; echo "DB_NAME='$DB_NAME'";
    echo "STAMP='$stamp'"; cat <<'EOF'
set -euo pipefail
cd "$DEPLOY_DIR"

IN="/tmp/ownmind-${STAMP}.sql.gz"
gzip -t "$IN" || { echo "[remote] uploaded dump is damaged" >&2; exit 1; }

# The API is stopped so nothing writes into a half-restored schema, and so the
# migration runner does not race the restore on the way back up.
docker compose stop api
echo "[remote] api stopped"

# A fresh deploy already ran the migrations, so the schema exists and every
# CREATE TABLE in the dump would collide. Start from bare.
docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
echo "[remote] schema reset"

gunzip -c "$IN" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q
echo "[remote] restore finished"

docker compose up -d api
echo "[remote] api started"
EOF
  } | ssh "$DST_HOST" 'bash -s' || fail "restore failed. The destination API is left stopped on purpose so nobody writes into a half-restored schema. Bring the source back with: $0 rollback"

  # --- verify ---------------------------------------------------------------
  log "waiting for the destination API to come up"
  sleep 8

  local after="${WORK_DIR}/counts-dest-${stamp}.txt"
  remote_counts "$DST_HOST" "$DST_DIR" > "$after"

  echo "--- source (before) / destination (after)"
  paste "$before" "$after"

  if diff -q "$before" "$after" >/dev/null; then
    log "row counts match on every checked table"
  else
    echo "--- differences"
    diff "$before" "$after" || true
    fail "row counts DO NOT match — do not switch the address over; run: $0 rollback"
  fi

  log "cutover done. Remaining steps are by hand:"
  log "  1. add the /ownmind/ block to the vhost file on $DST_HOST and reload"
  log "  2. point kkvin's /ownmind/ at the new host as a plain proxy"
  log "  3. log in with a real account on both addresses and search a memory"
  log "  local dump kept at: $dump"
}

# ------------------------------------------------------------------- rollback

cmd_rollback() {
  log "starting the source API again on $SRC_HOST"
  { echo "DEPLOY_DIR='$SRC_DIR'"; cat <<'EOF'
set -euo pipefail
cd "$DEPLOY_DIR"
docker compose up -d api
sleep 5
docker compose ps
EOF
  } | ssh "$SRC_HOST" 'bash -s'
  log "source is serving again. Nothing on it was deleted, so no data was lost."
  log "If anyone already wrote to the destination, those rows need copying back by hand."
}

# ----------------------------------------------------------------------- main

case "${1:-}" in
  check)    cmd_check ;;
  cutover)  cmd_cutover ;;
  rollback) cmd_rollback ;;
  *)
    echo "usage: bash scripts/migrate-to-fapa.sh {check|cutover|rollback}" >&2
    exit 2
    ;;
esac
