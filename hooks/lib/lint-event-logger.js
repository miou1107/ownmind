/**
 * Lint event logger — v1.19.11
 *
 * Corresponds to openspec/changes/v1.19.11-lint-ux-improvements/spec.md scenarios 10-14.
 *
 * Why this exists:
 *   - The existing ~/.ownmind/logs/YYYY-MM-DD.jsonl is compliance reporting destined for the
 *     server; its shape isn't great for local "how many times was I blocked this week" queries.
 *   - It's also the data foundation for the future self-learning mechanism (v1.20+ misfire
 *     suggestions / auto-expanding whitelist).
 *
 * Design principles:
 *   - Pure functions + one side-effect function (writeEvent) — test-friendly.
 *   - Write failure never throws, never blocks the main flow (fail-open).
 *   - 5MB cap; over the cap, auto-rotate to .old (retain 1 historical file).
 *   - JSONL format: one JSON record per line, appendable, easy to parse.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'reply-lint-events.jsonl');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

let eventPath = DEFAULT_PATH;

/**
 * For tests: override the event file path, or pass null to restore the default.
 * Production code MUST NOT call this.
 */
export function _resetPathForTests(p) {
  eventPath = p || DEFAULT_PATH;
}

/**
 * Get the current event file path (for tests).
 */
export function _getPathForTests() {
  return eventPath;
}

/**
 * Write a block event to the event file.
 *
 * @param {Object} entry
 * @param {string} entry.sessionId
 * @param {'blocked' | 'downgraded_to_warning'} entry.event
 * @param {string[]} entry.ruleCodes - list of violated rule codes
 * @param {Object} [entry.violatedWords] - { ir036_jargon: [...], ir037_mixed: [...] }
 * @param {number} entry.violationCountInSession
 * @param {number} entry.blockCountInSession
 * @param {boolean} entry.downgradedToWarning
 * @param {boolean} entry.aiInstructedToAnnotate
 * @returns {boolean} true on success, false on failure (does not throw).
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

    // Rotate: over 5MB, move the existing file to .old and write the new record into an empty file.
    try {
      const stat = fs.statSync(eventPath);
      if (stat.size > MAX_BYTES) {
        try { fs.renameSync(eventPath, eventPath + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file does not exist → skip rotate */ }

    fs.appendFileSync(eventPath, JSON.stringify(record) + '\n');
    return true;
  } catch {
    // Write failure (disk full / no permission) → do not throw; return false so caller knows.
    return false;
  }
}

/**
 * Extract a violated_words structure from a violations array.
 *
 * v1.20.4: the `rule` field switched to a neutral event constant (no longer hard-codes personal iron rule numbers).
 *
 * Input is the reply-lint internal violations shape:
 *   [{ rule: 'lint_language_mixed_ratio', detail: { mixedWords: [...] } }, ...]
 *
 * Output is a unified shape:
 *   { jargon_words: [...], mixed_lang_words: [...], privacy_matches_count: N }
 *
 * @param {Array} violations
 * @returns {Object}
 */
export function extractViolatedWords(violations) {
  if (!Array.isArray(violations)) return {};
  const out = {};
  for (const v of violations) {
    if (v.rule === 'lint_language_mixed_ratio' && v.detail?.mixedWords) {
      out.mixed_lang_words = v.detail.mixedWords.slice(0, 20);
    } else if (v.rule === 'lint_jargon_explanation_required' && v.detail?.jargon) {
      out.jargon_words = v.detail.jargon.slice(0, 20);
    } else if (v.rule === 'privacy_check' && v.detail?.matches) {
      // privacy doesn't store raw values (by design of the privacy detector) — only counts and types.
      out.privacy_matches_count = v.detail.matches.length;
      out.privacy_types = Array.from(new Set(v.detail.matches.map(m => m.type)));
    }
  }
  return out;
}
