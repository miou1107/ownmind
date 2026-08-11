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
  // Any heading level, not just `# `. Appending a section to the bottom of CLAUDE.md is the
  // normal way people edit it, and a `## ` heading after the old block used to make the
  // whole thing look hand-edited — so the migration skipped it and the note printed on every
  // upgrade, forever, on a large share of machines.
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1;
  const body = lines.slice(start, end);
  // Trailing blank lines belong to the separation between sections, not to the block.
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  const ours = body.every((l) => LEGACY_LINES.has(l.trim()));
  return { start, end, ours };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove our own block, line by line rather than with a regex spanning the file.
 *
 * A regex spanning from the opening marker to the closing one deletes whatever sits between
 * them — which is correct only while the markers are a matched pair. They are not always:
 * a CLAUDE.md synced between two machines through a dotfiles repo can come out of a merge
 * with one marker and no partner. Measured on the first version of this file: an orphaned
 * opener plus a real block two paragraphs later, and the second run silently ate the user's
 * own rules in between — exit 0, output `written:`.
 *
 * So a marker only ever removes a region it is genuinely paired with. A dangling marker
 * costs one line, which is ours, and the caller is told.
 *
 * @returns {{ text: string, orphan: boolean }}
 */
function stripBlocks(text, marker) {
  const open = new RegExp(`^\\s*<!--\\s*${esc(marker)}\\s*-->\\s*$`);
  const close = new RegExp(`^\\s*<!--\\s*/${esc(marker)}\\s*-->\\s*$`);
  const lines = text.split('\n');
  const out = [];
  let orphan = false;
  let i = 0;

  while (i < lines.length) {
    if (open.test(lines[i])) {
      // Scan for this opener's partner. Another opener first means this one never had one.
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j]) && !open.test(lines[j])) j += 1;
      if (j < lines.length && close.test(lines[j])) {
        i = j + 1;          // a matched pair: drop it and everything it wraps
        continue;
      }
      orphan = true;
      i += 1;               // dangling opener: drop this line only, keep what follows
      continue;
    }
    if (close.test(lines[i])) {
      orphan = true;
      i += 1;               // dangling closer: also ours, also one line
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }

  return { text: out.join('\n'), orphan };
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

  // Follow a symlink to the file it points at, and write THERE.
  //
  // Keeping config files in one directory and symlinking them into place is how people move
  // a setup between machines. rename() onto the link replaces the link with a regular file:
  // the real copy is orphaned, stops receiving anything, and nothing says so. Measured on the
  // first version of this file.
  let realTarget = target;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) realTarget = fs.realpathSync(target);
  } catch {
    // Not there yet — realTarget stays as given, and the write creates it.
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
  if (fs.existsSync(realTarget)) {
    try {
      existing = fs.readFileSync(realTarget, 'utf8');
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

  const stripped = stripBlocks(existing, marker);
  const block = `\n<!-- ${marker} -->\n${body}\n<!-- /${marker} -->\n`;
  const next = `${stripped.text.replace(/\s+$/, '')}\n${block}`;

  // Write through a sibling temp file and rename: this file holds the user's own rules, and
  // an interrupted write that truncates it is not recoverable from anything we hold. The temp
  // sits next to the REAL target so the rename stays within one filesystem.
  const tmp = path.join(path.dirname(realTarget), `.${path.basename(realTarget)}.ownmind.tmp`);
  try {
    // A fresh file inherits the process umask; an existing one keeps whatever the user set.
    // Without this, a CLAUDE.md they had chmod'ed to 600 comes back 644 after an upgrade.
    let mode;
    try { mode = fs.statSync(realTarget).mode & 0o777; } catch { /* new file */ }
    fs.writeFileSync(tmp, next, 'utf8');
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, realTarget);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    process.stderr.write(`error:${target}:cannot write: ${err.message}\n`);
    process.exit(1);
  }

  const status = legacyKept ? 'legacy-kept' : (stripped.orphan ? 'repaired' : 'written');
  process.stdout.write(`${status}:${target}\n`);
}

// Guarded: the test suite requires this file to exercise findLegacyBlock directly, and an
// unguarded main() would run — with no arguments — on import.
if (require.main === module) main();

module.exports = { findLegacyBlock, stripBlocks, LEGACY_LINES, LEGACY_HEADING };
