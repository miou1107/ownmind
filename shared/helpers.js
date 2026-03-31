/**
 * OwnMind Shared Helpers
 *
 * 純函式模組，零外部依賴。被 hooks 和 MCP 共用。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Constants
// ============================================================

export const SOURCE_PATTERNS = [/^src\//, /^mcp\//, /^hooks\//, /^shared\//];

const HOME = os.homedir();
const DEFAULT_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

// ============================================================
// Functions
// ============================================================

/**
 * 安全讀取 JSON 檔案，失敗回傳 null
 */
export function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 過濾出 source 檔案（匹配 patterns）
 */
export function getChangedSourceFiles(files, patterns = SOURCE_PATTERNS) {
  return files.filter(f =>
    patterns.some(p => p.test(f))
  );
}

/**
 * 讀取 MCP client 版本號
 */
export function getClientVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HOME, '.ownmind', 'mcp', 'package.json'), 'utf8'));
    return pkg.version || '?';
  } catch {
    return '?';
  }
}

/**
 * 從 Claude Code settings.json 讀取 OwnMind credentials
 * @param {string} [settingsPath] — 預設 ~/.claude/settings.json
 */
export function readCredentials(settingsPath = DEFAULT_SETTINGS_PATH) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const env = s.mcpServers?.ownmind?.env || {};
    return { apiKey: env.OWNMIND_API_KEY || '', apiUrl: env.OWNMIND_API_URL || '' };
  } catch {
    return { apiKey: '', apiUrl: '' };
  }
}

/**
 * 從 PreToolUse hook 的 command 偵測觸發類型
 * @param {string} command — bash command
 * @returns {'commit' | 'deploy' | 'delete' | null}
 */
export function detectCommandTrigger(command) {
  if (!command) return null;
  if (/\bgit\s+(commit|reset|rebase|merge)\b/i.test(command)) return 'commit';
  if (/\bgit\s+tag\b/i.test(command)) return 'commit';
  if (/\bgit\s+push\b/i.test(command)) return 'deploy';
  if (/\b(docker\s+compose\s+(up|build|push)|kubectl\s+apply|npm\s+run\s+deploy)\b/i.test(command)) return 'deploy';
  if (/\b(rm\s+-rf|rmdir|Remove-Item|drop\s+table|DELETE\s+FROM)\b/i.test(command)) return 'delete';
  return null;
}

/**
 * 從 MCP report_compliance 的 context 偵測觸發類型
 * @param {string} context — free-form text
 * @returns {'commit' | 'deploy' | 'delete' | null}
 */
export function detectTriggerFromContext(context) {
  if (!context) return null;
  if (/\bcommit\b/i.test(context)) return 'commit';
  if (/\bdeploy\b|部署/i.test(context)) return 'deploy';
  if (/\bdelete\b|刪除/i.test(context)) return 'delete';
  return null;
}
