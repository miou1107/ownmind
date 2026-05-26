/**
 * OwnMind Bug Fingerprints — error-fingerprint registry (a code-level enum).
 *
 * Corresponds to OpenSpec proposal v1.19.14-bug-report-tool (§2.9).
 *
 * Use case:
 *   When the backend throws an error, it attaches `suggest_report: true`
 *   plus `bug_fingerprint: <some registered fingerprint>`. The client and
 *   user use that to file a report. Fingerprints are stable (no timestamp /
 *   user / request id), so the same error situation always produces the
 *   same fingerprint — allowing the backend to correlate reports
 *   (spam detection, cool-down windows).
 *
 * Rules:
 *   1. Fingerprint format: <prefix>_<situation>. Prefix must be in
 *      VALID_PREFIXES.
 *   2. Lowercase ASCII / digits / underscores only.
 *   3. No timestamps / UUIDs / user ids.
 *   4. New fingerprints must be added to this registry before use (tests
 *      reject unregistered strings).
 *
 * Prefix categories:
 *   - mem      : memory write / update related (blocked, bad field)
 *   - srv_err  : backend internal error (5xx, sub-categorized by error class)
 *   - clt      : client-side error (malformed request, missing params)
 *   - lint     : reply-quality lint hook related
 *   - sync     : memory sync related
 *   - auth     : authentication / authorization related
 */

export const VALID_PREFIXES = ['mem', 'srv_err', 'clt', 'lint', 'sync', 'auth'];

export const BUG_FINGERPRINT_REGISTRY = {
  // ── Memory write blocked (mem_blocked_*) ─────────────────────────
  mem_blocked_secret_keyword: {
    category: 'mem',
    description: 'Memory write blocked because a sensitive keyword was detected (secret-detect keyword)',
  },
  mem_blocked_secret_regex: {
    category: 'mem',
    description: 'Memory write blocked because the value matched a secret-pattern regex',
  },
  mem_blocked_privacy_pattern: {
    category: 'mem',
    description: 'Memory write blocked because privacy data was detected (email / ID / phone)',
  },
  mem_blocked_iron_rule_quality: {
    category: 'mem',
    description: 'Iron-rule write blocked because the quality check failed (missing plain-Chinese explanation / context)',
  },
  mem_blocked_invalid_type: {
    category: 'mem',
    description: 'Memory write blocked because the type is not in allowed_types',
  },

  // ── Backend internal errors (srv_err_*, used by 5xx handlers) ────────
  srv_err_db_connection: {
    category: 'srv_err',
    description: 'Database connection failed (5xx)',
  },
  srv_err_db_query: {
    category: 'srv_err',
    description: 'Database query exception (5xx)',
  },
  srv_err_migration_failure: {
    category: 'srv_err',
    description: 'Migration failed to apply; server startup blocked',
  },
  srv_err_unhandled_exception: {
    category: 'srv_err',
    description: 'Other unhandled backend exception (fallback)',
  },

  // ── Client request errors (clt_*) ─────────────────────────────
  clt_invalid_payload: {
    category: 'clt',
    description: 'Request body is malformed and cannot be parsed',
  },
  clt_missing_required_field: {
    category: 'clt',
    description: 'Request is missing a required field',
  },
  clt_sync_token_stale: {
    category: 'clt',
    description: 'sync token is stale; ownmind_init needs to be called again',
  },
  // v1.26.1: free-form escape hatch — when a user discovers a new design issue
  // that has no matching registered fingerprint, this is the canonical fallback.
  // Rate-limit + spam-detection still apply (same-fingerprint 3/h → 429; ≥5/h → spam suspect).
  clt_user_reported_other: {
    category: 'clt',
    description: 'User-initiated free-form report — for newly discovered design issues / categories not yet registered as a specific fingerprint.',
  },

  // ── Sync related (sync_*) ─────────────────────────────────
  sync_memory_file_corrupt: {
    category: 'sync',
    description: 'Local memory file is corrupt and cannot be parsed',
  },

  // ── Auth related (auth_*) ─────────────────────────────────
  auth_key_invalid: {
    category: 'auth',
    description: 'api_key is invalid or expired',
  },
  auth_permission_denied: {
    category: 'auth',
    description: 'Operation not permitted (e.g. a non-admin calling an admin API)',
  },

  // ── Reply-quality lint (lint_*) ────────────────────────────
  lint_hook_internal_error: {
    category: 'lint',
    description: 'reply-lint hook internal error; failed to block a violation properly',
  },
  lint_context_memory_missing: {
    category: 'lint',
    description: 'Jargon / technical-term check has no cross-reply vocabulary memory; previously explained terms were re-flagged (fixed in v1.20.2 follow-up #3)',
  },
  lint_hook_no_suggest_report_path: {
    category: 'lint',
    description: 'reply-lint hook failure path did not include suggest_report + bug_fingerprint on stderr, so AI cannot send a bug report with a fingerprint',
  },

  // ── Iron-rule hook blocking (mem_*) ───────────────────────
  mem_iron_rule_blocking_commit_no_fingerprint: {
    category: 'mem',
    description: 'pre-commit hook blocked commit because an iron-rule verification failed, but stderr did not include a bug_fingerprint, so AI cannot send a bug report',
  },
};

/**
 * Get a fingerprint's metadata; returns null when not found.
 * @param {string|null|undefined} fingerprint
 * @returns {{category: string, description: string} | null}
 */
export function getFingerprintMetadata(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'string') return null;
  return BUG_FINGERPRINT_REGISTRY[fingerprint] || null;
}

/**
 * Check whether a fingerprint is registered.
 * @param {string|null|undefined} fingerprint
 * @returns {boolean}
 */
export function isValidFingerprint(fingerprint) {
  return getFingerprintMetadata(fingerprint) !== null;
}

/**
 * List every fingerprint under a given category.
 * @param {string} prefix - prefix name (e.g. 'mem', 'srv_err')
 * @returns {string[]}
 */
export function fingerprintsByPrefix(prefix) {
  if (!prefix || typeof prefix !== 'string') return [];
  return Object.keys(BUG_FINGERPRINT_REGISTRY).filter((key) => {
    const meta = BUG_FINGERPRINT_REGISTRY[key];
    return meta.category === prefix;
  });
}
