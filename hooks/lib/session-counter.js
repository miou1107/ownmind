/**
 * Session counter — v1.19.3 reply-lint 漸進式 block 用
 *
 * 對應 openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md 場景 7 / 8 / 14
 *
 * 為什麼存在：
 *   reply-lint hook 從「警告」升級「漸進式 block」：前 2 次警告、第 3 次預告、
 *   第 4 次才寫 block JSON。需要追蹤每個 Claude session 累積了幾次違規。
 *
 * 設計原則：
 *   - 純 file-based（不依賴 DB / server、hook 本地立即能用）
 *   - 失敗即默許（毀損 / 無權限 → 視為 0、不擋 hook 主流程）
 *   - 自掃 30 天前的 session 紀錄（避免檔長期膨脹）
 *   - 純函式風格、好測試（_resetCounterPathForTests 給測試用、prod 不會 call）
 *
 * Schema:
 *   {
 *     "<session_id>": {
 *       "count": <int>,
 *       "last_violation_ts": "<ISO8601>",
 *       "started_at": "<ISO8601>"
 *     }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_COUNTER_PATH = path.join(
  os.homedir(),
  '.ownmind',
  'logs',
  'reply-lint-session-counter.json'
);

let counterPath = DEFAULT_COUNTER_PATH;

/**
 * 測試用：override counter 檔路徑、或傳 null 還原預設
 * Prod 程式碼不應 call 這個
 */
export function _resetCounterPathForTests(p) {
  counterPath = p || DEFAULT_COUNTER_PATH;
}

function readAll() {
  try {
    if (!fs.existsSync(counterPath)) return {};
    const raw = fs.readFileSync(counterPath, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    // 毀損 / 無權限 / 任何 IO 錯 → 視為空、後續 write 會覆寫成乾淨檔
    return {};
  }
}

function writeAll(data) {
  try {
    fs.mkdirSync(path.dirname(counterPath), { recursive: true });
    fs.writeFileSync(counterPath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    // 無權限 / 磁碟滿 → 吞錯、hook 仍能繼續（只是計數不會累積）
    return false;
  }
}

/**
 * 讀取某 session 目前計數、檔不存在或毀損回 0
 */
export function readCounter(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  const all = readAll();
  return all[sessionId]?.count || 0;
}

/**
 * 將某 session 計數 +1、回新計數值
 * 寫入失敗（無權限 / 磁碟）也不丟、回 1（視為這次有違規、但下次讀回又是 0）
 */
export function incrementCounter(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  const all = readAll();
  const nowIso = new Date().toISOString();
  const existing = all[sessionId];
  if (existing && typeof existing.count === 'number') {
    existing.count += 1;
    existing.last_violation_ts = nowIso;
  } else {
    all[sessionId] = {
      count: 1,
      last_violation_ts: nowIso,
      started_at: nowIso,
    };
  }
  writeAll(all);
  return all[sessionId].count;
}

/**
 * 清掉 started_at 超過 maxAgeMs 的 session 紀錄
 * 不丟錯（檔不存在 / 毀損都 noop）
 */
export function cleanupStale(maxAgeMs) {
  const all = readAll();
  if (Object.keys(all).length === 0) return;
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const [sid, entry] of Object.entries(all)) {
    const started = Date.parse(entry?.started_at || '');
    if (!Number.isFinite(started) || started < cutoff) {
      delete all[sid];
      changed = true;
    }
  }
  if (changed) writeAll(all);
}
