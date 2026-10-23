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

# install.sh writes its NEXT line to this file as well as printing it (OWNMIND_NEXT_FILE), and
# this script prints it again as the very last line of a successful run, so the AI that reads the
# output reads the instruction last.
OWNMIND_NEXT_FILE="${TMPDIR:-/tmp}/ownmind-next.$$"
export OWNMIND_NEXT_FILE
ownmind_print_next() {
  if [ -s "$OWNMIND_NEXT_FILE" ]; then cat "$OWNMIND_NEXT_FILE"; fi
  rm -f "$OWNMIND_NEXT_FILE" 2>/dev/null || true
}
# Prints 1 when this run carries the key and URL (the install message), nothing otherwise. The
# no-argument run is the upgrade the ownmind-upgrade skill starts.
ownmind_install_args() {
  if [ -n "${1:-${OWNMIND_INSTALL_KEY:-}}" ] && [ -n "${2:-}" ]; then echo 1; fi
}
# The server address the FIX lines name; the arguments are KEY URL.
OWNMIND_FIX_API="${2:-${OWNMIND_API_URL:-}}"
OWNMIND_FIX_API="${OWNMIND_FIX_API%/}"

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

# ownmind_ask_line CODE "ASK:CODE:<English sentence>"
# Prints an ASK line the AI relays to the person. When this computer already has a node and
# the OwnMind checkout's install-messages.cjs, the sentence comes out in the person's own
# language; otherwise (bootstrap runs before any node is on the machine) the English literal
# given as the second argument is printed. The literal must equal hooks/locales/en.json:
# tests/install-messages.test.js checks that.
ownmind_ask_line() {
  local code="$1" literal="$2" helper line node_bin
  helper="${OWNMIND_DIR:-$HOME/.ownmind}/scripts/install-helpers/install-messages.cjs"
  node_bin="${OWNMIND_NODE:-node}"
  if [ -f "$helper" ] && command -v "$node_bin" >/dev/null 2>&1 \
    && line=$("$node_bin" "$helper" ask "$code" 2>/dev/null) && [ -n "$line" ]; then
    printf '%s\n' "$line"
  else
    printf '%s\n' "$literal"
  fi
}

# Whether text from tar or curl says the disk is full.
ownmind_says_disk_full() {
  case "$1" in
    *"No space left"*|*"write error"*|*"Write failed"*|*"Error writing"*|*ENOSPC*|*"Disk quota"*) return 0 ;;
  esac
  return 1
}

# The command that runs the installer again, exactly as the person's AI can run it: the server's
# own install.sh, with the server address when it is known (OWNMIND_FIX_API) and the key left as
# <KEY> for the AI to fill in from the install message. $1 is an optional environment prefix for
# the bash side of the pipe, such as "OWNMIND_SOURCE=github ".
ownmind_retry_cmd() {
  local api="${OWNMIND_FIX_API:-<API_URL>}"
  printf 'curl -fsSL %s/install.sh | %sbash -s -- <KEY> %s' "$api" "${1:-}" "$api"
}

# ownmind_stop_write CODE MESSAGE OUTPUT
# A step that writes to disk failed. OUTPUT is what the failing command said: a full disk is
# something only the person can fix (ASK), anything else is worth one more run (FIX).
ownmind_stop_write() {
  if ownmind_says_disk_full "$3"; then
    log_err "$1" "$2 (the disk is full)"
    ownmind_ask_line disk_full "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
  else
    log_err "$1" "$2"
    echo "FIX:retry_install:$(ownmind_retry_cmd)"
  fi
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
  local tag ref rc mk_out
  OWNMIND_FIX_API="$api"
  OWNMIND_ARCHIVE_STRIP=0
  OWNMIND_ARCHIVE_RELEASE=""

  case "$source" in
    ""|server|github) ;;
    *)
      log_err download "OWNMIND_SOURCE must be server or github (got: $source)"
      echo "FIX:retry_install:$(ownmind_retry_cmd "OWNMIND_SOURCE= ")"
      return 1 ;;
  esac
  mk_out=$(mkdir -p "$(dirname "$dest")" 2>&1) || { ownmind_stop_write download "Could not create the folder for the download" "$mk_out"; return 1; }

  if [ "$source" != "github" ]; then
    log_info download "Downloading the release archive from $api"
    rc=1
    if [ -n "$key" ] && [ -n "$api" ]; then
      rc=0
      # shellcheck disable=SC2086 — see ownmind_github_latest_tag
      ownmind_curl_auth "$key" | curl -K - -fsSL $OWNMIND_CURL_FLAGS -o "$dest" "$api/api/install/archive" || rc=$?
      [ "$rc" -eq 0 ] && return 0
    fi
    rm -f "$dest"
    # curl exit 23 is "could not write the file", which on an install is a full disk.
    if [ "$rc" -eq 23 ]; then
      log_err download "Could not save the release archive (the disk is full)"
      ownmind_ask_line disk_full "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
      return 1
    fi
    if [ "$source" = "server" ]; then
      log_err download "Could not download the release archive from $api"
      echo "FIX:use_fallback_source:$(ownmind_retry_cmd "OWNMIND_SOURCE=github ")"
      ownmind_ask_line no_network "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
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
  rc=0
  # shellcheck disable=SC2086 — see ownmind_github_latest_tag
  curl -fsSL $OWNMIND_CURL_FLAGS -o "$dest" "$gh_codeload/miou1107/ownmind/tar.gz/$ref" || rc=$?
  if [ "$rc" -eq 0 ]; then
    OWNMIND_ARCHIVE_STRIP=1
    return 0
  fi
  rm -f "$dest"
  if [ "$rc" -eq 23 ]; then
    log_err download "Could not save the release archive (the disk is full)"
    ownmind_ask_line disk_full "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
    return 1
  fi
  log_err download "Could not download the release archive from the OwnMind server or GitHub"
  ownmind_ask_line no_network "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
  return 1
}

# ownmind_unpack_release ARCHIVE PARTIAL_DIR FINAL_DIR
# Unpacks into PARTIAL_DIR, checks that .release and install.sh are there, and only then
# renames PARTIAL_DIR to FINAL_DIR, so FINAL_DIR never exists half-unpacked.
ownmind_unpack_release() {
  local archive="$1" partial="$2" final="$3" release tar_out io_out
  io_out=$(mkdir -p "$partial" 2>&1) || { ownmind_stop_write unpack "Could not create $partial" "$io_out"; return 1; }
  # tar's own words are kept: they say whether the disk filled up or the archive is damaged.
  if [ "${OWNMIND_ARCHIVE_STRIP:-0}" = "1" ]; then
    # GitHub archives wrap everything in one folder, and carry no .release of their own.
    tar_out=$(tar -xzf "$archive" -C "$partial" --strip-components 1 2>&1) || { ownmind_unpack_failed "$tar_out"; return 1; }
    io_out=$({ printf '%s\n' "$OWNMIND_ARCHIVE_RELEASE" > "$partial/.release"; } 2>&1) || { ownmind_stop_write unpack "Could not write .release" "$io_out"; return 1; }
  else
    tar_out=$(tar -xzf "$archive" -C "$partial" 2>&1) || { ownmind_unpack_failed "$tar_out"; return 1; }
  fi
  if [ ! -f "$partial/.release" ] || [ ! -f "$partial/install.sh" ]; then
    log_err unpack "The archive is missing .release or install.sh"
    echo "FIX:retry_install:$(ownmind_retry_cmd)"
    return 1
  fi
  rm -f "$archive"
  io_out=$(mv "$partial" "$final" 2>&1) || { ownmind_stop_write unpack "Could not move the unpacked files into $final" "$io_out"; return 1; }
  release=$(head -n 1 "$final/.release" | tr -d '[:space:]')
  log_ok unpack "release $release unpacked"
}

# A failed unpack is either a full disk (nothing the AI can do) or a damaged archive (a second
# download fixes it). $1 is what tar said.
ownmind_unpack_failed() {
  if ownmind_says_disk_full "$1"; then
    log_err unpack "Could not unpack the archive (the disk is full)"
    ownmind_ask_line disk_full "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
  else
    log_err unpack "Could not unpack the archive (it may be damaged)"
    echo "FIX:retry_install:$(ownmind_retry_cmd)"
  fi
}
# END fetch-release

# Download the archive and unpack it into $OWNMIND_DIR. Used whenever there is no git, or the
# directory has to be rebuilt without git. Exits the script on failure.
install_from_archive() {
  local key="${1:-${OWNMIND_INSTALL_KEY:-}}" api="${2:-}"
  local partial="${OWNMIND_DIR}.partial"
  if [ -z "$key" ] || [ -z "$api" ]; then
    log_err missing_args "The API key and URL are needed to install OwnMind (bash -s -- YOUR_API_KEY YOUR_API_URL)"
    echo "FIX:rerun_with_args:curl -fsSL <API_URL>/install.sh | bash -s -- <KEY> <API_URL>"
    exit 1
  fi
  log_info archive_mode "git is not installed; installing from the release archive"
  if [ -e "$partial" ]; then
    log_info clear_partial "Removing the unfinished download from an earlier attempt ($partial)"
    rm -rf "$partial" || { log_err clear_partial "Could not remove $partial"; echo "FIX:clear_partial:rm -rf ~/.ownmind.partial"; exit 1; }
  fi
  # grammar-allow: ownmind_download_archive and ownmind_unpack_release have already printed their own ERROR with FIX or ASK
  ownmind_download_archive "$key" "$api" "$partial/archive.tar.gz" || { rm -rf "$partial"; exit 1; }
  ownmind_unpack_release "$partial/archive.tar.gz" "$partial" "$OWNMIND_DIR" || exit 1
  cd "$OWNMIND_DIR"
  # Private Node runtime when this machine has no usable node. The file exists in every release
  # that has this feature; the guard lets an older release without it still install.
  # grammar-allow: ownmind_ensure_node has already printed its own ERROR with FIX or ASK
  if [ -f "$OWNMIND_DIR/scripts/install-helpers/ensure-node-runtime.sh" ]; then
    . "$OWNMIND_DIR/scripts/install-helpers/ensure-node-runtime.sh"
    ownmind_ensure_node "${api%/}" "$key" || exit 1
  fi
  log_info install "Running install.sh (forwarding API_KEY + API_URL)"
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; echo "FIX:retry_install:$(ownmind_retry_cmd)"; exit 1; }
  log_ok done "Fresh install complete (release archive)"
}

log_info detect "Checking OwnMind installation ($OWNMIND_DIR)"

# Branch 1: no install
if [ ! -d "$OWNMIND_DIR" ]; then
  if [ "$HAS_GIT" = "0" ]; then
    install_from_archive "$@"
    ownmind_print_next
    exit 0
  fi
  log_info fresh "Fresh install: cloning repo"
  # `set -e` with `pipefail` ends the script at a failed clone before any line below could say why,
  # so the clone sits in the condition of an `if`.
  if ! git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done \
    || [ ! -d "$OWNMIND_DIR/.git" ]; then
    log_err git_clone "git clone failed (check network or GitHub access)"
    ownmind_ask_line no_network "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
    exit 1
  fi
  log_ok clone "Clone complete"
  cd "$OWNMIND_DIR"
  log_info install "Running install.sh (forwarding API_KEY + API_URL)"
  # Forward positional args ("$@") to install.sh; if missing, install.sh
  # prints its own friendly error message and exits non-zero.
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; echo "FIX:retry_install:$(ownmind_retry_cmd)"; exit 1; }
  log_ok done "Fresh install complete"
  ownmind_print_next
  exit 0
fi

# Branch 2: no .git. With .release and install.sh this is a healthy archive install; otherwise it is broken.
# A swap journal without .release is an archive update stopped part-way, not a broken directory.
if [ ! -d "$OWNMIND_DIR/.git" ] && { [ -f "$OWNMIND_DIR/.release" ] || [ -f "$OWNMIND_DIR/.swap-journal.json" ]; } && [ -f "$OWNMIND_DIR/install.sh" ]; then
  # A run that carries the key and URL is the install message pasted again, usually after a FIX
  # or ASK stopped the first install part-way (no Node yet, no credentials written, npm failed).
  # The upgrader cannot finish that: it reads the credentials from settings and never installs
  # Node. install.sh does both, so it runs here; the upgrader is for the no-argument upgrade.
  if [ -z "$(ownmind_install_args "$@")" ] && grep -q 'ARCHIVE_MODE' "$OWNMIND_DIR/scripts/interactive-upgrade.sh" 2>/dev/null; then
    log_info upgrade "Archive install found; delegating to interactive-upgrade.sh"
    exec bash "$OWNMIND_DIR/scripts/interactive-upgrade.sh"
  fi
  log_info already_installed "archive install found; re-running install.sh"
  cd "$OWNMIND_DIR"
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; echo "FIX:retry_install:$(ownmind_retry_cmd)"; exit 1; }
  log_ok done "Archive install checked"
  ownmind_print_next
  exit 0
fi

# Branch 2b: broken
if [ ! -d "$OWNMIND_DIR/.git" ]; then
  BAK="${OWNMIND_DIR}.broken.${TS}"
  log_info broken "$OWNMIND_DIR exists but is not a git repo; backing up to $BAK"
  # grammar-allow: a rename inside the home folder failing means the folder is locked or unwritable, which no command the AI may run changes
  mv "$OWNMIND_DIR" "$BAK" || { log_err backup "Backup failed"; exit 1; }
  # A rename keeps the old modification time; the 7-day sweep in interactive-upgrade.sh counts from now.
  touch "$BAK" 2>/dev/null || true
  log_ok backup "Backed up"
  if [ "$HAS_GIT" = "0" ]; then
    install_from_archive "$@"
    log_ok done "Repair complete (old data preserved at $BAK; backups older than 7 days are swept on next upgrade)"
    ownmind_print_next
    exit 0
  fi
  log_info fresh "Re-cloning"
  if ! git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done \
    || [ ! -d "$OWNMIND_DIR/.git" ]; then
    log_err git_clone "Re-clone failed; old data preserved at $BAK"
    ownmind_ask_line no_network "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
    exit 1
  fi
  cd "$OWNMIND_DIR"
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; echo "FIX:retry_install:$(ownmind_retry_cmd)"; exit 1; }
  log_ok done "Repair complete (old data preserved at $BAK; backups older than 7 days are swept on next upgrade)"
  ownmind_print_next
  exit 0
fi

# Branch 3 with the key and URL: the install message pasted on a machine that already has a git
# checkout (a first install that stopped after the clone, or a reinstall). The upgrader would skip
# install.sh when no credentials were written yet, so the checkout is brought up to date when it
# can be (a fast-forward only; local changes are left alone) and install.sh runs with the arguments.
if [ -n "$(ownmind_install_args "$@")" ]; then
  log_info reinstall "Installed (git); re-running install.sh with the key and URL"
  cd "$OWNMIND_DIR"
  if [ "$HAS_GIT" = "1" ] && ! git pull --ff-only --quiet 2>/dev/null; then
    log_info reinstall "Could not fast-forward the checkout; installing the code that is here"
  fi
  bash install.sh "$@" || { log_err install "install.sh failed (missing API_KEY/URL or other error)"; echo "FIX:retry_install:$(ownmind_retry_cmd)"; exit 1; }
  log_ok done "Install checked"
  ownmind_print_next
  exit 0
fi

# Branch 3: normal upgrade
log_info upgrade "Installed; delegating to interactive-upgrade.sh"
exec bash "$OWNMIND_DIR/scripts/interactive-upgrade.sh"
