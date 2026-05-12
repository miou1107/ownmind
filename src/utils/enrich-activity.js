/**
 * enrichActivityDetails — 在 activity_logs 落 DB 前 enrich event.details
 *
 * 為什麼存在：
 *   v1.17.88 前 client MCP 在 ownmind_disable / ownmind_update 時只送 { id, reason }
 *   到 /api/activity/batch，server 直接寫 activity_logs.details。
 *   之後 admin 看 /api/me/pitfalls 要 JOIN memories 補 title/code，
 *   JOIN 失敗就顯示「(找不到)」。30 筆漏觀測幾乎都長這樣。
 *
 *   修法：server 收到 activity 時，若是 memory_disable / memory_update 且
 *   target 是 iron_rule，立刻 lookup memories 把 code+title snapshot 到
 *   event.details。未來看 activity_log 自帶完整脈絡、不用 JOIN。
 *
 * Pure function — lookup 透過 callback 注入、方便單元測試（不碰 DB）。
 *
 * @param {Object} event - { event, details, ... }
 * @param {(id) => Promise<{type, code, title}|null>} lookup - memory 查詢函數
 * @returns {Promise<Object>} enrich 後的 details（永遠回 object、不會丟錯）
 */
export async function enrichActivityDetails(event, lookup) {
  const baseDetails = event?.details && typeof event.details === 'object'
    ? event.details
    : {};

  // 只 enrich 這兩個事件
  if (event?.event !== 'memory_disable' && event?.event !== 'memory_update') {
    return baseDetails;
  }

  // 缺 id → 沒得 lookup
  if (baseDetails.id === undefined || baseDetails.id === null) {
    return baseDetails;
  }

  // id 必須是數字或可轉成數字（regex 同 me.js pitfalls）
  const idStr = String(baseDetails.id);
  if (!/^\d+$/.test(idStr)) {
    return baseDetails;
  }

  // lookup 丟錯一律吞掉 — enrich 失敗不能阻擋主 INSERT
  let row = null;
  try {
    row = await lookup(parseInt(idStr, 10));
  } catch (_e) {
    return baseDetails;
  }

  if (!row || row.type !== 'iron_rule') {
    return baseDetails;
  }

  // snapshot title + code 到 details（用 disabled_* 前綴跟現有 pitfalls 命名一致）
  //
  // ⚠️ Snapshot 語意是「lookup 當下」、不是「事件發生當下」：
  //   - memory_disable 事件：disable 操作完成後才寫 activity log，lookup 出來的
  //     title/code 就是當下值 → 跟事件意圖一致
  //   - memory_update 事件：UPDATE 完才落 log、lookup 拿到的是 post-update 值。
  //     對 pitfalls 顯示用途（admin 想知道「這條鐵律叫什麼」）是正確的、但若未來
  //     有人預期這欄是 "title at moment of trigger" 則會誤判
  //
  // 用 || null 而非 || '' — JSONB NULL 才會讓 me.js 的 COALESCE fallback JOIN
  // 正確被觸發（'' 不是 NULL、會吃掉 fallback）
  return {
    ...baseDetails,
    disabled_code: row.code || null,
    disabled_title: row.title || null,
  };
}
