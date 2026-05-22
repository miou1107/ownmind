/**
 * Lint event logger — v1.19.11
 *
 * 對應 openspec/changes/v1.19.11-lint-ux-improvements/spec.md 場景 10-14。
 *
 * 為什麼存在：
 *   - 既有 ~/.ownmind/logs/YYYY-MM-DD.jsonl 是給 server 收的合規回報、結構不適合
 *     使用者本地查詢「我這週被擋幾次」
 *   - 也是未來自學機制（v1.20+ 誤判建議 / 白名單自動擴充）的資料根基
 *
 * 設計原則：
 *   - 純函式 + 一個 side effect 函式（writeEvent）、好測試
 *   - 寫入失敗不丟例外、不擋主流程（fail-open）
 *   - 5MB cap、超過自動 rotate 成 .old（保留 1 份歷史）
 *   - JSONL 格式：每行一筆 JSON、可 append、易解析
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'reply-lint-events.jsonl');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

let eventPath = DEFAULT_PATH;

/**
 * 測試用：覆寫紀錄檔路徑、或傳 null 還原預設
 * Prod 程式碼不應 call 這個
 */
export function _resetPathForTests(p) {
  eventPath = p || DEFAULT_PATH;
}

/**
 * 取得當前紀錄檔路徑（測試用）
 */
export function _getPathForTests() {
  return eventPath;
}

/**
 * 寫一筆擋下事件到紀錄檔
 *
 * @param {Object} entry
 * @param {string} entry.sessionId
 * @param {'blocked' | 'downgraded_to_warning'} entry.event
 * @param {string[]} entry.ruleCodes - 違反的規則編號清單
 * @param {Object} [entry.violatedWords] - { ir036_jargon: [...], ir037_mixed: [...] }
 * @param {number} entry.violationCountInSession
 * @param {number} entry.blockCountInSession
 * @param {boolean} entry.downgradedToWarning
 * @param {boolean} entry.aiInstructedToAnnotate
 * @returns {boolean} 寫入成功 true、失敗 false（不丟例外）
 */
export function writeEvent(entry) {
  if (!entry || typeof entry !== 'object') return false;

  const record = {
    ts: new Date().toISOString(),
    session_id: entry.sessionId || 'unknown',
    event: entry.event || 'blocked',
    rule_codes: Array.isArray(entry.ruleCodes) ? entry.ruleCodes : [],
    violated_words: entry.violatedWords && typeof entry.violatedWords === 'object'
      ? entry.violatedWords
      : {},
    violation_count_in_session: typeof entry.violationCountInSession === 'number'
      ? entry.violationCountInSession
      : 0,
    block_count_in_session: typeof entry.blockCountInSession === 'number'
      ? entry.blockCountInSession
      : 0,
    downgraded_to_warning: entry.downgradedToWarning === true,
    ai_instructed_to_annotate: entry.aiInstructedToAnnotate === true,
  };

  try {
    const dir = path.dirname(eventPath);
    fs.mkdirSync(dir, { recursive: true });

    // Rotate：超過 5MB 把現有檔搬成 .old、新一筆寫進空檔
    try {
      const stat = fs.statSync(eventPath);
      if (stat.size > MAX_BYTES) {
        try { fs.renameSync(eventPath, eventPath + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file 不存在 → skip rotate */ }

    fs.appendFileSync(eventPath, JSON.stringify(record) + '\n');
    return true;
  } catch {
    // 寫入失敗（磁碟滿 / 權限）不丟、回 false 讓 caller 知道
    return false;
  }
}

/**
 * 從 violations 陣列抽出 violated_words 結構
 *
 * 輸入是 reply-lint 內部 violations 格式：
 *   [{ rule: 'IR-037', detail: { mixedWords: [...] } }, ...]
 *
 * 輸出統一格式：
 *   { ir036_jargon: [...], ir037_mixed: [...], privacy_matches_count: N }
 *
 * @param {Array} violations
 * @returns {Object}
 */
export function extractViolatedWords(violations) {
  if (!Array.isArray(violations)) return {};
  const out = {};
  for (const v of violations) {
    if (v.rule === 'IR-037' && v.detail?.mixedWords) {
      out.ir037_mixed = v.detail.mixedWords.slice(0, 20);
    } else if (v.rule === 'IR-036' && v.detail?.jargon) {
      out.ir036_jargon = v.detail.jargon.slice(0, 20);
    } else if (v.rule === 'privacy_check' && v.detail?.matches) {
      // privacy 不存原值（IR-041 設計）、只存類型計數
      out.privacy_matches_count = v.detail.matches.length;
      out.privacy_types = Array.from(new Set(v.detail.matches.map(m => m.type)));
    }
  }
  return out;
}
