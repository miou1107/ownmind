#!/usr/bin/env node
/**
 * hooks/lib/sync-memory-files.js
 *
 * 把 OwnMind 雲端 memories 鏡射到本地 `<memoryDir>/` 的 md 檔 + MEMORY.md index。
 *
 * 使用情境：SessionStart hook 呼叫 `/api/memory/sync`，把 JSON 從 stdin 餵進來；
 * 或用 `--fail` 模式標記最近一次同步失敗。
 *
 * CLI usage:
 *   cat sync.json | node sync-memory-files.js
 *   node sync-memory-files.js --fail
 *
 * 必要 env：CLAUDE_PROJECT_DIR（否則 silent exit — 非 Claude Code 情境不做事）。
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

export function buildMemoryIndex(entries, serverTime, syncFailed) {
  const lines = [];
  lines.push(`${AUTO_MARKER_PREFIX} ${serverTime} -->`);
  if (syncFailed) {
    lines.push(`${FAIL_MARKER_PREFIX} ${serverTime}, local may be stale -->`);
  }
  lines.push('');
  lines.push('# Memory Index');
  lines.push('');
  lines.push('由 OwnMind SessionStart hook 自動從雲端同步；請勿手動編輯 — 會被下次 sync 覆蓋。');
  lines.push('需要修改內容？用 `ownmind_update` MCP 工具改雲端，或到 Admin UI。');
  lines.push('');

  const byType = {};
  for (const e of entries) (byType[e.type] ||= []).push(e);

  for (const type of SYNCABLE_TYPES) {
    const items = byType[type];
    if (!items || items.length === 0) continue;
    lines.push(`## ${TYPE_LABELS[type]}`);
    for (const e of items) {
      const d = shortDate(e.updated_at);
      lines.push(`- [${e.title || '(untitled)'}](${e.filename})${d ? ` — updated ${d}` : ''}`);
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
      '⚠️ Sync failed — 本地記憶可能過期。檢查 OwnMind server 連線後重新開 session 以同步。',
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
  return String(projectPath).replace(/[\\/]/g, '-');
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
