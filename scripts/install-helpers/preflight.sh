#!/usr/bin/env bash
# Environment preflight for the macOS / Linux install and upgrade paths (#98).
#
# The twin of scripts/install-helpers/preflight.ps1. The incident that prompted this was on
# Windows — a machine with no `git` on PATH backed up ~/.ownmind and then died on the first git
# call with no ERROR: line, no report, and a stray .ownmind.bak.* left behind — but the shell
# side had the same hole: interactive-upgrade.sh checked that ${OWNMIND_DIR}/.git *exists* and
# never that the git *executable* is reachable, and neither did anything ask about node or npm.
#
# Keeping the two sides symmetric is the standing rule for this pair of scripts (IR-022); a
# check that exists on one platform and not the other is the shape this repository has been
# bitten by repeatedly.
#
# Reports every unmet requirement in one pass, so a machine missing two things costs one
# round-trip rather than two. Runs before anything is copied or moved.
#
# The one requirement that cannot be reported to the server: report-error.cjs runs on node. A
# machine with no node sees the message on screen and sends nothing.

# The lowest Node the test matrix covers (.github/workflows/test.yml), and the same floor
# install.ps1 has enforced since v1.17.76. Raise it here and the check follows.
OWNMIND_NODE_FLOOR=20

# Every unmet requirement, one per line, as "name<TAB>problem<TAB>remedy".
# Writes nothing else and never exits, so the caller decides what to do.
ownmind_preflight_failures() {
  local remedy_node remedy_git

  case "$(uname -s 2>/dev/null)" in
    Darwin)
      remedy_git='xcode-select --install     # or: brew install git'
      remedy_node='brew install node' ;;
    *)
      remedy_git='sudo apt-get install -y git     # or your package manager'
      remedy_node='sudo apt-get install -y nodejs npm     # or your package manager' ;;
  esac

  if ! command -v git >/dev/null 2>&1; then
    printf 'git\tgit is not on PATH; OwnMind is installed and updated with it\t%s\n' "$remedy_git"
  fi

  if ! command -v node >/dev/null 2>&1; then
    printf 'node\tnode is not on PATH; the memory server, the self-check and the error reporter all run on it\t%s\n' "$remedy_node"
  else
    local raw major
    raw=$(node --version 2>/dev/null)
    # Strip the leading v, then everything from the first dot. A node that answers nothing
    # leaves this empty, which the -gt below cannot compare, so it is treated as unusable.
    major=${raw#v}
    major=${major%%.*}
    if ! printf '%s' "$major" | grep -Eq '^[0-9]+$'; then
      printf 'node\tnode is on PATH but did not answer --version, so it cannot be used\t%s\n' "$remedy_node"
    elif [ "$major" -lt "$OWNMIND_NODE_FLOOR" ]; then
      printf 'node\tnode %s is below the oldest version OwnMind is tested on (%s)\t%s\n' \
        "$major" "$OWNMIND_NODE_FLOOR" "$remedy_node"
    fi
  fi

  # npm ships with node, so node present and npm absent means a partial install — or a shim
  # that resolves and does not run, which is why it is asked for a version rather than merely
  # looked up.
  if ! command -v npm >/dev/null 2>&1; then
    printf 'npm\tnpm is not on PATH; the memory server installs its dependencies with it\t%s\n' "$remedy_node"
  elif ! npm --version >/dev/null 2>&1; then
    printf 'npm\tnpm is on PATH but does not run\t%s\n' "$remedy_node"
  fi
}

# Print every unmet requirement and return 1, or return 0 when the machine is ready.
# $1 is the stage name, which goes into the report kind so the console can tell an install
# from an upgrade.
ownmind_preflight_assert() {
  local stage="${1:-install}" failures count
  failures=$(ownmind_preflight_failures)
  [ -n "$failures" ] || return 0

  count=$(printf '%s\n' "$failures" | grep -c . )
  printf '\n'
  printf 'ERROR:preflight:This machine is missing %s thing(s) OwnMind needs. Nothing has been changed.\n' "$count" >&2
  while IFS=$'\t' read -r name problem remedy; do
    [ -n "$name" ] || continue
    # `preflight_missing_<tool>`, the same word bootstrap.sh and bootstrap.ps1 print and the
    # same kind the report carries. It said `preflight_<tool>` here until CI caught it: one
    # thing had two names depending on which script you happened to reach it through.
    printf 'ERROR:preflight_missing_%s:%s\n' "$name" "$problem" >&2
    printf '  fix: %s\n' "$remedy" >&2
    # report_error comes from report-error.sh, which the caller has already sourced. It is
    # noop-on-missing there, but this file is also sourced on its own by the tests.
    if command -v report_error >/dev/null 2>&1; then
      report_error "preflight_missing_${name}" "${stage} - ${problem}" || true
    fi
  done <<EOF
$failures
EOF
  printf '\nFix the above and run the same command again.\n' >&2
  return 1
}
