#!/usr/bin/env bash
# OwnMind Universal Bootstrap — install / upgrade / repair in one script
#
# Usage:
#   Already installed (upgrade only):
#     bash ~/.ownmind/scripts/bootstrap.sh
#     curl -fsSL https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.sh | bash
#   Fresh install / repair (needs API key + URL):
#     curl -fsSL https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.sh | bash -s -- YOUR_API_KEY YOUR_API_URL
#
# Branches:
#   1. ~/.ownmind not present         → fresh clone (git) or release archive (no git), then install.sh "$@"
#   2. ~/.ownmind present, no .git    → with .release: healthy archive install, re-run install.sh
#                                       without .release: backup + re-install (requires API key args)
#   3. ~/.ownmind is a git repo       → delegate to scripts/interactive-upgrade.sh (no args needed)
#
# Archive mode (no git on this machine): the release archive comes from the OwnMind server
# ($API_URL/api/install/archive), then from GitHub. It is unpacked into ~/.ownmind.partial and
# renamed to ~/.ownmind only after a full unpack.
#
# Env overrides (for testing):
#   OWNMIND_DIR     — install path (default: $HOME/.ownmind)
#   OWNMIND_REPO    — git URL      (default: https://github.com/miou1107/ownmind.git)
#   OWNMIND_SOURCE  — server | github: force one archive source (default: server, then github)
#
# Log format (machine-readable):
#   INFO:detect:<message>   — progress message
#   OK:done:<message>       — step succeeded
#   ERROR:install:<message> — failure
#   FIX:<code>:<command>    — a command that repairs the failure
#   ASK:<code>:<sentence>   — something the person at the keyboard has to do

set -e
# pipefail: ensure `git clone ... | while read ...` propagates git's
# non-zero exit code instead of masking it behind the always-successful while.
set -o pipefail

OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"
OWNMIND_REPO="${OWNMIND_REPO:-https://github.com/miou1107/ownmind.git}"
TS=$(date +%Y%m%d-%H%M%S)

log_info() { echo "INFO:$1:$2"; }
log_ok()   { echo "OK:$1:$2"; }
log_err()  { echo "ERROR:$1:$2" >&2; }

# Without git, OwnMind is installed from a release archive (see "Archive mode" above). The
# git check and the download and unpack functions below are embedded copies of
# scripts/install-helpers/preflight.sh (git-usable) and scripts/install-helpers/fetch-release.sh:
# this script is fetched over the network and run before anything is on disk, so it cannot source
# that file. tests/bootstrap-archive-mode.test.js fails when the two copies differ.
# BEGIN git-usable
# Is there a git that works? `command -v git` is not enough on a Mac: macOS ships /usr/bin/git
# as a stub that opens the "install the developer tools" dialog when run. The stub is told
# apart from the real thing by `xcode-select -p`, which exits non-zero and shows no dialog when
# the command line tools are absent. A git anywhere else (Homebrew, a private install) is real.
# OWNMIND_XCODE_SELECT and OWNMIND_GIT_STUB_DIR exist so tests can stand in for the Mac; setting
# OWNMIND_XCODE_SELECT also turns the check on for a machine that is not a Mac.
ownmind_git_usable() {
  local git_path
  git_path=$(command -v git 2>/dev/null) || return 1
  [ -n "$git_path" ] || return 1
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] || [ -n "${OWNMIND_XCODE_SELECT:-}" ]; then
    case "$git_path" in
      "${OWNMIND_GIT_STUB_DIR:-/usr/bin}"/*)
        "${OWNMIND_XCODE_SELECT:-/usr/bin/xcode-select}" -p >/dev/null 2>&1 || return 1 ;;
    esac
  fi
  return 0
}
# END git-usable

HAS_GIT=1
ownmind_git_usable || HAS_GIT=0

# BEGIN fetch-release
# curl options shared by every call below. --retry-all-errors needs curl 7.71, and macOS 11
# ships 7.64: passing it there makes curl exit 2 on every call, which would read as "no
# network". So it is probed once, and the help text is captured first because `grep -q` on a
# pipe can close it early and fail the pipeline under pipefail. --speed-limit/--speed-time end
# a connection that has stalled, so an unattended install cannot hang forever.
OWNMIND_CURL_FLAGS="--retry 3 --connect-timeout 15 --speed-limit 1024 --speed-time 60"
OWNMIND_CURL_HELP=$(curl --help all 2>/dev/null || true)
case "$OWNMIND_CURL_HELP" in
  *--retry-all-errors*) OWNMIND_CURL_FLAGS="$OWNMIND_CURL_FLAGS --retry-all-errors" ;;
esac

# Emit a curl config on stdout carrying the Authorization header, so the key is read through
# `curl -K -` from stdin and never appears on a command line that `ps` can show. Backslashes
# and quotes in the key are escaped for curl's config syntax by sed, which also gets the key
# on its input.
ownmind_curl_auth() {
  printf 'header = "Authorization: Bearer %s"\n' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')"
}

# Newest vX.Y.Z tag of the public repo, parsed with grep and sed (there is no node yet).
# Prints nothing when the tags API cannot be reached.
ownmind_github_latest_tag() {
  local tags
  # shellcheck disable=SC2086 — $OWNMIND_CURL_FLAGS is a fixed list of curl options, split on purpose
  tags=$(curl -fsSL $OWNMIND_CURL_FLAGS \
    "${OWNMIND_GITHUB_API:-https://api.github.com}/repos/miou1107/ownmind/tags?per_page=30" 2>/dev/null) || return 0
  printf '%s\n' "$tags" \
    | grep -o '"name": *"v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' \
    | sed 's/.*"\(v[^"]*\)"$/\1/' \
    | sort -t. -k1.2,1n -k2,2n -k3,3n \
    | tail -n 1 || true
}

# ownmind_download_archive KEY API_URL DEST_FILE
# Sources in order: the OwnMind server, then GitHub. OWNMIND_SOURCE=server|github forces one.
# Sets OWNMIND_ARCHIVE_STRIP (1 when the archive has one top-level folder to strip) and
# OWNMIND_ARCHIVE_RELEASE (the release name to write into .release when stripping).
# Returns 0 on success; on failure it has already printed ERROR / FIX / ASK lines.
ownmind_download_archive() {
  local key="$1" api="${2%/}" dest="$3"
  local source="${OWNMIND_SOURCE:-}"
  local gh_codeload="${OWNMIND_GITHUB_CODELOAD:-https://codeload.github.com}"
  local tag ref
  OWNMIND_ARCHIVE_STRIP=0
  OWNMIND_ARCHIVE_RELEASE=""

  case "$source" in
    ""|server|github) ;;
    *) log_err download "OWNMIND_SOURCE must be server or github (got: $source)"; return 1 ;;
  esac
  mkdir -p "$(dirname "$dest")" || return 1

  if [ "$source" != "github" ]; then
    log_info download "Downloading the release archive from $api"
    # shellcheck disable=SC2086 — see ownmind_github_latest_tag
    if [ -n "$key" ] && [ -n "$api" ] \
      && ownmind_curl_auth "$key" | curl -K - -fsSL $OWNMIND_CURL_FLAGS -o "$dest" "$api/api/install/archive"; then
      return 0
    fi
    rm -f "$dest"
    if [ "$source" = "server" ]; then
      log_err download "Could not download the release archive from $api"
      echo "FIX:use_fallback_source:OWNMIND_SOURCE=github bash <same one-liner>"
      echo "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
      return 1
    fi
    log_info fallback_source "The OwnMind server did not deliver the archive; trying GitHub"
  fi

  tag=$(ownmind_github_latest_tag)
  if [ -n "$tag" ]; then
    ref="refs/tags/$tag"
    OWNMIND_ARCHIVE_RELEASE="$tag"
  else
    ref="refs/heads/main"
    OWNMIND_ARCHIVE_RELEASE="main"
    log_info fallback_source "GitHub tag list unavailable; using the main branch"
  fi
  log_info download "Downloading the release archive from GitHub ($OWNMIND_ARCHIVE_RELEASE)"
  # shellcheck disable=SC2086 — see ownmind_github_latest_tag
  if curl -fsSL $OWNMIND_CURL_FLAGS -o "$dest" "$gh_codeload/miou1107/ownmind/tar.gz/$ref"; then
    OWNMIND_ARCHIVE_STRIP=1
    return 0
  fi
  rm -f "$dest"
  log_err download "Could not download the release archive from the OwnMind server or GitHub"
  echo "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
  return 1
}

# ownmind_unpack_release ARCHIVE PARTIAL_DIR FINAL_DIR
# Unpacks into PARTIAL_DIR, checks that .release and install.sh are there, and only then
# renames PARTIAL_DIR to FINAL_DIR, so FINAL_DIR never exists half-unpacked.
ownmind_unpack_release() {
  local archive="$1" partial="$2" final="$3" release
  mkdir -p "$partial" || return 1
  if [ "${OWNMIND_ARCHIVE_STRIP:-0}" = "1" ]; then
    # GitHub archives wrap everything in one folder, and carry no .release of their own.
    tar -xzf "$archive" -C "$partial" --strip-components 1 || { log_err unpack "Could not unpack the archive (it may be damaged)"; return 1; }
    printf '%s\n' "$OWNMIND_ARCHIVE_RELEASE" > "$partial/.release" || return 1
  else
    tar -xzf "$archive" -C "$partial" || { log_err unpack "Could not unpack the archive (it may be damaged)"; return 1; }
  fi
  if [ ! -f "$partial/.release" ] || [ ! -f "$partial/install.sh" ]; then
    log_err unpack "The archive is missing .release or install.sh"
    return 1
  fi
  rm -f "$archive"
  mv "$partial" "$final" || { log_err unpack "Could not move the unpacked files into $final"; return 1; }
  release=$(head -n 1 "$final/.release" | tr -d '[:space:]')
  log_ok unpack "release $release unpacked"
}
# END fetch-release

# Download the archive and unpack it into $OWNMIND_DIR. Used whenever there is no git, or the
# directory has to be rebuilt without git. Exits the script on failure.
install_from_archive() {
  local key="${1:-${OWNMIND_INSTALL_KEY:-}}" api="${2:-}"
  local partial="${OWNMIND_DIR}.partial"
  if [ -z "$key" ] || [ -z "$api" ]; then
    log_err missing_args "The API key and URL are needed to install OwnMind (bash -s -- YOUR_API_KEY YOUR_API_URL)"
    exit 1
  fi
  log_info archive_mode "git is not installed; installing from the release archive"
  if [ -e "$partial" ]; then
    log_info clear_partial "Removing the unfinished download from an earlier attempt ($partial)"
    rm -rf "$partial" || { echo "FIX:clear_partial:rm -rf ~/.ownmind.partial"; exit 1; }
  fi
  ownmind_download_archive "$key" "$api" "$partial/archive.tar.gz" || { rm -rf "$partial"; exit 1; }
  ownmind_unpack_release "$partial/archive.tar.gz" "$partial" "$OWNMIND_DIR" || exit 1
  cd "$OWNMIND_DIR"
  # Private Node runtime (installed by a later step; the guard keeps this script shippable alone).
  if [ -f "$OWNMIND_DIR/scripts/install-helpers/ensure-node-runtime.sh" ]; then
    . "$OWNMIND_DIR/scripts/install-helpers/ensure-node-runtime.sh"
    ownmind_ensure_node "${api%/}" "$key" || exit 1
  fi
  log_info install "Running install.sh (forwarding API_KEY + API_URL)"
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; exit 1; }
  log_ok done "Fresh install complete (release archive)"
}

log_info detect "Checking OwnMind installation ($OWNMIND_DIR)"

# Branch 1: no install
if [ ! -d "$OWNMIND_DIR" ]; then
  if [ "$HAS_GIT" = "0" ]; then
    install_from_archive "$@"
    exit 0
  fi
  log_info fresh "Fresh install: cloning repo"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  if [ ! -d "$OWNMIND_DIR/.git" ]; then
    log_err git_clone "git clone failed (check network or GitHub access)"
    exit 1
  fi
  log_ok clone "Clone complete"
  cd "$OWNMIND_DIR"
  log_info install "Running install.sh (forwarding API_KEY + API_URL)"
  # Forward positional args ("$@") to install.sh; if missing, install.sh
  # prints its own friendly error message and exits non-zero.
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; exit 1; }
  log_ok done "Fresh install complete"
  exit 0
fi

# Branch 2: no .git. With .release and install.sh this is a healthy archive install; otherwise it is broken.
if [ ! -d "$OWNMIND_DIR/.git" ] && [ -f "$OWNMIND_DIR/.release" ] && [ -f "$OWNMIND_DIR/install.sh" ]; then
  if grep -q 'ARCHIVE_MODE' "$OWNMIND_DIR/scripts/interactive-upgrade.sh" 2>/dev/null; then
    log_info upgrade "Archive install found; delegating to interactive-upgrade.sh"
    exec bash "$OWNMIND_DIR/scripts/interactive-upgrade.sh"
  fi
  log_info already_installed "archive install found; re-running install.sh"
  cd "$OWNMIND_DIR"
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; exit 1; }
  log_ok done "Archive install checked"
  exit 0
fi

# Branch 2b: broken
if [ ! -d "$OWNMIND_DIR/.git" ]; then
  BAK="${OWNMIND_DIR}.broken.${TS}"
  log_info broken "$OWNMIND_DIR exists but is not a git repo; backing up to $BAK"
  mv "$OWNMIND_DIR" "$BAK" || { log_err backup "Backup failed"; exit 1; }
  log_ok backup "Backed up"
  if [ "$HAS_GIT" = "0" ]; then
    install_from_archive "$@"
    log_ok done "Repair complete (old data preserved at $BAK; backups older than 7 days are swept on next upgrade)"
    exit 0
  fi
  log_info fresh "Re-cloning"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  cd "$OWNMIND_DIR"
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; exit 1; }
  log_ok done "Repair complete (old data preserved at $BAK; backups older than 7 days are swept on next upgrade)"
  exit 0
fi

# Branch 3: normal upgrade
log_info upgrade "Installed; delegating to interactive-upgrade.sh"
exec bash "$OWNMIND_DIR/scripts/interactive-upgrade.sh"
