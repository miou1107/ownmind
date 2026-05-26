/**
 * v1.20.3：Session 暫時關閉開關 — 狀態檔讀寫
 *
 * 用途：
 *   user 可在本 session 內透過 /ownmind-off 暫時關閉 OwnMind 鉤子（lint + pre-commit）。
 *   狀態存在 `~/.ownmind/state/session-off.json`：
 *     { session_id, off_at (ISO 時間), tick_count }
 *
 * 跨 session 失效機制：
 *   - Stop hook：嚴格比對 session_id、不符就清掉
 *   - pre-commit hook：拿不到 session_id、只看 off_at 是否 24 小時內、過期就清掉
 *
 * 失敗安全（fail-open）：
 *   - 檔案 parse 失敗 / IO 失敗 → 視為「沒關閉」、正常跑鉤子（不要無法寫狀態檔就當作關閉）
 *   - 目錄不存在自動建立
 *
 * 純函式設計：除了狀態檔 IO、無其他副作用、零外部依賴。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const STATE_DIR = path.join(os.homedir(), '.ownmind', 'state');
const STATE_FILE = path.join(STATE_DIR, 'session-off.json');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 小時

function getStatePath() {
  return process.env.__OWNMIND_SESSION_OFF_PATH || STATE_FILE;
}

/**
 * 讀狀態檔。失敗或不存在回 null。
 * @returns {{session_id: string, off_at: string, tick_count: number} | null}
 */
export function readSessionOffState() {
  try {
    const p = getStatePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    if (typeof data.session_id !== 'string') return null;
    if (typeof data.off_at !== 'string') return null;
    if (typeof data.tick_count !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 寫狀態檔。若已有同 session_id 狀態、保留 tick_count；否則初始化 tick_count=0。
 * @param {string} session_id
 * @returns {boolean} - 寫入成功與否
 */
export function writeSessionOffState(session_id) {
  if (typeof session_id !== 'string' || !session_id) return false;
  try {
    const dir = path.dirname(getStatePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = readSessionOffState();
    const tick_count = (existing && existing.session_id === session_id) ? existing.tick_count : 0;
    const data = {
      session_id,
      off_at: new Date().toISOString(),
      tick_count,
    };
    fs.writeFileSync(getStatePath(), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 清除狀態檔（刪檔）。已不存在也視為成功。
 * @returns {boolean}
 */
export function clearSessionOffState() {
  try {
    const p = getStatePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 增加 tick_count、回新值。狀態檔不存在則無動作回 0。
 * @returns {number} - 新 tick_count 值
 */
export function incrementTickCount() {
  const state = readSessionOffState();
  if (!state) return 0;
  state.tick_count += 1;
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
    return state.tick_count;
  } catch {
    return state.tick_count;
  }
}

/**
 * 判斷是否處於關閉狀態 — Stop hook + pre-commit hook 共用。
 *
 * 邏輯：狀態檔存在 + off_at 在 24 小時內 → 視為 off。
 *
 * 為什麼不嚴格比對 session_id：
 *   - MCP 工具寫 state 時用 sessionStartTime（MCP 進程啟動時間戳）
 *   - Stop hook 收到的 payload.session_id 是 Claude session 編號
 *   - 兩者本質不同、嚴格比對會永遠失敗
 *
 * 新 session 自動失效靠 SessionStart hook 主動清狀態檔達成（白話：開新對話時、
 * SessionStart hook 跑、自動把舊狀態檔刪掉）。
 *
 * 過期自動清狀態檔（防呆：避免狀態檔殘留 N 天後生效）。
 *
 * @returns {boolean}
 */
export function isOff() {
  const state = readSessionOffState();
  if (!state) return false;
  const offAtMs = Date.parse(state.off_at);
  if (Number.isNaN(offAtMs)) {
    clearSessionOffState();
    return false;
  }
  if (Date.now() - offAtMs > EXPIRY_MS) {
    clearSessionOffState();
    return false;
  }
  return true;
}
