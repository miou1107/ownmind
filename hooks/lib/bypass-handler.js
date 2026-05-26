/**
 * OwnMind Bypass Handler — v1.19.6
 *
 * Parse the OWNMIND_BYPASS env var, decide whether a rule is bypassed, and write the audit log.
 *
 * Usage:
 *   OWNMIND_BYPASS=IR-008 git commit ...        # single rule
 *   OWNMIND_BYPASS=IR-008,IR-024 git commit ... # multiple rules
 *   OWNMIND_BYPASS=all git commit ...           # all rules
 *
 * Design principles:
 *   - Process scope (no global pollution; never mutates env).
 *   - Always writes audit (cannot be disabled — auditable after the fact).
 *   - Pure functions + one side-effect function (logBypass).
 */

import { appendCompliance } from '../../shared/compliance.js';

/**
 * Parse the OWNMIND_BYPASS env var into a Set.
 * @param {object|null|undefined} env - process.env or a test stub
 * @returns {Set<string>} - rule code set; 'all' is the special wildcard.
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
      // In emergency scenarios users often type ALL/All; normalize to 'all' to avoid a silent miss.
      .map((s) => (s.toLowerCase() === 'all' ? 'all' : s))
  );
}

/**
 * Decide whether a given iron rule is bypassed.
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
 * Write an action=bypass row to the audit log.
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
