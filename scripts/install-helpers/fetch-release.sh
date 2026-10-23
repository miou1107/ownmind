#!/usr/bin/env bash
# Download and unpack an OwnMind release archive on a machine that has no git.
#
# This file is the single source for the download and unpack functions. bootstrap.sh cannot
# source it: bootstrap is fetched over the network and run before anything is on disk, so the
# block between the BEGIN/END markers below is EMBEDDED into bootstrap.sh byte for byte.
# tests/bootstrap-archive-mode.test.js fails when the two copies differ. Edit here, then
# paste the block into bootstrap.sh.
#
# The functions print the same INFO/OK/ERROR lines as bootstrap.sh through log_info, log_ok
# and log_err. When this file is sourced on its own (not from bootstrap.sh), the fallbacks
# just below define them.
#
# Bash 3.2 compatible (stock macOS): none of the bash 4 features.

if ! type log_info >/dev/null 2>&1; then
  log_info() { echo "INFO:$1:$2"; }
  log_ok()   { echo "OK:$1:$2"; }
  log_err()  { echo "ERROR:$1:$2" >&2; }
fi

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
