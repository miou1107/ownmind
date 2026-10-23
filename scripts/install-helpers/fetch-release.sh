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
