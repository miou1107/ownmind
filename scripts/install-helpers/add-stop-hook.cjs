#!/usr/bin/env node
/**
 * v1.17.96 — install-time helper：把 OwnMind Stop hook 寫進 ~/.claude/settings.json
 *
 * 目的：每輪 AI 回話結束時自動跑 hooks/ownmind-reply-lint.js，掃 IR-037 / IR-036
 *      違反、把 banner 印到 user terminal、報合規數據。
 *
 * 設計沿用 v1.17.71 add-post-tool-use-hook.cjs 同款 idempotent 合併語意：
 *   - settings.json 不存在 → 建立含 hooks 區塊的新檔案
 *   - 存在但沒 hooks 區塊 → 加上去
 *   - 存在且有 Stop 但沒 OwnMind reply-lint hook → 在 Stop array 末尾追加
 *   - 存在且已有 OwnMind reply-lint hook → 不動，回報 "skipped"
 *
 * 寫入前 backup 到 settings.json.bak.<ts>，失敗 rollback。
 *
 * 用法：
 *   node add-stop-hook.cjs <settings.json path> [--ownmind-dir <path>]
 *
 * Exit codes：
 *   0  — 成功（含 skipped）
 *   1  — 失敗（已 rollback）
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 識別 hook 是否已存在的方式：command 字串中包含 'ownmind-reply-lint'。
const HOOK_IDENTIFIER_SUBSTR = 'ownmind-reply-lint';

function buildHookEntry(ownmindDir) {
  // command path 用絕對路徑 + node 直接呼叫，避免 PATH 解析問題。
  // 目錄字串可能含空白 → 用雙引號包起來。
  // Stop hook 規格：沒有 matcher（Stop 不依附 tool）。
  const hookPath = path.join(ownmindDir, 'hooks', 'ownmind-reply-lint.js');
  const cmd = `node "${hookPath}"`;
  return {
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
  if (!Array.isArray(settings.hooks.Stop)) {
    settings.hooks.Stop = [];
  }

  // idempotent 檢查：找有沒有 hook.command 含 ownmind-reply-lint
  const alreadyAdded = settings.hooks.Stop.some((group) => {
    if (!group || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((h) => {
      if (!h || typeof h.command !== 'string') return false;
      return h.command.includes(HOOK_IDENTIFIER_SUBSTR);
    });
  });
  if (alreadyAdded) {
    return { status: 'skipped', message: '已存在' };
  }

  settings.hooks.Stop.push(entry);

  // backup 既有檔
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
    console.error('用法：node add-stop-hook.cjs <settings.json path> [--ownmind-dir <path>]');
    process.exit(1);
  }
  const settingsPath = args[0];
  let ownmindDir = path.join(process.env.HOME || process.env.USERPROFILE, '.ownmind');
  const idx = args.indexOf('--ownmind-dir');
  if (idx >= 0 && args[idx + 1]) ownmindDir = args[idx + 1];

  const result = addHook(settingsPath, ownmindDir);
  if (result.status === 'error') {
    console.error(`[add-stop-hook] ERROR: ${result.message}`);
    process.exit(1);
  }
  console.log(`[add-stop-hook] ${result.status}${result.message ? ' (' + result.message + ')' : ''}`);
  process.exit(0);
}

module.exports = { addHook, buildHookEntry, HOOK_IDENTIFIER_SUBSTR };
