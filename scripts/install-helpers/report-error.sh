#!/usr/bin/env bash
# report-error.sh — Bash helper（v1.17.79, IR-038）
#
# 用法（source 之後呼叫）：
#   source ~/.ownmind/scripts/install-helpers/report-error.sh
#   report_error <kind> <detail> [context_file]
#
# 設計：永不擋 caller。沒 node / 寫不出檔都靜默吞掉。

report_error() {
  local kind="${1:-unknown}"
  local detail="${2:-}"
  local context_file="${3:-}"
  local helper="${HOME}/.ownmind/scripts/install-helpers/report-error.cjs"
  if [ ! -f "$helper" ]; then return 0; fi
  if ! command -v node >/dev/null 2>&1; then return 0; fi
  local args=( "--kind=$kind" "--detail=$detail" )
  if [ -n "$context_file" ]; then
    args+=( "--context-file=$context_file" )
  fi
  node "$helper" "${args[@]}" >/dev/null 2>&1 || true
}
