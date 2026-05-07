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
 * 去掉字串開頭的 UTF-8 BOM (\uFEFF)。
 * v1.17.12：Windows installer (PS 5.1) 用 `Set-Content -Encoding UTF8` 寫 JSON
 * 時會加 BOM，Node 的 JSON.parse 會炸。
 */
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * 安全讀取 JSON 檔案，失敗回傳 null。容忍 UTF-8 BOM。
 */
export function readJsonSafe(filePath) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
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
    // 統一從根目錄 package.json 讀取版號（單一來源）
    // v1.17.12 同樣 stripBom 防 Windows 編輯器吐的 BOM
    const pkg = JSON.parse(stripBom(fs.readFileSync(path.join(HOME, '.ownmind', 'package.json'), 'utf8')));
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
    // v1.17.12 — stripBom 防 Windows PS 5.1 用 Set-Content -Encoding UTF8 寫出
    // 的 BOM-prefixed JSON。沒 stripBom 時 Adam/Eric 的 scanner 會在這裡 throw，
    // 被 catch 成空 creds，scanner 提早退出，Admin 看到的就是「未裝」+ 用量 0。
    const s = JSON.parse(stripBom(fs.readFileSync(settingsPath, 'utf8')));
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

/**
 * 把錯誤訊息變安全：替換家目錄路徑為 ~、抹掉 sk-/Bearer 樣式 token、截長度。
 * 用在 console.error stderr 訊息，避免噴使用者本機路徑或 API key。
 * @param {unknown} msg
 * @param {number} [maxLen=80]
 * @returns {string}
 */
export function sanitizeErrorMessage(msg, maxLen = 80) {
  if (msg === null || msg === undefined) return '';
  let s = typeof msg === 'string' ? msg : String(msg);
  const home = HOME;
  if (home && home.length > 1) {
    s = s.split(home).join('~');
  }
  s = s.replace(/sk-[A-Za-z0-9_-]{6,}/g, '<redacted>');
  s = s.replace(/Bearer\s+[A-Za-z0-9_.-]+/g, '<redacted>');
  if (s.length > maxLen) s = s.slice(0, maxLen) + '...';
  return s;
}

/**
 * 把元素推入陣列並維持上限長度，超過就丟最舊的（環形緩衝）。
 * 用在會在 long session 一直累積的 in-memory 陣列。
 * @template T
 * @param {T[]} arr
 * @param {T} item
 * @param {number} maxSize
 * @returns {T[]} 同一個陣列引用（原地修改）
 */
export function pushBounded(arr, item, maxSize) {
  arr.push(item);
  while (arr.length > maxSize) arr.shift();
  return arr;
}

/**
 * 滑動時間窗去重：回傳 true 代表 ttlMs 內看過、應該跳過。
 * 順手 GC 掉地圖內所有過期項目。第一次出現會記下時間戳；
 * 後續呼叫不會 slide 時間戳（沿用第一次時間，所以最終會過期）。
 * @param {Map<string, number>} map - 紀錄 key → first_seen_ts
 * @param {string} key
 * @param {number} ttlMs
 * @param {number} [now=Date.now()] - 注入時間方便測試
 * @returns {boolean} 是否該跳過此筆
 */
export function shouldSkipDuplicate(map, key, ttlMs, now = Date.now()) {
  for (const [k, ts] of map) {
    if (now - ts >= ttlMs) map.delete(k);
  }
  const last = map.get(key);
  if (last !== undefined && now - last < ttlMs) return true;
  map.set(key, now);
  return false;
}
