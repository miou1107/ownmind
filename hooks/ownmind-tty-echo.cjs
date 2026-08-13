#!/usr/bin/env node
/**
 * OwnMind Banner Echo Hook (v1.17.71, channel rebuilt v1.26.171)
 *
 * Purpose (3 specs):
 *   1. Every OwnMind action (memory read/write, iron rule trigger, compliance report, broadcast)
 *      must be visible to the user.
 *   2. Multiple banners triggered in the same call are merged into one brand block (no prefix repetition).
 *   3. The AI must not be able to filter or swallow them.
 *
 * Why this hook exists:
 *   Claude Code folds MCP tool results into a card the user doesn't see; the AI often swallows
 *   them without quoting. We intercept tool results from the PostToolUse hook, pick lines that
 *   start with "[OwnMind vX.Y.Z] XXX: YYY", and put them in front of the human.
 *
 * Channel (v1.26.171): a single `{"systemMessage": ...}` JSON object on stdout, exit 0 — the
 * one channel Claude Code documents as rendering to the human for every hook event, and one
 * the model never sees, which is what spec #3 always wanted. The original design opened
 * /dev/tty (or \\.\CONOUT$), but a hook subprocess has no controlling terminal on any
 * platform, so that write failed on every call this hook ever made; everything landed in the
 * fallback spool, which nothing read once the session-start flush was removed (it fed the
 * spool into the model's context, not the user's eyes).
 *
 * ~/.ownmind/logs/banner-pending.jsonl remains as the audit record of every block emitted.
 *
 * Always exit 0, never block the tool flow. stdout carries either the one JSON object or
 * nothing at all; stderr is never written.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

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
    writeFallback(block);
    try {
      process.stdout.write(JSON.stringify({ systemMessage: block }));
    } catch { /* the block is already in the audit spool */ }
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
 * Audit record: append to ~/.ownmind/logs/banner-pending.jsonl (JSON Lines).
 * Nothing flushes this file anymore; it exists so what was shown can be checked later.
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
