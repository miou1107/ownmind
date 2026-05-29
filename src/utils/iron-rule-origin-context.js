/**
 * iron-rule-origin-context.js — iron-rule backstory origin_context (v1.18.2)
 *
 * Why it exists (a need Vin raised):
 *   When an iron rule is created it should record the backstory of "why it was
 *   created at the time":
 *   - which project was being worked on
 *   - what event prompted creating it
 *   - confidence level (high / user_direct / unknown)
 *
 *   As of v1.18.1 the iron-rule metadata had no such field, so the AI could not
 *   see the history from the content, and a future-session AI would not know
 *   "why Vin wrote this iron rule at the time".
 *
 * Design (option 1C / 2a+b / 3 lenient / 4 existing backfill + assistant):
 *   - metadata.origin_context: structured (for admin stats / filtering / sync)
 *   - SKILL.md body auto-renders a 「## 起源」 section (for the AI)
 *   - the dual write is controlled by this helper to avoid drift
 *   - lint warning (non-blocking, encourages new rules to fill it in)
 *
 * Schema:
 *   metadata.origin_context = {
 *     captured_at: ISO 8601 string (required, write time)
 *     confidence: 'high' | 'user_direct' | 'unknown' (required)
 *     project: string (optional, cwd or what the user said)
 *     cwd: string (optional, MCP client capture)
 *     git_branch: string (optional, MCP client capture)
 *     event: string (optional, AI inferred from the conversation / user said)
 *     user_quote: string (optional, the user's original words)
 *     related_rules: string[] (optional, AI inferred)
 *   }
 *
 * Pure functions — no IO, easy to test.
 */

/**
 * Validate the origin_context schema
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOriginContext(oc) {
  const errors = [];
  if (oc === null || oc === undefined) return { ok: true, errors }; // absent is OK (warning by lint)
  if (typeof oc !== 'object' || Array.isArray(oc)) {
    return { ok: false, errors: ['origin_context must be an object'] };
  }

  const VALID_CONFIDENCE = new Set(['high', 'user_direct', 'unknown']);

  if (!oc.captured_at) {
    errors.push('origin_context is missing captured_at');
  } else if (typeof oc.captured_at !== 'string' || Number.isNaN(Date.parse(oc.captured_at))) {
    errors.push('origin_context.captured_at must be an ISO 8601 string');
  }

  if (!oc.confidence) {
    errors.push('origin_context is missing confidence');
  } else if (!VALID_CONFIDENCE.has(oc.confidence)) {
    errors.push(`origin_context.confidence must be one of ${[...VALID_CONFIDENCE].join('/')}`);
  }

  // Type check for optional fields
  for (const k of ['project', 'cwd', 'git_branch', 'event', 'user_quote']) {
    if (oc[k] !== undefined && oc[k] !== null && typeof oc[k] !== 'string') {
      errors.push(`origin_context.${k} must be a string (or null/undefined)`);
    }
  }
  if (oc.related_rules !== undefined && oc.related_rules !== null) {
    if (!Array.isArray(oc.related_rules) || !oc.related_rules.every(r => typeof r === 'string')) {
      errors.push('origin_context.related_rules must be a string[]');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Render origin_context into a markdown body section
 * @param {object} oc — validated origin_context
 * @returns {string} markdown section (no leading/trailing blank lines; caller controls spacing)
 */
export function renderOriginContextSection(oc) {
  if (!oc) return '';

  const lines = [];
  lines.push('## 起源（自動 render from metadata.origin_context）');
  lines.push('');

  // time
  if (oc.captured_at) {
    const ts = formatTimestamp(oc.captured_at);
    lines.push(`- **時間**：${ts}`);
  }

  // confidence level
  if (oc.confidence) {
    const label = {
      high: 'high（從對話脈絡推斷、可信）',
      user_direct: 'user_direct（user 直接下令建立、無工作脈絡）',
      unknown: 'unknown（無法判斷起源）',
    }[oc.confidence] || oc.confidence;
    lines.push(`- **信心**：${label}`);
  }

  // project / environment
  if (oc.project) lines.push(`- **專案**：${oc.project}`);
  if (oc.cwd) lines.push(`- **目錄**：\`${oc.cwd}\``);
  if (oc.git_branch) lines.push(`- **Git 分支**：\`${oc.git_branch}\``);

  // event
  if (oc.event) {
    lines.push('');
    lines.push(`**事件**：${oc.event}`);
  }

  // user's original words
  if (oc.user_quote) {
    lines.push('');
    lines.push(`**User 原話**：`);
    for (const line of String(oc.user_quote).split('\n')) {
      lines.push(`> ${line}`);
    }
  }

  // related rules
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
    // show yyyy-mm-dd HH:MM (timezone kept as-is)
    return iso.replace('T', ' ').replace(/(:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/, '$1 $3');
  } catch {
    return iso;
  }
}

/**
 * Extract / replace the 「## 起源」 section in existing content
 * If present -> replace; if absent -> append to the end of the body
 *
 * Usage: the sync helper swaps the existing 「## 起源」 block in the body for the
 * new version before writing the iron rule
 *
 * @param {string} content — original content (may or may not have frontmatter)
 * @param {object} originContext — validated origin_context
 * @returns {string} content with origin section
 */
export function injectOriginSection(content, originContext) {
  if (!originContext) return content;

  const newSection = renderOriginContextSection(originContext);
  if (!newSection) return content;

  // Find the range of the existing 「## 起源」 block
  // Strategy: split by lines, find the line starting with ## 起源, stop at the
  // next ## (or end of file)
  // Pure string ops are safer than regex given JS has no \Z
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
    // replace [originStart, originEnd)
    const before = lines.slice(0, originStart);
    const after = lines.slice(originEnd);
    // remove trailing blank lines from before (avoid accumulating blank lines)
    while (before.length > 0 && before[before.length - 1] === '') before.pop();
    const sectionLines = newSection.split('\n');
    const merged = [...before, '', ...sectionLines, '', ...after];
    return merged.join('\n');
  }

  // absent -> append to the end
  const trimmed = content.replace(/\n+$/, '');
  return trimmed + '\n\n' + newSection + '\n';
}

/**
 * Auto-capture origin_context from the MCP client side (technical part)
 *
 * @param {object} options
 * @param {string} [options.userQuote] — the user's original words (optional)
 * @param {string} [options.event] — event description the AI inferred from the conversation (optional)
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
      // derive project name from cwd (basename)
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
