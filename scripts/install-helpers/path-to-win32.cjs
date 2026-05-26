// scripts/install-helpers/path-to-win32.cjs
//
// Bidirectional MSYS / Cygwin path ↔ Win32 path conversion. No-op on non-Windows.
//
// Why this helper exists:
//   Git Bash's $HOME is in MSYS format (e.g. /c/Users/Adam). Win32 native binaries
//   (node.exe, powershell.exe) don't recognize the /c/ prefix in their path resolver, so
//   something like verify-upgrade.sh:49's `node -p "require('${HOME}/.ownmind/...')"` would
//   spit MODULE_NOT_FOUND under Git Bash (Adam's case). Normalize the path with
//   toWin32Path before passing it to a native binary.

'use strict';

const MSYS_RE = /^\/([a-zA-Z])(\/.*)?$/;
const WIN32_DRIVE_RE = /^([a-zA-Z]):[\\/]/;

function isMsysPath(p) {
  return typeof p === 'string' && MSYS_RE.test(p);
}

function isWin32Path(p) {
  if (typeof p !== 'string') return false;
  return WIN32_DRIVE_RE.test(p) || p.startsWith('\\\\');
}

function toWin32Path(p) {
  if (process.platform !== 'win32') return p;
  if (typeof p !== 'string') return p;
  if (isWin32Path(p)) return p;
  const m = p.match(MSYS_RE);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = (m[2] || '').replace(/\//g, '\\');
    return `${drive}:${rest || '\\'}`;
  }
  return p;
}

function toMsysPath(p) {
  if (process.platform !== 'win32') return p;
  if (typeof p !== 'string') return p;
  if (p.startsWith('/') && !p.startsWith('//')) return p;
  const m = p.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, '/');
    return `/${drive}/${rest}`;
  }
  return p;
}

module.exports = { toWin32Path, toMsysPath, isMsysPath, isWin32Path };
