#!/usr/bin/env node
/**
 * v1.17.71 — install-time helper：把 OwnMind PostToolUse hook 寫進 ~/.claude/settings.json
 *
 * 目的：讓 OwnMind tool result 的 banner 能繞過 Claude Code UI、直接到 user terminal。
 *
 * 行為（idempotent）：
 *   - settings.json 不存在 → 建立含 hooks 區塊的新檔案
 *   - 存在但沒 hooks 區塊 → 加上去
 *   - 存在且有 PostToolUse 但沒 OwnMind hook → 在 PostToolUse array 末尾追加
 *   - 存在且已有 OwnMind hook → 不動，回報 "skipped"
 *
 * 寫入前 backup 到 settings.json.bak.<ts>，失敗 rollback。
 *
 * 用法：
 *   node add-post-tool-use-hook.cjs <settings.json path> [--ownmind-dir <path>]
 *
 * Exit codes：
 *   0  — 成功（含 skipped）
 *   1  — 失敗（已 rollback）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MATCHER = 'mcp__ownmind__.*';
// 識別 hook 是否已存在的方式：command 字串中包含 'ownmind-tty-echo'。
// 不用獨立的 name 欄位，因為 Claude Code 官方 hook schema 只有 type + command + timeout，
// 額外欄位實際雖被容忍但不該依賴。
const HOOK_IDENTIFIER_SUBSTR = 'ownmind-tty-echo';

function buildHookEntry(ownmindDir) {
  // command path 用絕對路徑 + node 直接呼叫，避免 PATH 解析問題
  // 目錄字串可能含空白 → 用雙引號包起來，shell 才能正確解析
  const hookPath = path.join(ownmindDir, 'hooks', 'ownmind-tty-echo.cjs');
  const cmd = `node "${hookPath}"`;
  return {
    matcher: MATCHER,
    hooks: [
      { type: 'command', command: cmd },
    ],
  };
}

/**
 * @returns {{ status: 'created' | 'added' | 'skipped' | 'error', message?: string }}
 */
function addHook(settingsPath, ownmindDir) {
  const entry = buildHookEntry(ownmindDir);
  let raw = '';
  let existed = false;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
    existed = true;
  } catch (e) {
    if (e.code !== 'ENOENT') return { status: 'error', message: `讀取失敗：${e.message}` };
  }

  let settings;
  if (existed && raw.trim()) {
    try { settings = JSON.parse(raw); }
    catch (e) { return { status: 'error', message: `JSON parse 失敗：${e.message}` }; }
  } else {
    settings = {};
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.PostToolUse)) {
    settings.hooks.PostToolUse = [];
  }

  // 檢查是否已存在（idempotent）：找有沒有 hook.command 含 ownmind-tty-echo
  const alreadyAdded = settings.hooks.PostToolUse.some((group) => {
    if (!group || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((h) => {
      if (!h || typeof h.command !== 'string') return false;
      return h.command.includes(HOOK_IDENTIFIER_SUBSTR);
    });
  });
  if (alreadyAdded) {
    return { status: 'skipped', message: '已存在' };
  }

  settings.hooks.PostToolUse.push(entry);

  // backup 既有檔（如果存在）
  let backupPath = null;
  if (existed) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${settingsPath}.bak.${ts}`;
    try { fs.copyFileSync(settingsPath, backupPath); }
    catch (e) { return { status: 'error', message: `backup 失敗：${e.message}` }; }
  }

  // atomic write：tmp + rename
  const tmpPath = `${settingsPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    // rollback：tmp 清掉、backup 還原
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (backupPath) {
      try { fs.copyFileSync(backupPath, settingsPath); } catch { /* ignore */ }
    }
    return { status: 'error', message: `寫入失敗：${e.message}` };
  }

  return { status: existed ? 'added' : 'created', message: backupPath ? `backup: ${backupPath}` : '' };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('用法：node add-post-tool-use-hook.cjs <settings.json path> [--ownmind-dir <path>]');
    process.exit(1);
  }
  const settingsPath = args[0];
  let ownmindDir = path.join(process.env.HOME || process.env.USERPROFILE, '.ownmind');
  const idx = args.indexOf('--ownmind-dir');
  if (idx >= 0 && args[idx + 1]) ownmindDir = args[idx + 1];

  const result = addHook(settingsPath, ownmindDir);
  if (result.status === 'error') {
    console.error(`[add-post-tool-use-hook] ERROR: ${result.message}`);
    process.exit(1);
  }
  console.log(`[add-post-tool-use-hook] ${result.status}${result.message ? ' (' + result.message + ')' : ''}`);
  process.exit(0);
}

module.exports = { addHook, buildHookEntry, MATCHER, HOOK_IDENTIFIER_SUBSTR };
