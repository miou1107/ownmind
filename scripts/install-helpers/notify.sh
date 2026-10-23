#!/bin/bash
# notify.sh — shows one desktop notification titled "OwnMind" on macOS. Usage: notify.sh "<sentence>"
#
# The sentence reaches osascript as an argument (`item 1 of argv`), never spliced into the
# AppleScript text, so a double quote, a single quote or a backslash in it cannot break the
# script. Elsewhere (Linux, no desktop) it does nothing. It always exits 0: a notification that
# cannot be shown must not fail whatever started it.
#
# OWNMIND_NOTIFY_DRY_RUN=1 prints the osascript argument list, one "argv:<value>" per line,
# instead of running it (tests/first-load-watch.test.js).

text="${1:-}"
[ -n "$text" ] || exit 0

if [ "${OWNMIND_NOTIFY_DRY_RUN:-}" = 1 ]; then
  printf 'argv:%s\n' osascript - "$text"
  exit 0
fi

[ "$(uname -s)" = Darwin ] || exit 0
command -v osascript >/dev/null 2>&1 || exit 0

osascript - "$text" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
  display notification (item 1 of argv) with title "OwnMind"
end run
APPLESCRIPT
exit 0
