#!/usr/bin/env bash
# Make sure the installer has a Node.js (v20 or newer) to run on, without a password or a dialog.
#
# A colleague's Mac often has no Node, or an old one, and no admin rights. Instead of asking
# the person to install Homebrew or run an installer, this downloads the official Node LTS
# archive into ~/.ownmind/runtime/ and uses that. A machine that already has a Node of v20 or
# newer keeps using it, and nothing else about its install changes.
#
# Sourced, not run: bootstrap.sh (after it unpacks the release) and install.sh both
# `. ensure-node-runtime.sh` and call `ownmind_ensure_node API_URL KEY`.
#
# Naming and checksum rules must stay identical to shared/node-runtime.js (nodeArchiveName,
# NODE_LTS_MAJOR). Shell cannot import that ES module without node, so
# tests/node-runtime-mac.test.js computes both and compares.
#
# Bash 3.2 compatible (stock macOS): no arrays, no ${var,,}, no associative arrays.
#
# Env overrides (tests and company networks):
#   OWNMIND_DIR          install path (default $HOME/.ownmind)
#   OWNMIND_NODE_SOURCE  server | nodejs: force one download source (default: server, then nodejs)
#   OWNMIND_NODE_DIST    base URL of the nodejs.org dist tree (default https://nodejs.org/dist)

# fetch-release.sh holds the curl conventions (ownmind_curl_auth, OWNMIND_CURL_FLAGS) and the
# log_info/log_ok/log_err fallbacks. It is sourced, not copied, so a flag fixed there is fixed here.
__ownmind_node_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)
# shellcheck source=./fetch-release.sh
. "$__ownmind_node_here/fetch-release.sh"
unset __ownmind_node_here

# The Node line OwnMind runs on. Must equal NODE_LTS_MAJOR in shared/node-runtime.js.
OWNMIND_NODE_LTS_MAJOR=22
OWNMIND_NODE_FLOOR_MAJOR=20

# Major version of `$1 --version`, or nothing when it does not answer a version.
ownmind_node_major() {
  local raw major
  raw=$("$1" --version 2>/dev/null) || return 1
  major=${raw#v}
  major=${major%%.*}
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$major"
}

# Archive name for a version like v22.11.0 and an arch of arm64 or x64. Same shape as
# nodeArchiveName({ os: 'darwin', arch, version }) in shared/node-runtime.js.
ownmind_node_archive_name() {
  printf 'node-%s-darwin-%s.tar.gz\n' "$1" "$2"
}

# arm64 for Apple silicon, x64 for Intel. Prints nothing and fails for anything else.
ownmind_node_arch() {
  case "$(uname -m 2>/dev/null)" in
    arm64|aarch64) echo arm64 ;;
    x86_64) echo x64 ;;
    *) return 1 ;;
  esac
}

# SHA-256 of a file, lower case. shasum ships with macOS; the others cover Linux.
ownmind_node_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print tolower($1)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print tolower($1)}'
  else
    openssl dgst -sha256 "$1" 2>/dev/null | awk '{print tolower($NF)}'
  fi
}

# ownmind_node_check_file FILE EXPECTED_SHA. Deletes FILE and fails when the checksum differs.
ownmind_node_check_file() {
  local got
  got=$(ownmind_node_sha256 "$1")
  if [ -z "$got" ] || [ "$got" != "$(printf '%s' "$2" | tr 'A-F' 'a-f')" ]; then
    rm -f "$1"
    return 1
  fi
}

# ownmind_node_from_server API_URL KEY ARCH FILE
# Streams the archive from the OwnMind server. Sets OWNMIND_NODE_VERSION and
# OWNMIND_NODE_SHA from the response headers (X-Node-Version, X-Sha256).
ownmind_node_from_server() {
  local api="${1%/}" key="$2" arch="$3" dest="$4" hdrs
  [ -n "$api" ] && [ -n "$key" ] || return 1
  hdrs="$dest.headers"
  rm -f "$dest" "$hdrs"
  log_info node "Downloading Node.js from $api"
  # shellcheck disable=SC2086 — $OWNMIND_CURL_FLAGS is a fixed list of curl options, split on purpose
  if ! ownmind_curl_auth "$key" | curl -K - -fsSL $OWNMIND_CURL_FLAGS -D "$hdrs" -o "$dest" \
      "$api/api/install/node?os=darwin&arch=$arch"; then
    rm -f "$dest" "$hdrs"
    return 1
  fi
  # A redirect would leave several header blocks in the file; the last one belongs to the body.
  OWNMIND_NODE_VERSION=$(grep -i '^x-node-version:' "$hdrs" | tail -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '[:space:]')
  OWNMIND_NODE_SHA=$(grep -i '^x-sha256:' "$hdrs" | tail -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '[:space:]')
  rm -f "$hdrs"
  if ! printf '%s' "$OWNMIND_NODE_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    || ! printf '%s' "$OWNMIND_NODE_SHA" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    log_info node "The OwnMind server did not send a version and checksum for Node.js"
    rm -f "$dest"
    return 1
  fi
  ownmind_node_check_file "$dest" "$OWNMIND_NODE_SHA"
}

# ownmind_node_from_nodejs ARCH FILE
# Newest v22.x.y from nodejs.org's index, its archive, and the checksum from SHASUMS256.txt.
ownmind_node_from_nodejs() {
  local arch="$1" dest="$2" dist="${OWNMIND_NODE_DIST:-https://nodejs.org/dist}" index version name sums sha
  dist="${dist%/}"
  rm -f "$dest"
  log_info node "Downloading Node.js from $dist"
  # shellcheck disable=SC2086 — see ownmind_node_from_server
  index=$(curl -fsSL $OWNMIND_CURL_FLAGS "$dist/index.json" 2>/dev/null) || return 1
  version=$(printf '%s\n' "$index" \
    | grep -o "\"version\": *\"v$OWNMIND_NODE_LTS_MAJOR\\.[0-9][0-9]*\\.[0-9][0-9]*\"" \
    | sed 's/.*"\(v[^"]*\)"$/\1/' \
    | sort -t. -k2,2n -k3,3n \
    | tail -n 1 || true)
  [ -n "$version" ] || return 1
  name=$(ownmind_node_archive_name "$version" "$arch")
  # shellcheck disable=SC2086
  sums=$(curl -fsSL $OWNMIND_CURL_FLAGS "$dist/$version/SHASUMS256.txt" 2>/dev/null) || return 1
  sha=$(printf '%s\n' "$sums" | awk -v n="$name" '$2 == n { print $1 }' | head -n 1)
  [ -n "$sha" ] || return 1
  # shellcheck disable=SC2086
  curl -fsSL $OWNMIND_CURL_FLAGS -o "$dest" "$dist/$version/$name" || { rm -f "$dest"; return 1; }
  OWNMIND_NODE_VERSION="$version"
  OWNMIND_NODE_SHA="$sha"
  ownmind_node_check_file "$dest" "$sha"
}

# Export the private runtime for the rest of the install.
ownmind_node_use_private() {
  local runtime="$1"
  export OWNMIND_NODE="$runtime/current/bin/node"
  export OWNMIND_PRIVATE_NODE=1
  case ":$PATH:" in
    *":$runtime/current/bin:"*) ;;
    *) export PATH="$runtime/current/bin:$PATH" ;;
  esac
  mkdir -p "$(dirname "$runtime")" || return 1
  printf '%s\n' "$OWNMIND_NODE" > "$(dirname "$runtime")/.node-path"
}

# ownmind_ensure_node API_URL KEY
# Returns 0 with OWNMIND_NODE set to a Node of v20 or newer; returns 1 after printing
# ERROR / ASK lines when none could be found or downloaded.
ownmind_ensure_node() {
  local api="${1:-}" key="${2:-${OWNMIND_INSTALL_KEY:-}}"
  local base="${OWNMIND_DIR:-$HOME/.ownmind}"
  local runtime="$base/runtime"
  local partial="$runtime/.partial"
  local source="${OWNMIND_NODE_SOURCE:-}"
  local sys_node sys_major sys_ver priv_ver arch version prev got ok

  case "$source" in
    ""|server|nodejs) ;;
    *) log_err node_download "OWNMIND_NODE_SOURCE must be server or nodejs (got: $source)"; return 1 ;;
  esac

  # 1. A Node of v20 or newer on PATH is used as it is.
  sys_node=$(command -v node 2>/dev/null || true)
  if [ -n "$sys_node" ] && sys_major=$(ownmind_node_major "$sys_node") && [ "$sys_major" -ge "$OWNMIND_NODE_FLOOR_MAJOR" ]; then
    sys_ver=$("$sys_node" --version 2>/dev/null)
    if [ "$sys_node" = "$runtime/current/bin/node" ]; then
      # An earlier step of this same install already put the private runtime first on PATH.
      ownmind_node_use_private "$runtime" || return 1
      log_info node "using private Node $sys_ver"
    else
      export OWNMIND_NODE="$sys_node"
      unset OWNMIND_PRIVATE_NODE
      log_info node "using system node $sys_ver"
    fi
    return 0
  fi

  # 2. A private runtime from an earlier install is reused without a download.
  if [ -x "$runtime/current/bin/node" ] && priv_ver=$("$runtime/current/bin/node" --version 2>/dev/null) \
    && sys_major=$(ownmind_node_major "$runtime/current/bin/node") && [ "$sys_major" -ge "$OWNMIND_NODE_FLOOR_MAJOR" ]; then
    ownmind_node_use_private "$runtime" || return 1
    log_info node "using private Node $priv_ver"
    return 0
  fi

  # 3. Download one.
  if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
    log_err node "Node.js v20 or newer is required; install it with your package manager (https://nodejs.org/) and run the install again"
    return 1
  fi
  if ! arch=$(ownmind_node_arch); then
    log_err node_download "No Node.js download exists for this CPU ($(uname -m 2>/dev/null))"
    return 1
  fi
  rm -rf "$partial"
  mkdir -p "$partial" || { log_err node_download "Could not create $partial"; return 1; }

  ok=0
  if [ "$source" != "nodejs" ] && ownmind_node_from_server "$api" "$key" "$arch" "$partial/node.tar.gz"; then
    ok=1
  elif [ "$source" != "server" ]; then
    [ "$source" = "nodejs" ] || log_info node "The OwnMind server did not deliver Node.js; trying nodejs.org"
    if ownmind_node_from_nodejs "$arch" "$partial/node.tar.gz"; then ok=1; fi
  fi
  if [ "$ok" != "1" ]; then
    rm -rf "$partial"
    log_err node_download "Could not download Node.js from the OwnMind server or nodejs.org"
    echo "ASK:no_network:The installer could not download Node.js from the OwnMind server or nodejs.org. Check that this computer is online, then paste the same install message to the AI again."
    return 1
  fi
  version="$OWNMIND_NODE_VERSION"

  mkdir -p "$partial/unpack" || return 1
  if ! tar -xzf "$partial/node.tar.gz" -C "$partial/unpack" --strip-components=1; then
    rm -rf "$partial"
    log_err node_download "Could not unpack the Node.js archive (it may be damaged)"
    return 1
  fi

  prev=$(readlink "$runtime/current" 2>/dev/null || true)
  rm -rf "$runtime/node-$version"
  mv "$partial/unpack" "$runtime/node-$version" || { rm -rf "$partial"; log_err node_download "Could not move Node.js into $runtime"; return 1; }
  ln -sfn "node-$version" "$runtime/current" || { rm -rf "$partial" "$runtime/node-$version"; return 1; }
  got=$("$runtime/current/bin/node" --version 2>/dev/null || true)
  if [ "$got" != "$version" ]; then
    # Put things back the way they were before this attempt.
    rm -rf "$runtime/node-$version" "$partial"
    if [ -n "$prev" ]; then ln -sfn "$prev" "$runtime/current"; else rm -f "$runtime/current"; fi
    log_err node_download "The downloaded Node.js did not run (expected $version, got ${got:-nothing})"
    echo "ASK:no_network:The installer could not download a working Node.js. Check that this computer is online, then paste the same install message to the AI again."
    return 1
  fi
  rm -rf "$partial"

  ownmind_node_use_private "$runtime" || return 1
  log_ok node "private Node $version installed"
  return 0
}
