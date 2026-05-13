/**
 * iron-rule-suggest.js — 鐵律 SKILL.md 升級建議產生器 (v1.18.0)
 *
 * 為什麼存在：
 *   v1.18.0 升級助手 Web UI 要把 35 條 legacy 鐵律一條條轉成 SKILL.md 格式。
 *   每條轉換流程：admin 點 [Suggest] → server 推 SKILL.md proposal → diff view
 *   → admin review → [Confirm] 寫 DB。
 *
 *   v1.18.0 不接 LLM API（避免新依賴 + key 管理 + LLM 失敗 path 複雜）、
 *   用 template-based 機械式拼裝。理由：
 *     1. AI 提案常常歪、Vin 都會手改、template-based 也夠
 *     2. v1.18.x 要加 LLM 容易（介面已定）
 *     3. 35 條 × 1 min review = 35 min、不靠 LLM 也跑得完
 *
 *   未來可選擇切到 LLM：偵測 OWNMIND_SUGGEST_API_KEY env、有就走 LLM、沒就走 template。
 *
 * Pure function — 純字串轉換、好測試。
 */

import crypto from 'node:crypto';
import { detectFrontmatter } from './iron-rule-frontmatter.js';

/**
 * 把 legacy iron_rule 推成 SKILL.md proposal
 *
 * 邏輯：
 *   - 已是 SKILL.md → 原樣回（提示「已升級、無需改」）
 *   - Legacy → 從 title + content + tags 機械式拼 frontmatter + body
 *     - name = ir-XXX-{slug(title)} (kebab-case)
 *     - description = pushy 三句話：用途 + 觸發點 + 後果
 *     - body = 加結構化段落（為什麼存在 / 該做 / 不該做 / 萬一犯了）抽 content
 *
 * @param {Object} rule { id, code, title, content, tags }
 * @returns {{ already_skill_md: boolean, proposed_content: string, notes: string[] }}
 */
export function suggestSkillMdFormat(rule) {
  const content = String(rule?.content || '').trim();
  const title = String(rule?.title || '').trim();
  const code = rule?.code || `id-${rule?.id || 'unknown'}`;
  const tags = Array.isArray(rule?.tags) ? rule.tags : [];

  // 已是 SKILL.md
  const fm = detectFrontmatter(content);
  if (fm.has && !fm.parseError) {
    return {
      already_skill_md: true,
      proposed_content: content,
      notes: ['已是 SKILL.md 格式、不需升級'],
    };
  }

  const triggers = tags
    .filter(t => typeof t === 'string' && t.startsWith('trigger:'))
    .map(t => t.slice('trigger:'.length));

  const notes = [];

  // 1. name — 用 code（先正規化）
  const name = normalizeName(code, title);

  // 2. description — pushy 三段
  const description = buildDescription({ code, title, triggers });

  // 3. body — 拆既有 content 推結構化段落（盡量保留原文）
  const body = buildBody({ code, title, content });

  // 組 frontmatter + body
  const proposed = [
    '---',
    `name: ${name}`,
    'description: |',
    ...description.split('\n').map(l => `  ${l}`),
    '---',
    '',
    body,
  ].join('\n');

  notes.push('Template-based 建議：description 用 pushy 三句話寫法、body 從原 content 推結構化段落');
  notes.push('LLM suggest 未啟用 (沒設 OWNMIND_SUGGEST_API_KEY)、template 結果可能需 admin 微調');
  if (triggers.length === 0) {
    notes.push('原鐵律無 trigger:xxx tag、description 用 general 觸發 — 強烈建議補 trigger tag');
  }

  return {
    already_skill_md: false,
    proposed_content: proposed,
    notes,
  };
}

/**
 * 把 IR-XXX code 跟 title 組成 kebab-case ASCII name
 *   IR-002 + 不要 commit .env → ir-002-cmt-a1b2c3
 *   id-339 + 修報表... → id-339-rpt-d4e5f6
 *
 * v1.18.0-rc3 review I4 修正：之前用中文 title slug、跨平台 fs 危險
 *   (macOS NFC/NFD normalize 不一致、Linux 跨平台 git path 壞)
 *   → 改 ASCII only：保留 title 開頭 ASCII 詞 (取最多 6 字) + 6 字 title hash
 */
function normalizeName(code, title) {
  const codeLower = code.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // 抓 title 中的 ASCII 詞（commit / env / build 之類）給人類辨識用
  const asciiHint = (title.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(w => w.length >= 3)
    .slice(0, 2)
    .join('-')
    .slice(0, 12);

  // 6 字 hash 確保 collision 機率夠低且 deterministic
  const hash = crypto.createHash('sha1').update(title).digest('hex').slice(0, 6);

  if (asciiHint) {
    return `${codeLower}-${asciiHint}-${hash}`;
  }
  return `${codeLower}-${hash}`;
}

/**
 * 推 pushy description (約 100-200 字)
 * 三段式：use when ... required because ... triggers on ...
 */
function buildDescription({ code, title, triggers }) {
  const triggerStr = triggers.length > 0 ? triggers.join(', ') : 'general';
  const lines = [];
  lines.push(`Use this rule whenever you do work that may touch: ${triggerStr}.`);
  lines.push(`${code}「${title}」是 Vin 從歷史踩坑學來的硬規定、必須嚴格遵守。`);
  lines.push(`Triggers on: ${triggerStr}. ALWAYS consult body do/dont before action.`);
  return lines.join('\n');
}

/**
 * 推 body：保留原 content + markdown comment 提示 (不放 placeholder 段落)
 *
 * v1.18.0-rc3 review I1 修正：之前 body 放「（從原內容拆出該做事項）」placeholder
 *   段落、會通過 lint S6/S7、admin 沒手填就送 → 35 條 placeholder 寫進 DB
 *   → 改成只放原 content + HTML comment 提示、admin 自己決定要不要結構化
 *   markdown comment `<!-- -->` 不會被 render、不算 placeholder
 */
function buildBody({ code, title, content }) {
  const lines = [];
  lines.push(`# ${code}: ${title}`);
  lines.push('');
  lines.push('<!--');
  lines.push('  💡 升級提示：建議拆成「為什麼存在 / 該做 / 不該做 / 萬一犯了」結構化段落、AI 看得更清楚');
  lines.push('  保留原內容也可、lint 只要求 body 含「該做」「不該做」「規則」「必須」等關鍵字之一');
  lines.push('-->');
  lines.push('');
  lines.push(content);
  return lines.join('\n');
}
