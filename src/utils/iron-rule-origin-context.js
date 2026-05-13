/**
 * iron-rule-origin-context.js — 鐵律時空背景 origin_context (v1.18.2)
 *
 * 為什麼存在 (Vin 提的需求):
 *   鐵律建立時應該記錄「為什麼當時要建立」的時空背景：
 *   - 正在執行什麼專案
 *   - 遇到什麼事件才建立
 *   - 信心程度 (high / user_direct / unknown)
 *
 *   現況 (v1.18.1) 鐵律 metadata 沒這欄位、AI 看 content 看不到歷史脈絡、
 *   未來 session AI 不知道「為什麼當時 Vin 寫這條鐵律」。
 *
 * 設計 (走 1C / 2a+b / 3 鬆 / 4 既有 backfill+助手補):
 *   - metadata.origin_context: 結構化 (給 admin 統計 / 過濾 / sync 用)
 *   - SKILL.md body 自動 render「## 起源」段落 (給 AI 看)
 *   - 雙寫由本 helper 控制、避免不同步
 *   - lint warning (不擋、鼓勵新鐵律補)
 *
 * Schema:
 *   metadata.origin_context = {
 *     captured_at: ISO 8601 string (必填、寫入時間)
 *     confidence: 'high' | 'user_direct' | 'unknown' (必填)
 *     project: string (選填、cwd 或 user 講)
 *     cwd: string (選填、MCP client capture)
 *     git_branch: string (選填、MCP client capture)
 *     event: string (選填、AI 從對話推 / user 講)
 *     user_quote: string (選填、user 原話)
 *     related_rules: string[] (選填、AI 推)
 *   }
 *
 * Pure functions — 無 IO、好測試。
 */

/**
 * 驗證 origin_context schema
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOriginContext(oc) {
  const errors = [];
  if (oc === null || oc === undefined) return { ok: true, errors }; // 沒帶 OK (warning by lint)
  if (typeof oc !== 'object' || Array.isArray(oc)) {
    return { ok: false, errors: ['origin_context 必須是 object'] };
  }

  const VALID_CONFIDENCE = new Set(['high', 'user_direct', 'unknown']);

  if (!oc.captured_at) {
    errors.push('origin_context 缺 captured_at');
  } else if (typeof oc.captured_at !== 'string' || Number.isNaN(Date.parse(oc.captured_at))) {
    errors.push('origin_context.captured_at 必須是 ISO 8601 string');
  }

  if (!oc.confidence) {
    errors.push('origin_context 缺 confidence');
  } else if (!VALID_CONFIDENCE.has(oc.confidence)) {
    errors.push(`origin_context.confidence 必須是 ${[...VALID_CONFIDENCE].join('/')}`);
  }

  // 選填欄位的型別檢查
  for (const k of ['project', 'cwd', 'git_branch', 'event', 'user_quote']) {
    if (oc[k] !== undefined && oc[k] !== null && typeof oc[k] !== 'string') {
      errors.push(`origin_context.${k} 必須是 string (or null/undefined)`);
    }
  }
  if (oc.related_rules !== undefined && oc.related_rules !== null) {
    if (!Array.isArray(oc.related_rules) || !oc.related_rules.every(r => typeof r === 'string')) {
      errors.push('origin_context.related_rules 必須是 string[]');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 把 origin_context 渲染成 markdown body 段落
 * @param {object} oc — validated origin_context
 * @returns {string} markdown 段落 (前後不加空行、由 caller 控制 spacing)
 */
export function renderOriginContextSection(oc) {
  if (!oc) return '';

  const lines = [];
  lines.push('## 起源（自動 render from metadata.origin_context）');
  lines.push('');

  // 時間
  if (oc.captured_at) {
    const ts = formatTimestamp(oc.captured_at);
    lines.push(`- **時間**：${ts}`);
  }

  // 信心程度
  if (oc.confidence) {
    const label = {
      high: 'high（從對話脈絡推斷、可信）',
      user_direct: 'user_direct（user 直接下令建立、無工作脈絡）',
      unknown: 'unknown（無法判斷起源）',
    }[oc.confidence] || oc.confidence;
    lines.push(`- **信心**：${label}`);
  }

  // 專案 / 環境
  if (oc.project) lines.push(`- **專案**：${oc.project}`);
  if (oc.cwd) lines.push(`- **目錄**：\`${oc.cwd}\``);
  if (oc.git_branch) lines.push(`- **Git 分支**：\`${oc.git_branch}\``);

  // 事件
  if (oc.event) {
    lines.push('');
    lines.push(`**事件**：${oc.event}`);
  }

  // user 原話
  if (oc.user_quote) {
    lines.push('');
    lines.push(`**User 原話**：`);
    for (const line of String(oc.user_quote).split('\n')) {
      lines.push(`> ${line}`);
    }
  }

  // 相關鐵律
  if (Array.isArray(oc.related_rules) && oc.related_rules.length > 0) {
    lines.push('');
    lines.push(`**相關鐵律**：${oc.related_rules.join(', ')}`);
  }

  return lines.join('\n');
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // 顯示 yyyy-mm-dd HH:MM (timezone 維持原樣)
    return iso.replace('T', ' ').replace(/(:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/, '$1 $3');
  } catch {
    return iso;
  }
}

/**
 * 從現有 content 中抽 / 替換「## 起源」段落
 * 若已有 → 替換；沒有 → append 到 body 末尾
 *
 * 用法：sync helper 在寫鐵律前、把 body 中既有的「## 起源」block 換成新版
 *
 * @param {string} content — 原 content (可能含 frontmatter 也可能沒)
 * @param {object} originContext — validated origin_context
 * @returns {string} content with origin section
 */
export function injectOriginSection(content, originContext) {
  if (!originContext) return content;

  const newSection = renderOriginContextSection(originContext);
  if (!newSection) return content;

  // 找既有「## 起源」block 的範圍
  // 策略：split by lines、找 ## 起源 開頭、收到下個 ## 為止 (或檔尾)
  // 純 string ops 比 regex 對 JS 沒 \Z 的限制安全
  const lines = content.split('\n');
  let originStart = -1;
  let originEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (originStart === -1 && /^## 起源/.test(lines[i])) {
      originStart = i;
    } else if (originStart !== -1 && /^## (?!起源)/.test(lines[i])) {
      originEnd = i;
      break;
    }
  }

  if (originStart !== -1) {
    // 替換 [originStart, originEnd)
    const before = lines.slice(0, originStart);
    const after = lines.slice(originEnd);
    // 移除 before 末尾空行 (避免越改越多空行)
    while (before.length > 0 && before[before.length - 1] === '') before.pop();
    const sectionLines = newSection.split('\n');
    const merged = [...before, '', ...sectionLines, '', ...after];
    return merged.join('\n');
  }

  // 沒有 → append 到末尾
  const trimmed = content.replace(/\n+$/, '');
  return trimmed + '\n\n' + newSection + '\n';
}

/**
 * 從 MCP client 端 capture 自動 origin_context (技術部分)
 *
 * @param {object} options
 * @param {string} [options.userQuote] — user 原話 (選填)
 * @param {string} [options.event] — AI 從對話推的事件描述 (選填)
 * @param {'high'|'user_direct'|'unknown'} [options.confidence] — default 'unknown'
 * @returns {object} origin_context
 */
export function captureClientOriginContext(options = {}) {
  const oc = {
    captured_at: new Date().toISOString(),
    confidence: options.confidence || 'unknown',
  };

  // cwd
  if (typeof process !== 'undefined' && process.cwd) {
    try {
      oc.cwd = process.cwd();
      // 從 cwd 推 project name (basename)
      const parts = oc.cwd.split(/[\\/]/);
      oc.project = parts[parts.length - 1];
    } catch { /* ignore */ }
  }

  // event / user_quote
  if (options.event) oc.event = options.event;
  if (options.userQuote) oc.user_quote = options.userQuote;
  if (Array.isArray(options.relatedRules)) oc.related_rules = options.relatedRules;

  return oc;
}
