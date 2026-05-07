'use strict';

/**
 * 安全讀取 + parse JSON 設定檔。專供 update.sh / update.ps1 的 node -e 區塊使用。
 *
 * 行為：
 *   - 檔案不存在 → 回傳 fallback（caller 可以放心建新檔）
 *   - 檔案讀不到（權限）→ console.error 警告 + process.exit(0)
 *   - JSON 格式壞掉 → console.error 警告 + process.exit(0)（不回傳，caller 後面的寫檔程式不會跑到）
 *
 * 為什麼壞掉時要 exit(0)：
 *   舊版用 try { JSON.parse } catch {}，吃掉錯誤後 caller 帶著空 {} 繼續執行，
 *   接著把空 {} 寫回檔案、洗掉使用者損壞但有資料的設定。改成 exit(0) 讓
 *   caller 後續的 writeFile 不會跑到，原檔保留；exit code 是 0 是因為 update.sh
 *   不該因為一個 hook 區塊壞掉就整支爆掉，要繼續跑下一個區塊。
 */

const fs = require('fs');

function loadOrSkip(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error('[ownmind] WARN: 無法讀取 ' + filePath + ' (' + (e.code || e.message) + ')，跳過此區塊');
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('[ownmind] WARN: ' + filePath + ' JSON 格式錯誤，跳過此區塊以避免覆寫您的資料 (' + e.message + ')');
    process.exit(0);
  }

  // 防 caller 後面 `s.hooks = ...` 對 null / 數字 / 字串 / array 拋 TypeError。
  // 設定檔本就該是一個 JSON object，不是就跳過。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[ownmind] WARN: ' + filePath + ' 不是 JSON object（' + (Array.isArray(parsed) ? 'array' : typeof parsed) + '），跳過此區塊以避免覆寫您的資料');
    process.exit(0);
  }
  return parsed;
}

module.exports = { loadOrSkip };
