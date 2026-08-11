#!/usr/bin/env node
/**
 * Keep an OwnMind-managed block inside a file the user also owns.
 *
 * One implementation for every platform. The same job used to be written twice — once in
 * `update.sh` and once in `update.ps1` — and the two drifted: v1.26.140 found the PowerShell
 * copy throwing on an empty file while the shell copy handled it, and neither reported the
 * failure. A block that has to be identical on three operating systems belongs in the one
 * runtime all three already depend on.
 *
 *   node sync-rules-block.cjs --target <file> --marker <name> --snippet <file> [--legacy-claude]
 *
 * Exit code 0, with one line on stdout:
 *   written:<path>     the block is present and current
 *   skipped:<path>     the tool is not installed (its directory does not exist)
 *   legacy-kept:<path> an old unmarked block was edited by hand and was left alone
 * Exit code 1 with `error:<path>:<reason>` on stderr for anything else.
 *
 * Why a marker rather than "append once": `install.sh` used to write this content with a
 * heredoc and then skip the file forever after, on the strength of the word "OwnMind"
 * appearing in it. Every machine's copy therefore froze on its install date — measured
 * 2026-08-11, one machine was still carrying a four-line block that had been superseded
 * three times. A rule nobody can update is a rule that is wrong later.
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { legacyClaude: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') out.target = argv[++i];
    else if (argv[i] === '--marker') out.marker = argv[++i];
    else if (argv[i] === '--snippet') out.snippet = argv[++i];
    else if (argv[i] === '--legacy-claude') out.legacyClaude = true;
  }
  return out;
}

/**
 * The unmarked block `install.sh` and `install.ps1` used to append, in every wording they
 * have shipped. Matching is exact and line-wise: a machine whose block is one of these was
 * never touched by its owner, so replacing it loses nothing. Anything else is treated as
 * hand-written and left in place — the file this lives in is where people keep their own
 * rules, and silently eating those would be a far worse failure than a duplicated heading.
 */
const LEGACY_LINES = new Set([
  '# OwnMind 個人記憶系統',
  'OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。',
  '如果 context 中沒有看到【OwnMind vX.X.X】標記，手動呼叫 ownmind_init MCP tool。',
  '如果 context 中沒有看到【OwnMind v 開頭的標記，手動呼叫 `ownmind_init` MCP tool。',
  '鐵律必須嚴格遵守。衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記。',
  '衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind】標記。',
  '即將違反鐵律時立即停止。觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。',
  '觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。',
  '',
]);

const LEGACY_HEADING = '# OwnMind 個人記憶系統';

/**
 * Find the legacy block: from its heading to the next top-level heading or the end.
 * @returns {{ start: number, end: number, ours: boolean } | null}
 */
function findLegacyBlock(lines) {
  const start = lines.findIndex((l) => l.trim() === LEGACY_HEADING);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^#\s/.test(lines[end])) end += 1;
  const body = lines.slice(start, end);
  // Trailing blank lines belong to the separation between sections, not to the block.
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  const ours = body.every((l) => LEGACY_LINES.has(l.trim()));
  return { start, end, ours };
}

function blockRegex(marker) {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\n*<!--\\s*${m}\\s*-->[\\s\\S]*?<!--\\s*/${m}\\s*-->\\n?`, 'g');
}

function main() {
  const { target, marker, snippet, legacyClaude } = parseArgs(process.argv.slice(2));
  if (!target || !marker || !snippet) {
    process.stderr.write('error::usage: --target <file> --marker <name> --snippet <file>\n');
    process.exit(1);
  }

  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    process.stdout.write(`skipped:${target}\n`);
    return;
  }

  let body;
  try {
    body = fs.readFileSync(snippet, 'utf8').replace(/\s+$/, '');
  } catch (err) {
    process.stderr.write(`error:${target}:cannot read ${snippet}: ${err.message}\n`);
    process.exit(1);
  }

  // readFileSync gives '' for an empty file, which is what every caller means. The
  // PowerShell equivalent gave $null and threw on it — v1.26.140.
  let existing = '';
  if (fs.existsSync(target)) {
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch (err) {
      process.stderr.write(`error:${target}:cannot read: ${err.message}\n`);
      process.exit(1);
    }
  }

  let legacyKept = false;
  if (legacyClaude) {
    const lines = existing.split('\n');
    const legacy = findLegacyBlock(lines);
    if (legacy && legacy.ours) {
      lines.splice(legacy.start, legacy.end - legacy.start);
      existing = lines.join('\n');
    } else if (legacy) {
      legacyKept = true;
    }
  }

  existing = existing.replace(blockRegex(marker), '\n');
  const block = `\n<!-- ${marker} -->\n${body}\n<!-- /${marker} -->\n`;
  const next = `${existing.replace(/\s+$/, '')}\n${block}`;

  // Write through a sibling temp file and rename: this file holds the user's own rules, and
  // an interrupted write that truncates it is not recoverable from anything we hold.
  const tmp = `${target}.ownmind.tmp`;
  try {
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    process.stderr.write(`error:${target}:cannot write: ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`${legacyKept ? 'legacy-kept' : 'written'}:${target}\n`);
}

// Guarded: the test suite requires this file to exercise findLegacyBlock directly, and an
// unguarded main() would run — with no arguments — on import.
if (require.main === module) main();

module.exports = { findLegacyBlock, blockRegex, LEGACY_LINES, LEGACY_HEADING };
