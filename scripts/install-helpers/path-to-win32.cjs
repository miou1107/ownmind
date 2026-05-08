// scripts/install-helpers/path-to-win32.cjs
//
// MSYS / Cygwin path ↔ Win32 path 雙向轉換。非 Windows 平台 no-op。
//
// 為什麼要這個 helper：
//   Git Bash 的 $HOME 是 MSYS 格式（/c/Users/Adam）。
//   Win32 native binary（node.exe、powershell.exe）的 path 解析器不認 /c/，
//   結果像 verify-upgrade.sh:49 的 `node -p "require('${HOME}/.ownmind/...')"` 在
//   Git Bash 內跑會吐 MODULE_NOT_FOUND（Adam 案例）。餵 native binary 之前用
//   toWin32Path 正規化即可。

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
