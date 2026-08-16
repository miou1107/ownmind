#!/usr/bin/env bash
# ensure-scanner-schedule.sh — repair the usage scanner's schedule if it has died.
#
# v1.26.79. Run on every auto-update, from update.sh. Idempotent: a healthy schedule is
# left completely untouched, so this costs one `launchctl list` on the normal path.
#
# Why this exists
# ---------------
# install.sh registers the schedule once, at install time, and nothing ever looks at it
# again. When it dies the scanner simply stops, the dashboard shows the user's usage
# columns as blank, and that reads exactly like "this person did not work today".
#
# Measured on production 2026-08-06: Adam's collector last reported on 2026-07-15. His MCP
# was alive the whole time, auto-updating and heartbeating daily. Only the scheduled task
# was gone. Three weeks, nobody noticed, because nothing was watching.
#
# The Windows side already had a repair (`interactive-upgrade.ps1` re-registers the task,
# and its comment names Adam). It never reached him: only `bootstrap.ps1` calls it, and
# nobody runs bootstrap by hand. Repair has to live on the road the failure travels, which
# is the daily auto-update.
#
# Contract
#   exit 0  — the schedule is alive (either it already was, or it is now)
#   exit 1  — the schedule is not alive and could not be restored
#
# Output is prefixed for machine reading, matching bootstrap.sh:
#   OK:schedule:already_registered | OK:schedule:repaired | ERROR:schedule:<why>
#
# Env overrides (tests):
#   OWNMIND_DIR — install path (default: $HOME/.ownmind)
#   OWNMIND_OS  — OS family    (default: $OSTYPE)

set -u

OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"
OWNMIND_OS="${OWNMIND_OS:-${OSTYPE:-unknown}}"
LABEL="com.ownmind.usage-scanner"
TIMER="ownmind-usage-scanner.timer"

# Never let a missing helper stop the repair; reporting is best-effort by design.
if [ -f "$OWNMIND_DIR/scripts/install-helpers/report-error.sh" ]; then
  # shellcheck source=/dev/null
  . "$OWNMIND_DIR/scripts/install-helpers/report-error.sh"
fi
if ! command -v report_error >/dev/null 2>&1; then
  report_error() { :; }
fi

fail() {
  echo "ERROR:schedule:$1" >&2
  report_error "scanner_schedule_repair_failed" "$1"
  exit 1
}

case "$OWNMIND_OS" in
  darwin*)
    PLIST_TEMPLATE="$OWNMIND_DIR/scripts/launchd/$LABEL.plist"
    PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

    # `launchctl list <label>` exits 0 only when the agent is actually loaded. Asking
    # launchd beats checking whether the plist file exists: Adam's failure mode is a
    # schedule that is registered on disk and not running.
    if launchctl list "$LABEL" >/dev/null 2>&1; then
      echo "OK:schedule:already_registered"
      exit 0
    fi

    [ -f "$PLIST_TEMPLATE" ] || fail "plist template missing at $PLIST_TEMPLATE"

    mkdir -p "$HOME/Library/LaunchAgents" || fail "cannot create ~/Library/LaunchAgents"

    # The plist cannot read environment variables, so {HOME} is substituted here.
    #
    # Two separate escapes, and both are needed. The destination is XML, so `&`, `<` and
    # `>` have to become entities or the file will not parse. Then sed's own replacement
    # syntax has to be satisfied: there `&` means "everything that matched", so an
    # unescaped home directory containing one would write the literal string `{HOME}` back
    # into the plist; `\` is an escape; and `|` would end the s command early and make sed
    # exit with a syntax error.
    #
    # XML first, sed second — the XML pass emits `&amp;`, which itself contains a `&` that
    # the sed pass then has to protect. The other order would leave it exposed.
    #
    # A corrupt plist is worse than no plist: it stays on disk and every later load fails.
    # That is this whole file's failure mode, written by the code meant to prevent it.
    home_xml=$(printf '%s' "$HOME" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    home_escaped=$(printf '%s' "$home_xml" | sed 's/[\\&|]/\\&/g')
    sed "s|{HOME}|$home_escaped|g" "$PLIST_TEMPLATE" > "$PLIST_PATH" \
      || fail "cannot write $PLIST_PATH"

    # No unload first. The agent is not loaded — that is why we are here — and an
    # unload-then-load pair is the shape that turns one bad moment into permanent
    # silence (v1.26.65 removed it from the Windows path for exactly this reason).
    launchctl load -w "$PLIST_PATH" >/dev/null 2>&1 || true

    # Loading without an error is evidence, not proof. Ask launchd again.
    launchctl list "$LABEL" >/dev/null 2>&1 \
      || fail "launchd still has no $LABEL after loading $PLIST_PATH"

    echo "OK:schedule:repaired"
    ;;

  linux*)
    command -v systemctl >/dev/null 2>&1 || {
      echo "OK:schedule:skipped_no_systemctl"
      exit 0
    }

    # There is a difference between "the timer is broken" and "this box has no systemd
    # user session to put a timer in". WSL and headless containers are usually the second:
    # `systemctl --user` cannot reach a D-Bus session, so the probe fails, the repair
    # fails, and a failure gets reported — every day, from every such machine. That would
    # bury the real failures this report exists to surface. Nothing here is repairable, so
    # say so and leave quietly.
    #
    # This holds only because of who calls this script. update.sh is invoked by
    # mcp/index.js, which runs inside the user's desktop session and therefore inherits
    # DBUS_SESSION_BUS_ADDRESS. A caller without that environment — a cron job, say —
    # would fail this probe on a machine where the timer works fine, and the repair would
    # be skipped instead of performed. If this script ever gains a second caller, this
    # probe has to be reconsidered rather than inherited.
    #
    # The skip is not silent either: the line below is printed and update.sh echoes it.
    if ! systemctl --user show-environment >/dev/null 2>&1; then
      echo "OK:schedule:skipped_no_user_bus"
      exit 0
    fi

    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

    # Both questions matter and they are different: `is-active` says it is running now,
    # `is-enabled` says it will come back after a reboot. A timer that is one but not the
    # other is a schedule that dies at the next restart, which is this defect on a delay.
    if systemctl --user is-active "$TIMER" >/dev/null 2>&1 \
       && systemctl --user is-enabled "$TIMER" >/dev/null 2>&1; then
      echo "OK:schedule:already_registered"
      exit 0
    fi

    mkdir -p "$SYSTEMD_USER_DIR" || fail "cannot create $SYSTEMD_USER_DIR"
    for unit in ownmind-usage-scanner.service "$TIMER"; do
      [ -f "$OWNMIND_DIR/scripts/systemd/$unit" ] || fail "unit template missing: $unit"
      cp "$OWNMIND_DIR/scripts/systemd/$unit" "$SYSTEMD_USER_DIR/" || fail "cannot install $unit"
    done

    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user enable --now "$TIMER" >/dev/null 2>&1 || true

    systemctl --user is-active "$TIMER" >/dev/null 2>&1 \
      || fail "$TIMER is still not active after enabling it"

    echo "OK:schedule:repaired"
    ;;

  msys*|cygwin*|mingw*|win32*)
    # Windows reached here and was told its OS was unsupported.
    #
    # Which undoes the reason this file exists. Its header describes a collector that stopped
    # for three weeks because only the scheduled task had died, and says the Windows repair
    # "never reached him: only bootstrap.ps1 calls it, and nobody runs bootstrap by hand.
    # Repair has to live on the road the failure travels, which is the daily auto-update."
    #
    # The daily auto-update on Windows is `bash update.sh` — that is the command the server
    # itself hands out in `upgrade_action.command`, and Git Bash runs it. It called this
    # script, fell through to the default branch, printed OK, and update.sh then printed
    # "[ OK ] Usage scanner ready" for a schedule nothing had looked at. Measured 2026-08-15.
    #
    # So: delegate to the PowerShell helper, which speaks the same output contract.
    PS_HELPER="$OWNMIND_DIR/scripts/install-helpers/ensure-scanner-schedule.ps1"
    [ -f "$PS_HELPER" ] || fail "windows helper missing at $PS_HELPER"

    # OWNMIND_PWSH exists so a test can drive this branch without a real Task Scheduler on the
    # other end. Deleting the developer's own scheduled task to watch it come back is not a
    # test, it is an outage with a stopwatch.
    PWSH="${OWNMIND_PWSH:-}"
    if [ -z "$PWSH" ]; then
      for candidate in powershell.exe pwsh.exe powershell pwsh; do
        if command -v "$candidate" >/dev/null 2>&1; then PWSH="$candidate"; break; fi
      done
    fi
    [ -n "$PWSH" ] || fail "no powershell interpreter on PATH to run the windows helper"

    # PowerShell needs a Windows path; Git Bash hands out /c/... which it cannot open.
    #
    # Through `to_win_path`, not a hand-rolled `cygpath` call. The repository has a guard for
    # exactly this — tests/installer-node-paths.test.js — and it caught the first version of
    # this branch. One conversion, in one place, is the point: `cygpath -w` and `cygpath -m`
    # differ in slash direction and the call sites disagreed about which they wanted.
    if [ -f "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh" ]; then
      # shellcheck disable=SC1091
      . "$OWNMIND_DIR/scripts/install-helpers/path-helpers.sh"
    else
      to_win_path() { echo "$1"; }
    fi
    PS_HELPER_WIN="$(to_win_path "$PS_HELPER")"

    # stderr is folded in deliberately, and kept. If the helper fails, its reason is the only
    # thing that makes the failure actionable, and discarding it would leave a bare exit code
    # — the shape of silent failure this whole script was written against.
    ps_out="$("$PWSH" -NoProfile -ExecutionPolicy Bypass -File "$PS_HELPER_WIN" 2>&1)"
    ps_status=$?
    contract_line="$(printf '%s\n' "$ps_out" | tr -d '\015' | grep -E '^(OK|ERROR):schedule:' | tail -1)"

    if [ -z "$contract_line" ]; then
      # It ran and said something this script cannot read. Report that, with what it said,
      # rather than inventing an OK — "I could not tell" and "it is fine" are different facts.
      fail "windows helper said nothing recognisable (exit $ps_status): $(printf '%s' "$ps_out" | tr '\n' ' ' | cut -c1-200)"
    fi

    echo "$contract_line"
    exit "$ps_status"
    ;;

  *)
    # A platform with no schedule to repair. Not a failure, and it must not make the caller
    # exit non-zero — but it is also not a claim that anything was checked.
    echo "OK:schedule:skipped_unsupported_os"
    ;;
esac
