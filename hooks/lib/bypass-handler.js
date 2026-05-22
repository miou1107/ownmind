/**
 * OwnMind Bypass Handler — v1.19.6
 *
 * 解析 OWNMIND_BYPASS 環境變數、判斷規則是否被放行、寫 audit log。
 *
 * 用法：
 *   OWNMIND_BYPASS=IR-008 git commit ...        # 單條
 *   OWNMIND_BYPASS=IR-008,IR-024 git commit ... # 多條
 *   OWNMIND_BYPASS=all git commit ...           # 全部
 *
 * 設計原則：
 *   - process scope（不污染全域、不修改 env）
 *   - 永遠寫 audit（不可關閉、後續可審）
 *   - 純函式 + 一個 side-effect 函式（logBypass）
 */

import { appendCompliance } from '../../shared/compliance.js';

/**
 * 解析 OWNMIND_BYPASS 環境變數成 Set
 * @param {object|null|undefined} env - process.env 或測試 stub
 * @returns {Set<string>} - 規則代碼集合；'all' 為特殊值
 */
export function parseBypass(env) {
  if (!env || typeof env !== 'object') return new Set();
  const raw = env.OWNMIND_BYPASS;
  if (typeof raw !== 'string' || !raw.trim()) return new Set();

  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      // 緊急場景 user 常打 ALL/All；統一 normalize 成 'all' 避免無聲失效
      .map((s) => (s.toLowerCase() === 'all' ? 'all' : s))
  );
}

/**
 * 判斷某條鐵律是否被放行
 * @param {string} ruleCode
 * @param {Set<string>|null|undefined} bypassSet
 * @returns {boolean}
 */
export function isBypassed(ruleCode, bypassSet) {
  if (!bypassSet || typeof bypassSet.has !== 'function') return false;
  if (bypassSet.size === 0) return false;
  if (bypassSet.has('all')) return true;
  return bypassSet.has(ruleCode);
}

/**
 * 寫一筆 action=bypass 到 audit log
 * @param {object} entry
 * @param {string} entry.ruleCode
 * @param {string} [entry.ruleTitle]
 * @param {string} [entry.source]      - pre_commit / pre_tool_use / reply_lint / hook
 * @param {string} [entry.commitHash]
 * @param {string} [entry.sessionId]
 * @param {string[]} [entry.failures]
 */
export function logBypass(entry) {
  appendCompliance({
    event: entry.ruleCode,
    action: 'bypass',
    rule_code: entry.ruleCode,
    rule_title: entry.ruleTitle || entry.ruleCode,
    source: entry.source || 'hook',
    ...(entry.commitHash && { commit_hash: entry.commitHash }),
    ...(entry.sessionId && { session_id: entry.sessionId }),
    ...(entry.failures && { failures: entry.failures }),
  });
}
