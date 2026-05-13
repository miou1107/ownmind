/**
 * iron-rule-frontmatter.js — 鐵律 SKILL.md frontmatter 偵測 + 解析（v1.18.0）
 *
 * 為什麼存在：
 *   v1.18.0 把鐵律從 free-text 升級成 Anthropic SKILL.md 格式
 *   (frontmatter name + description + body)、需要先有偵測 + parser 基礎。
 *
 * 設計：
 *   - 偵測：content 開頭是 `---\n` 且後續找得到 `\n---\n` → 視為 SKILL.md
 *   - 沒 frontmatter → 視為純文字、走 v1.17.94 regex lint（向後相容）
 *   - YAML 解析失敗 → 視為非法 SKILL.md（lint 會 reject）
 *
 * 純函式、跨平台、零副作用。
 */

import yaml from 'js-yaml';

/**
 * 偵測 + 解析鐵律 content 的 SKILL.md frontmatter。
 *
 * 接受格式：
 *   ---\n
 *   <yaml>\n
 *   ---\n
 *   <markdown body...>
 *
 * @param {string} content 鐵律的 content 欄位
 * @returns {{ has: boolean, frontmatter?: object, body?: string, parseError?: string }}
 *   - has: 是否偵測到完整 frontmatter（開頭 + 結尾 marker 都在）
 *   - frontmatter: 解析後的 object（YAML parse 成功時）
 *   - body: marker 後的純 markdown
 *   - parseError: YAML parse 錯誤訊息（has=true 但解析失敗時）
 */
export function detectFrontmatter(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { has: false };
  }

  // 嚴格要求 `---\n` 開頭（不接受前導空白、避免誤判）
  if (!content.startsWith('---\n')) {
    return { has: false };
  }

  // 找結尾 marker `\n---\n`（不接受 `---` 在檔尾無 trailing newline、避免邊界）
  const closeIdx = content.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    // 開頭有 marker 但結尾找不到 → 不算合法 frontmatter
    return { has: false };
  }

  const yamlText = content.slice(4, closeIdx);
  // close marker `\n---\n` 後面通常跟一個空行（標準 SKILL.md 風格）→ 把 body
  // 開頭的 leading newlines 吃掉、跟 gray-matter / Jekyll 行為對齊
  const body = content.slice(closeIdx + 5).replace(/^\n+/, '');

  let frontmatter;
  try {
    frontmatter = yaml.load(yamlText, {
      // 安全模式：不允許執行任意 JS（防 yaml exploit）
      schema: yaml.JSON_SCHEMA,
    });
  } catch (e) {
    return {
      has: true,
      parseError: `YAML 解析失敗: ${e.message || String(e)}`,
      body,
    };
  }

  // 解析結果必須是 object（不能是 null / array / scalar）
  if (frontmatter === null || frontmatter === undefined) {
    return {
      has: true,
      parseError: 'frontmatter 不能為空',
      body,
    };
  }
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return {
      has: true,
      parseError: 'frontmatter 必須是 key-value object',
      body,
    };
  }

  return { has: true, frontmatter, body };
}
