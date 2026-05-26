/**
 * v1.17.69 — 把 broadcast / 前綴 / body / 技巧提示合併成單一 text part
 *
 * 為什麼：v1.17.0 ~ v1.17.68 的回傳是 4 個獨立的 `{ type: "text", text: ... }`。
 * 大多數 MCP client（Codex / Cursor / Antigravity）會順序合併渲染，但 Claude Code
 * 的 UI 把 tool result 用摺疊卡片顯示時，**多 part 之間的視覺被吃掉**、最後一個
 * part（tip）藏起來看不到。Vin 回報「之前都會出現的技巧提示，現在 Claude Code
 * 看不到，其他工具都有」就是這個 bug。
 *
 * 修法：所有段合併成單一 text part，任何 client 渲染都一致。
 *
 * 視覺規則（保留 v1.17.68 之前各 client 看到的版型）：
 *   - 有 broadcast 就放最前、後面接一個空白行
 *   - tag 後接「：\n」再接 body（tag 當 header 行；body 是多行 JSON 時不會擠成一坨）
 *   - body 跟 tip 之間留一個空白行
 *   - tip 為空字串時整段省略（不留尾巴空白）
 *
 * @param {object} parts
 * @param {string} [parts.broadcastText] - 廣播訊息（已 render 好），可省略
 * @param {string} parts.tag - 「【OwnMind vX.Y.Z】類型」前綴，不含結尾的「：」
 * @param {string} parts.body - 主要內容（通常是 JSON.stringify 結果）
 * @param {string} [parts.tip] - 技巧提示文字，空字串則不附 tip 段
 * @param {string} [parts.tipTag] - tip 的 tag 前綴（例如「【OwnMind v1.17.69】技巧提示」）
 * @returns {{ content: Array<{ type: 'text', text: string }> }}
 */
export function composeToolResponse({ broadcastText, tag, body, tip, tipTag } = {}) {
  const sections = [];
  if (broadcastText) sections.push(broadcastText);
  sections.push(`${tag ?? ''}:\n${body ?? ''}`);
  if (tip && tipTag) {
    sections.push(`${tipTag}: ${tip}`);
  } else if (tip) {
    sections.push(`Tip: ${tip}`);
  }
  return {
    content: [{ type: 'text', text: sections.join('\n\n') }],
  };
}
