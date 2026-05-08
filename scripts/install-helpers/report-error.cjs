#!/usr/bin/env node
/**
 * report-error.cjs — 統一錯誤回報 helper（v1.17.79, IR-038 觀測管道）
 *
 * 任何 install / upgrade / hook / scanner / start.cmd 失敗時呼叫，把錯誤資訊寫到
 * ~/.ownmind/logs/errors/<unix_ms>-<kind>.json。下次 self-check 跑會 drainErrorSpool
 * 一次 POST 給 /api/debug/install-check 並刪除已上傳的檔案。
 *
 * 用法（從 .sh / .ps1 / .cjs 都可以叫）：
 *   node report-error.cjs --kind=<kind> --detail=<detail> [--context-file=<path>]
 *
 * 設計原則：
 *   - 永不 throw（任何錯誤都吞掉，不能影響 caller 的退出碼）
 *   - HOME 路徑自動 sanitize 成 ~（PII 友善）
 *   - context-file 取尾 30 行（避免暴量上傳）
 *   - 檔案 atomic write（先寫 .tmp 再 rename）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ERRORS_DIR = path.join(HOME, '.ownmind', 'logs', 'errors');

function parseArgs(argv) {
  const args = { kind: null, detail: '', contextFile: null };
  for (const a of argv.slice(2)) {
    let m;
    if ((m = a.match(/^--kind=(.+)$/))) args.kind = m[1];
    else if ((m = a.match(/^--detail=(.+)$/s))) args.detail = m[1];
    else if ((m = a.match(/^--context-file=(.+)$/))) args.contextFile = m[1];
  }
  return args;
}

function sanitizePath(s) {
  if (typeof s !== 'string') return String(s ?? '');
  // HOME 替換 + 也順便處理 Windows 大小寫不敏感的 USERPROFILE
  let out = s;
  if (HOME) out = out.split(HOME).join('~');
  const up = process.env.USERPROFILE;
  if (up && up !== HOME) out = out.split(up).join('~');
  return out;
}

function readPackageVersion() {
  try {
    const p = path.join(HOME, '.ownmind', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectPlatform() {
  switch (process.platform) {
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    case 'win32': return 'win32';
    default: return process.platform;
  }
}

function readContextTail(contextFile, maxLines = 30, maxBytes = 8192) {
  if (!contextFile) return '';
  try {
    if (!fs.existsSync(contextFile)) return '';
    const raw = fs.readFileSync(contextFile, 'utf8');
    const trimmed = raw.length > maxBytes ? raw.slice(-maxBytes) : raw;
    const lines = trimmed.split(/\r?\n/);
    const tail = lines.slice(-maxLines).join('\n');
    return sanitizePath(tail);
  } catch {
    return '';
  }
}

function writeReport(args) {
  if (!args.kind) return;

  // 確保 errors 目錄存在；失敗就放棄（user 磁碟可能滿了，不能再爆）
  try {
    fs.mkdirSync(ERRORS_DIR, { recursive: true });
  } catch {
    return;
  }

  const tsMs = Date.now();
  const tsIso = new Date(tsMs).toISOString();
  // 安全 kind：只允許 [a-zA-Z0-9_]
  const safeKind = String(args.kind).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);

  const report = {
    ts: tsIso,
    kind: safeKind,
    detail: sanitizePath(args.detail || ''),
    context: readContextTail(args.contextFile),
    client_version: readPackageVersion(),
    platform: detectPlatform(),
    machine: (() => { try { return os.hostname(); } catch { return 'unknown'; } })(),
  };

  const finalName = `${tsMs}-${safeKind}.json`;
  const finalPath = path.join(ERRORS_DIR, finalName);
  const tmpPath = `${finalPath}.tmp`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2));
    fs.renameSync(tmpPath, finalPath);
  } catch {
    // 寫不出來就放棄（避免影響 caller）
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

if (require.main === module) {
  try {
    writeReport(parseArgs(process.argv));
  } catch {
    // 永不擋 caller
  }
  process.exit(0);
}

module.exports = { writeReport, parseArgs, sanitizePath, readContextTail };
