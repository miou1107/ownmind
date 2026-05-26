#!/usr/bin/env node
/**
 * report-error.cjs — unified error-reporting helper (v1.17.79, IR-038 observability pipeline).
 *
 * Called on any install / upgrade / hook / scanner / start.cmd failure; writes error info to
 * ~/.ownmind/logs/errors/<unix_ms>-<kind>.json. The next self-check run calls drainErrorSpool,
 * POSTs to /api/debug/install-check, and deletes the file on success.
 *
 * Usage (callable from .sh / .ps1 / .cjs):
 *   node report-error.cjs --kind=<kind> --detail=<detail> [--context-file=<path>]
 *
 * Design principles:
 *   - Never throws (every error is swallowed; must not affect the caller's exit code).
 *   - HOME path auto-sanitized to ~ (PII-friendly).
 *   - context-file takes the tail 30 lines (avoid uploading huge files).
 *   - Atomic file write (tmp + rename).
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
  // Replace HOME + also handle case-insensitive USERPROFILE on Windows.
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

  // Ensure the errors directory exists; on failure, give up (user disk may be full —
  // do not compound the problem).
  try {
    fs.mkdirSync(ERRORS_DIR, { recursive: true });
  } catch {
    return;
  }

  const tsMs = Date.now();
  const tsIso = new Date(tsMs).toISOString();
  // Safe kind: only [a-zA-Z0-9_] allowed.
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
    // Give up if we can't write (avoid affecting the caller).
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

if (require.main === module) {
  try {
    writeReport(parseArgs(process.argv));
  } catch {
    // Never block the caller.
  }
  process.exit(0);
}

module.exports = { writeReport, parseArgs, sanitizePath, readContextTail };
