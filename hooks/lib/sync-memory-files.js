#!/usr/bin/env node
/**
 * hooks/lib/sync-memory-files.js
 *
 * Mirror OwnMind cloud memories to local md files under `<memoryDir>/` plus a MEMORY.md index.
 *
 * Usage scenarios: the SessionStart hook calls `/api/memory/sync` and pipes the JSON in via stdin;
 * or use `--fail` mode to mark the most recent sync attempt as failed.
 *
 * CLI usage:
 *   cat sync.json | node sync-memory-files.js
 *   node sync-memory-files.js --fail
 *
 * Required env: CLAUDE_PROJECT_DIR (otherwise silent exit — outside Claude Code there's nothing to do).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SYNCABLE_TYPES = ['iron_rule', 'project', 'feedback'];
const TYPE_LABELS = {
  iron_rule: 'Iron Rules',
  project: 'Projects',
  feedback: 'Feedback',
};
const SYNCED_FILE_RE = /^(iron_rule|project|feedback)_\d+_.*\.md$/;
const AUTO_MARKER_PREFIX = '<!-- ownmind-auto-synced at';
const FAIL_MARKER_PREFIX = '<!-- ⚠️ last sync FAILED at';

export function slugTitle(s) {
  const trimmed = String(s || '').trim();
  if (!trimmed) return 'untitled';
  const slug = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60)
    .replace(/^[_-]+|[_-]+$/g, '');
  return slug || 'untitled';
}

export function memoryFilename({ id, type, title }) {
  return `${type}_${id}_${slugTitle(title)}.md`;
}

function shortDate(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

function yamlQuote(s) {
  // YAML single-quoted scalar: only special char is ', escape by doubling
  const str = String(s == null ? '' : s).replace(/[\r\n]/g, ' ');
  return `'${str.replace(/'/g, "''")}'`;
}

function stringifyMemoryMd(mem) {
  const descSource = (mem.content || mem.title || '').split('\n')[0];
  const descLine = descSource.slice(0, 150).trim();
  return [
    '---',
    `name: ${yamlQuote(mem.title)}`,
    `description: ${yamlQuote(descLine)}`,
    `type: ${yamlQuote(mem.type)}`,
    `cloud_id: ${Number.isFinite(Number(mem.id)) ? Number(mem.id) : 0}`,
    `updated_at: ${yamlQuote(mem.updated_at)}`,
    '---',
    '',
    mem.content || '',
    '',
  ].join('\n');
}

// v1.26.100 — the index has to fit the thing that reads it.
//
// Both numbers are the reader's own, quoted from the two warnings it produced on a real
// install on 2026-08-08, where MEMORY.md had grown to 283 lines (143 iron rules + 130
// projects):
//
//   "MEMORY.md is 280 lines and 31.8KB. Only part of it was loaded.
//    Keep index entries to one line under ~200 chars."
//   "over its 200-line read limit ... everything past the limit is silently dropped
//    each time the index is loaded ... Rewrite it to under 140 lines."
//
// The builder had no upper bound, so the file grew with the user's memory count until it
// outgrew the budget, and roughly half of it stopped reaching the session. Nothing marked
// the file and neither side said anything, so it went on reading as a complete index.
//
// Exported so the tests assert against the same constants the builder uses. A second copy
// of the number in the test would let the two drift apart without failing.
export const MEMORY_INDEX_MAX_LINES = 140;
export const MEMORY_INDEX_MAX_ENTRY_CHARS = 200;

// Header block, plus the worst case for every type that is present: heading, omission note,
// trailing blank. Reserving the omission line even for types that turn out to fit costs at
// most one line each and keeps the arithmetic a single pass instead of a fixed point.
//
// The header count always includes the failure marker, whether or not this run is a failed
// one. applyFailMode() inserts that line into an already-written file without going through
// this builder, so a normal sync that filled its budget exactly would be pushed one line
// over the moment the next sync failed. Reserving it costs one entry, permanently.
const INDEX_HEADER_LINES = 7;
const FAIL_MARKER_RESERVED_LINES = 1;
const PER_SECTION_LINES = 3;

// v1.26.101 — iron rules ask for very little of the budget, because their contents already
// reach the session by another route. The SessionStart hook injects every rule, with its
// trigger conditions, directly into the session; an index line for one adds only the link to
// its local file. A project not listed here is not in the session at all.
//
// Sharing purely by entry count therefore spent about half the budget on the duplicate: on
// the measured install, 63 lines of iron rules against 63 of projects, while 67 projects
// went unlisted. With this cap the same data lists 106 projects. The number is a judgement,
// not a measurement: enough that the most recently changed rules are one click away.
export const IRON_RULE_INDEX_CAP = 20;
const TYPE_INDEX_CAP = { iron_rule: IRON_RULE_INDEX_CAP };

// Cut to a UTF-16 budget without splitting a character. `slice` counts code units, so a
// title made of astral characters (emoji, some rarer CJK) gets cut through the middle of a
// surrogate pair whenever the budget lands on an odd offset, leaving a lone surrogate that
// renders as a replacement glyph. Measured before this was added: 12 of 24 filename lengths
// produced one. Iterating the string yields whole code points, so the cut is always legal.
function truncateToWidth(text, maxUnits) {
  if (text.length <= maxUnits) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return out;
}

function indexEntryLine(entry) {
  const date = shortDate(entry.updated_at);
  const tail = `](${entry.filename})${date ? ` — updated ${date}` : ''}`;
  // A title carrying a newline turns one pushed element into several physical lines, and the
  // line budget is counted in pushes. Sixty titles with two newlines each produced a
  // 189-line index. yamlQuote() in this same file already flattens titles for the same
  // reason; this path was missed. The server only trims the ends (src/routes/memory.js), so
  // an interior newline arrives intact.
  const flatTitle = String(entry.title || '').replace(/[\r\n\t\f\v]+/g, ' ').trim();
  // The title is the only part that may be trimmed: a truncated filename would point the
  // reader at a file that does not exist, which is worse than a shortened title. That is
  // also why a filename long enough to eat the whole budget on its own is left over-length
  // rather than cut — memoryFilename() caps the slug at 60, so the longest name it can
  // produce is 84 characters and this cannot happen through the real caller.
  const room = MEMORY_INDEX_MAX_ENTRY_CHARS - '- ['.length - tail.length;
  let title = flatTitle || '(untitled)';
  if (title.length > room) title = room > 1 ? `${truncateToWidth(title, room - 1)}…` : '…';
  return `- [${title}${tail}`;
}

function omissionLine(type, omitted) {
  return `- ${omitted} more not listed here (line budget): see the ${type}_*.md files in this directory, or search with the \`ownmind_search\` MCP tool.`;
}

// Share the entry budget out by need rather than evenly: a type wanting less than its share
// releases the difference to the ones that want more. Without this, a user with four iron
// rules and three hundred projects would see a third of the index sitting empty while
// projects were being dropped.
export function allocateIndexBudget(counts, budget) {
  const alloc = {};
  let pending = Object.keys(counts).filter((t) => counts[t] > 0);
  for (const t of pending) alloc[t] = 0;
  let remaining = Math.max(0, budget);

  while (pending.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / pending.length);
    if (share < 1) {
      // Fewer lines left than types still wanting them: hand out one each, in the declared
      // type order, so the outcome is deterministic rather than dependent on object order.
      for (const t of pending) {
        if (remaining === 0) break;
        alloc[t] += 1;
        remaining -= 1;
      }
      break;
    }
    const satisfied = pending.filter((t) => counts[t] <= share);
    if (satisfied.length === 0) {
      let extra = remaining - share * pending.length;
      for (const t of pending) {
        alloc[t] = share + (extra > 0 ? 1 : 0);
        if (extra > 0) extra -= 1;
      }
      break;
    }
    for (const t of satisfied) {
      alloc[t] = counts[t];
      remaining -= counts[t];
    }
    pending = pending.filter((t) => !satisfied.includes(t));
  }

  return alloc;
}

function byNewestFirst(a, b) {
  const ta = Date.parse(a.updated_at) || 0;
  const tb = Date.parse(b.updated_at) || 0;
  if (tb !== ta) return tb - ta;
  // Stable tiebreak so the same memories produce the same file byte for byte, which keeps
  // an unchanged sync from looking like a change. Ids are serial integers today; the
  // filename comparison is the fallback for anything that is not a number, where the
  // subtraction would yield NaN and leave the order at whatever the caller happened to
  // pass in.
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
  return String(a.filename || '').localeCompare(String(b.filename || ''));
}

export function buildMemoryIndex(entries, serverTime, syncFailed) {
  const lines = [];
  lines.push(`${AUTO_MARKER_PREFIX} ${serverTime} -->`);
  if (syncFailed) {
    lines.push(`${FAIL_MARKER_PREFIX} ${serverTime}, local may be stale -->`);
  }
  lines.push('');
  lines.push('# Memory Index');
  lines.push('');
  lines.push('Auto-synced from the cloud by the OwnMind SessionStart hook; do not edit manually — your changes will be overwritten on the next sync.');
  lines.push('Need to change content? Use the `ownmind_update` MCP tool to edit the cloud copy, or use the Admin UI.');
  lines.push('');

  const byType = {};
  for (const e of entries) (byType[e.type] ||= []).push(e);

  const present = SYNCABLE_TYPES.filter((t) => byType[t] && byType[t].length > 0);
  // The allocator is told how many lines each type will actually accept, not how many
  // entries it has, so a capped type releases the difference like any other type that wants
  // less than its share. The omission note is computed from the real total further down, so
  // a capped type still reports everything it left out.
  const counts = {};
  for (const t of present) {
    const cap = TYPE_INDEX_CAP[t];
    counts[t] = cap == null ? byType[t].length : Math.min(byType[t].length, cap);
  }

  const overhead = INDEX_HEADER_LINES + FAIL_MARKER_RESERVED_LINES + present.length * PER_SECTION_LINES;
  const alloc = allocateIndexBudget(counts, MEMORY_INDEX_MAX_LINES - overhead);

  for (const type of present) {
    const items = byType[type].slice().sort(byNewestFirst);
    const shown = items.slice(0, alloc[type] || 0);
    lines.push(`## ${TYPE_LABELS[type]}`);
    for (const e of shown) lines.push(indexEntryLine(e));
    // An index that quietly stops short reads as a complete index. Say the number.
    if (shown.length < items.length) {
      lines.push(omissionLine(type, items.length - shown.length));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function listSyncedFiles(memoryDir) {
  try {
    return fs.readdirSync(memoryDir).filter((f) => SYNCED_FILE_RE.test(f));
  } catch {
    return [];
  }
}

function applyFailMode(memoryIndexPath) {
  const now = new Date().toISOString();
  let existing = '';
  try { existing = fs.readFileSync(memoryIndexPath, 'utf8'); } catch {}

  if (existing.includes('⚠️ last sync FAILED')) return;

  if (existing.includes(AUTO_MARKER_PREFIX)) {
    const updated = existing.replace(
      /(<!-- ownmind-auto-synced at [^>]*-->)/,
      `$1\n${FAIL_MARKER_PREFIX} ${now}, local may be stale -->`
    );
    fs.writeFileSync(memoryIndexPath, updated);
    return;
  }

  if (existing.trim().length > 0) {
    fs.writeFileSync(
      memoryIndexPath,
      `${FAIL_MARKER_PREFIX} ${now}, local may be stale -->\n\n${existing}`
    );
    return;
  }

  fs.writeFileSync(
    memoryIndexPath,
    [
      `${AUTO_MARKER_PREFIX} ${now} -->`,
      `${FAIL_MARKER_PREFIX} ${now}, local may be stale -->`,
      '',
      '# Memory Index',
      '',
      '⚠️ Sync failed — local memory may be stale. Check your connection to the OwnMind server, then open a new session to re-sync.',
      '',
    ].join('\n')
  );
}

export function syncMemoryFiles({ memoryDir, data, sync_failed = false } = {}) {
  if (!memoryDir) throw new Error('syncMemoryFiles: memoryDir required');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryIndexPath = path.join(memoryDir, 'MEMORY.md');

  if (sync_failed) {
    applyFailMode(memoryIndexPath);
    return;
  }

  if (!data || !Array.isArray(data.memories)) {
    throw new Error('syncMemoryFiles: data.memories required in normal mode');
  }

  try {
    const existing = fs.readFileSync(memoryIndexPath, 'utf8');
    if (!existing.includes(AUTO_MARKER_PREFIX)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(
        path.join(memoryDir, `MEMORY.md.pre-sync-backup-${ts}`),
        existing
      );
    }
  } catch {}

  const activeEntries = [];
  for (const mem of data.memories) {
    if (mem.status === 'disabled') continue;
    activeEntries.push({ ...mem, filename: memoryFilename(mem) });
  }

  for (const entry of activeEntries) {
    fs.writeFileSync(path.join(memoryDir, entry.filename), stringifyMemoryMd(entry));
  }

  const activeFilenames = new Set(activeEntries.map((e) => e.filename));
  for (const f of listSyncedFiles(memoryDir)) {
    if (activeFilenames.has(f)) continue;
    try { fs.rmSync(path.join(memoryDir, f), { force: true }); } catch {}
  }

  fs.writeFileSync(memoryIndexPath, buildMemoryIndex(activeEntries, data.server_time, false));
}

export function projectSlugFromPath(projectPath) {
  // v1.26.119 — the colon has to go too, and this is a product bug rather than a test one.
  // On Windows a project path starts `C:\`, and a colon cannot appear in a directory name
  // there at all — NTFS reads it as the alternate-data-stream separator. So mkdir failed
  // (measured on TANK: ENOENT, Windows collapsing yet another shape into that one errno —
  // see the note in shared/scanners/sqlite-cli.js), the write was swallowed, and the
  // SessionStart hook **never wrote a single memory
  // file on Windows** — which is exactly what the v1.26.83 comment in the caller says it
  // exists to prevent ("on Windows was never"), fixed everywhere except in the slug.
  //
  // `C:\Users\Alex\X` -> `C--Users-Alex-X`, which is the spelling Claude Code itself uses
  // for its project directories, so the files land where the AI already looks. POSIX paths
  // carry no colon, so nothing changes there.
  return String(projectPath).replace(/[\\/:]/g, '-');
}

export function resolveMemoryDir({ claudeProjectDir, home }) {
  if (!claudeProjectDir) return null;
  return path.join(home, '.claude', 'projects', projectSlugFromPath(claudeProjectDir), 'memory');
}

async function readStdin() {
  return await new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const failMode = argv.includes('--fail');

  const memoryDir = resolveMemoryDir({
    claudeProjectDir: process.env.CLAUDE_PROJECT_DIR,
    home: os.homedir(),
  });
  if (!memoryDir) return;

  if (failMode) {
    syncMemoryFiles({ memoryDir, sync_failed: true });
    return;
  }

  const raw = await readStdin();
  if (!raw.trim()) {
    syncMemoryFiles({ memoryDir, sync_failed: true });
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    syncMemoryFiles({ memoryDir, sync_failed: true });
    return;
  }
  if (!data || !Array.isArray(data.memories)) {
    syncMemoryFiles({ memoryDir, sync_failed: true });
    return;
  }
  syncMemoryFiles({ memoryDir, data });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => process.exit(0));
}
