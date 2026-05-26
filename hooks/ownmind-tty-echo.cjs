#!/usr/bin/env node
/**
 * OwnMind TTY Echo Hook (v1.17.71)
 *
 * Purpose (Vin's 3 specs):
 *   1. Every OwnMind action (memory read/write, iron rule trigger, compliance report, broadcast)
 *      must be visible to the user.
 *   2. Multiple banners triggered in the same call are merged into one brand block (no prefix repetition).
 *   3. MUST NOT be filtered or swallowed by the AI — never write stderr / stdout / additionalContext.
 *
 * Why this hook exists:
 *   Claude Code folds MCP tool results into a card the user doesn't see; the AI often swallows
 *   them without quoting. We intercept tool results from the PostToolUse hook, pick lines that
 *   start with "[OwnMind vX.Y.Z] XXX: YYY", and write them directly to the user terminal device,
 *   bypassing the Claude Code hook output system.
 *
 * Primary path (Mac/Linux): open /dev/tty for writing.
 * Primary path (Windows):   open \\.\CONOUT$ for writing.
 * Fallback: write to ~/.ownmind/logs/banner-pending.jsonl; next SessionStart hook flushes it.
 *
 * Always exit 0, never block the tool flow. Never writes stdout / stderr (those get captured by the AI channel).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Test switches:
// OWNMIND_TTY_FORCE_FALLBACK=1 → skip the tty primary path, force the fallback.
// OWNMIND_TTY_OVERRIDE=<path>  → use this path as the tty target (e.g. point to a fake tty in tests).
const FORCE_FALLBACK = process.env.OWNMIND_TTY_FORCE_FALLBACK === '1';
const TTY_OVERRIDE = process.env.OWNMIND_TTY_OVERRIDE || '';

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'banner-pending.jsonl');

main();

async function main() {
  try {
    const input = await readStdin();
    const banners = extractBanners(input);
    if (banners.length === 0) {
      // No banner — don't pollute anything.
      process.exit(0);
      return;
    }
    const block = formatBlock(banners);
    if (!block) {
      process.exit(0);
      return;
    }
    const wrote = !FORCE_FALLBACK && writeToTty(block);
    if (!wrote) {
      writeFallback(block);
    }
  } catch {
    // Always exit 0, never crash.
  }
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) {
      // No one is feeding stdin — don't block.
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    // Safety net: if no data within 1 second, give up.
    setTimeout(() => resolve(buf), 1000).unref();
  });
}

/**
 * Extract all "[OwnMind vX.Y.Z] XXX: YYY" + "📢 OwnMind ..." banners from the hook input JSON.
 *
 * @param {string} rawJson  Claude Code hook stdin JSON
 * @returns {Array<{ kind: 'banner', version: string, eventLine: string } |
 *                 { kind: 'broadcast', text: string }>}
 */
function extractBanners(rawJson) {
  let parsed;
  try { parsed = JSON.parse(rawJson || '{}'); }
  catch { return []; }

  // Claude Code PostToolUse empirically sends two tool_response shapes:
  //   (A) plain array:     tool_response: [{type, text}, ...]    ← MCP tools take this path
  //   (B) wrapped content: tool_response: { content: [...] }     ← other tools / older versions
  // v1.17.71 only handled (B), which is why prod MCP banners weren't picked up. Support both.
  const tr = parsed.tool_response || parsed.toolResponse || {};
  let contentParts;
  if (Array.isArray(tr)) {
    contentParts = tr;
  } else if (Array.isArray(tr.content)) {
    contentParts = tr.content;
  } else {
    contentParts = [];
  }
  const fullText = contentParts
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
  if (!fullText) return [];

  const lines = fullText.split('\n');
  const banners = [];

  // Broadcast block: 📢 OwnMind system notice ... until ---
  let broadcastBuf = null;
  for (const line of lines) {
    if (broadcastBuf) {
      broadcastBuf.push(line);
      if (line.trim() === '---') {
        banners.push({ kind: 'broadcast', text: broadcastBuf.join('\n') });
        broadcastBuf = null;
      }
      continue;
    }
    if (line.startsWith('📢 OwnMind')) {
      broadcastBuf = [line];
      continue;
    }
    // Match both legacy 【】 brand banner and new [] format (v1.22.0+).
    // Some product files still emit 【】 until their own i18n pass lands.
    const m = line.match(/^(?:【OwnMind\s+(v[\d.]+)】|\[OwnMind\s+(v[\d.]+)\]\s*)(.+?)\s*$/);
    if (m) {
      const version = m[1] || m[2];
      const eventLine = m[3];
      banners.push({ kind: 'banner', version, eventLine });
    }
  }
  // Treat an unterminated broadcast as valid too (safety).
  if (broadcastBuf && broadcastBuf.length > 1) {
    banners.push({ kind: 'broadcast', text: broadcastBuf.join('\n') });
  }
  return banners;
}

/**
 * Merge banner array into a single brand block.
 *
 * Format:
 *   📢 OwnMind system notice (if any)
 *   ...
 *   ---
 *
 *   [OwnMind v1.17.71]
 *     Memory search
 *     Tip: you can search memory
 */
function formatBlock(banners) {
  if (!Array.isArray(banners) || banners.length === 0) return null;

  const out = [];

  // Broadcast block first.
  for (const b of banners) {
    if (b.kind === 'broadcast') {
      out.push(b.text);
      out.push('');
    }
  }

  // Merge OwnMind banners into "brand header + indented list".
  const eventBanners = banners.filter((b) => b.kind === 'banner');
  if (eventBanners.length > 0) {
    const version = eventBanners[0].version || '';
    out.push(`[OwnMind ${version}]`);
    for (const b of eventBanners) {
      // Strip a trailing standalone "：" (multi-line events like "Memory search:" end with colon + newline).
      const cleaned = b.eventLine.replace(/：\s*$/, '');
      out.push(`  ${cleaned}`);
    }
  }
  if (out.length === 0) return null;
  return out.join('\n');
}

/**
 * Attempt to write to the user terminal device. Returns true on success, false on failure.
 * MUST NOT write to stderr / stdout (Claude Code treats those as the hook channel → AI sees them).
 */
function writeToTty(block) {
  const ttyPath = TTY_OVERRIDE || (process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty');
  let fd = null;
  try {
    fd = fs.openSync(ttyPath, 'a');
    fs.writeSync(fd, '\n' + block + '\n');
    fs.closeSync(fd);
    return true;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return false;
  }
}

/**
 * Fallback: write to ~/.ownmind/logs/banner-pending.jsonl; next SessionStart flushes it.
 * One JSON record per line (JSON Lines format).
 *
 * MUST NOT write to stderr / stdout (spec #3: must not be filtered by the AI).
 */
// Prevent unbounded growth: when banner-pending.jsonl exceeds 1 MB, rotate to .old (overwriting previous .old).
// 1 MB ≈ 10k records — far above any reasonable backlog.
// Scenario: a non-tty long-running script never reaches the next SessionStart flush → file would grow forever.
const PENDING_FILE_MAX_BYTES = 1024 * 1024;

function writeFallback(block) {
  try {
    const dir = path.dirname(PENDING_FILE);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const stat = fs.statSync(PENDING_FILE);
      if (stat.size > PENDING_FILE_MAX_BYTES) {
        try { fs.renameSync(PENDING_FILE, PENDING_FILE + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file does not exist → no rotate needed */ }
    const record = { ts: new Date().toISOString(), block };
    fs.appendFileSync(PENDING_FILE, JSON.stringify(record) + '\n');
  } catch {
    // Even the fallback failed — give up; never write to stderr.
  }
}
