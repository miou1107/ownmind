#!/usr/bin/env bash
# scripts/install-helpers/path-helpers.sh
#
# Shared path-normalization helper for OwnMind shell scripts.
#
# Why this exists:
#   Under Git Bash on Windows, $HOME / $OWNMIND_DIR / $CLAUDE_DIR expand to MSYS-style
#   POSIX paths (e.g. /c/Users/Vin/.ownmind). Native Win32 binaries — most importantly
#   node.exe and powershell.exe — do NOT recognize the /c/... prefix when resolving
#   modules or reading files. So a call like
#
#       node -p "require('${OWNMIND_DIR}/package.json').version"
#
#   silently fails with MODULE_NOT_FOUND on Windows + Git Bash, while working everywhere else.
#   This was Vin's 2026-05-26 bug report and the documented use case for
#   scripts/install-helpers/path-to-win32.cjs (the existing Node-side counterpart).
#
# Usage:
#   . "${OWNMIND_DIR}/scripts/install-helpers/path-helpers.sh"
#   OWNMIND_DIR_WIN="$(to_win_path "${OWNMIND_DIR}")"
#   VERSION=$(node -p "require('${OWNMIND_DIR_WIN}/package.json').version")
#
# Behavior:
#   - On Git Bash / MSYS, `cygpath -m` converts /c/Users/Vin to C:/Users/Vin
#     (mixed style: forward slashes + drive letter — Node accepts this and there
#     is no backslash escaping headache inside bash quoted strings).
#   - On Mac / Linux, `cygpath` does not exist, so the helper returns the input
#     unchanged — fully cross-platform safe.
#
# Limitation, stated so nobody assumes otherwise: the result is interpolated into a
# single-quoted JavaScript string literal at every call site. `cygpath -m` output cannot
# contain a newline or a backslash, so the common cases are safe — but a home directory
# containing an apostrophe (C:\Users\O'Brien) would break the generated source. Passing the
# path as an argv element and reading process.argv is the escape-proof shape; install.sh
# does that where the block was already written for it. Pre-existing class: $API_URL and
# $API_KEY are interpolated the same way.
#
# This helper is intentionally a thin bash function (not a Node module) because
# the call sites NEED a working path before they can even invoke Node — invoking
# Node to translate the path is the chicken-and-egg problem that left
# path-to-win32.cjs unused for two months.

# Convert a path to a Windows-native form when running under Git Bash on Windows.
# No-op on Mac / Linux / WSL (any environment without `cygpath`).
to_win_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}
