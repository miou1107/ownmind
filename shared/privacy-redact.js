/**
 * privacy-redact — replace privacy patterns in text with anonymous labels
 * (e.g. turn email addresses, ID numbers, phone numbers into `<信箱-001>`
 * style placeholders).
 *
 * Corresponds to OpenSpec proposal v1.19.14-bug-report-tool (§2.10, §3,
 * §4 scenarios 23 / 23b).
 *
 * Design points:
 *   - Reuses detection results from `shared/privacy-detect.js`.
 *   - The same value appearing multiple times reuses the same number
 *     (same value → same label).
 *   - Each type counts independently (email starts at 001, phone starts at
 *     001, ID starts at 001).
 *   - Pure function; no IO.
 *   - Never throws (callers wrap with try/catch and fail closed).
 *
 * Why this lives in the shared layer:
 *   - The server's `ownmind_report_bug` must enforce it before writing
 *     (v4 design — don't rely on AI self-discipline).
 *   - The client preview can use it too as belt-and-suspenders.
 *
 * Label format: `<chinese-type-NNN>` — three-digit number starting at 001.
 */

import { detectPrivacyLeak } from './privacy-detect.js';

// Detection type → display-label prefix mapping. Chinese labels are kept
// deliberately because the redacted text is user-facing per the bug-report
// localized output convention.
const TYPE_LABEL_ZH = {
  email: '信箱',
  phone_tw_mobile: '手機',
  tw_id: '身分證',
};

/**
 * Replace privacy patterns in text with anonymous labels.
 *
 * @param {string} text - the original text to process
 * @param {Object} [options]
 * @param {string[]} [options.userPrompts] - recent user prompts (reused from
 *   privacy-detect exceptions)
 * @returns {{ text: string, replacements: Array<{ type: string, original: string, label: string }> }}
 */
export function redactPrivacyPatterns(text, options = {}) {
  // Non-string or empty: return as-is.
  if (typeof text !== 'string' || text.length === 0) {
    return { text, replacements: [] };
  }

  const detection = detectPrivacyLeak(text, options);
  if (!detection.detected || detection.matches.length === 0) {
    return { text, replacements: [] };
  }

  // Group by type and assign a per-type sequence to "same value".
  const counters = {}; // type → highest issued number
  const labelMap = new Map(); // `${type}:${value}` → label
  const replacements = [];

  for (const { type, value } of detection.matches) {
    const key = `${type}:${value}`;
    if (labelMap.has(key)) continue; // same value already labeled

    counters[type] = (counters[type] || 0) + 1;
    const prefix = TYPE_LABEL_ZH[type] || type;
    const label = `<${prefix}-${String(counters[type]).padStart(3, '0')}>`;
    labelMap.set(key, label);
    replacements.push({ type, original: value, label });
  }

  // Replace longest-first to avoid shorter values fragmenting longer ones
  // (e.g. if both 'a@b.com' and 'b.com' match, replace the longer one first).
  const ordered = [...labelMap.entries()].sort((a, b) => {
    const valA = a[0].split(':').slice(1).join(':');
    const valB = b[0].split(':').slice(1).join(':');
    return valB.length - valA.length;
  });

  let resultText = text;
  for (const [key, label] of ordered) {
    const value = key.split(':').slice(1).join(':');
    // split/join avoids regex meta-character concerns (@ . are not regex
    // metacharacters, but keep it conservative).
    resultText = resultText.split(value).join(label);
  }

  return { text: resultText, replacements };
}
