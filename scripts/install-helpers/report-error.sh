#!/usr/bin/env bash
# report-error.sh — Bash helper (v1.17.79, IR-038).
#
# Usage (source then call):
#   source ~/.ownmind/scripts/install-helpers/report-error.sh
#   report_error <kind> <detail> [context_file]
#
# Design: never blocks the caller. If node is missing or the file can't be written, swallow silently.

report_error() {
  local kind="${1:-unknown}"
  local detail="${2:-}"
  local context_file="${3:-}"
  # v1.26.98 — OWNMIND_REPORT_HELPER lets a caller point at a copy that is not inside
  # ~/.ownmind. The rollback in interactive-upgrade.sh deletes that directory before moving
  # the backup into place, so the one failure worth reporting — deleted, and the move then
  # failed — is exactly the one where this helper has just been removed. Measured: the
  # function returned 0 and wrote nothing, so the caller believed it had reported.
  local helper="${OWNMIND_REPORT_HELPER:-}"
  if [ -z "$helper" ] || [ ! -f "$helper" ]; then
    helper="${HOME}/.ownmind/scripts/install-helpers/report-error.cjs"
  fi
  if [ ! -f "$helper" ]; then return 0; fi
  if ! command -v node >/dev/null 2>&1; then return 0; fi
  local args=( "--kind=$kind" "--detail=$detail" )
  if [ -n "$context_file" ]; then
    args+=( "--context-file=$context_file" )
  fi
  node "$helper" "${args[@]}" >/dev/null 2>&1 || true
}
