/**
 * OwnMind Verification Engine.
 *
 * Pure-function module with zero external deps and no runtime binding.
 * Shared by the git hooks (L1/L5), the PreToolUse hook (L2) and MCP (L3).
 *
 * Core API:
 *   evaluateConditions(conditions, context) → { pass: boolean, failures: string[] }
 *
 * Four guiding principles:
 *   1. Never trust the LLM — invoked by the harness, not by AI itself.
 *   2. Don't rely on a single mechanism — one engine, three entry points.
 *   3. Install and forget — automatically reads rules from cache.
 *   4. Remediate after the fact — failures feed upgrade warnings.
 */

// ============================================================
// Simple glob matcher (avoids the minimatch dependency).
// Supports * (single segment) and ** (cross-directory).
// ============================================================

function globMatch(file, pattern) {
  // Exact match.
  if (file === pattern) return true;

  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex meta-chars (keep * and ?)
    .replace(/\*\*/g, '§§')               // stash **
    .replace(/\*/g, '[^/]*')              // * = single segment
    .replace(/§§/g, '.*')                 // ** = cross-directory
    .replace(/\?/g, '[^/]');              // ? = single character

  return new RegExp(`^${regex}$`).test(file);
}

// ============================================================
// CHECK_HANDLERS — one pure function per check type.
// ============================================================

const CHECK_HANDLERS = {
  /**
   * Staged files must include every pattern.
   * Missing ctx.stagedFiles → return true (skip the check).
   */
  staged_files_include: (params, ctx) => {
    if (!ctx.stagedFiles) return true;
    const missing = params.patterns.filter(p =>
      !ctx.stagedFiles.some(f => globMatch(f, p))
    );
    return missing.length === 0;
  },

  /**
   * Staged files must not include any of the patterns.
   * Missing ctx → return true.
   */
  staged_files_exclude: (params, ctx) => {
    if (!ctx.stagedFiles) return true;
    const found = params.patterns.filter(p =>
      ctx.stagedFiles.some(f => globMatch(f, p))
    );
    return found.length === 0;
  },

  /**
   * Commit message must contain at least one of the given strings.
   * Missing ctx → return true.
   */
  commit_message_contains: (params, ctx) => {
    if (!ctx.commitMessage) return true;
    return params.patterns.some(p => ctx.commitMessage.includes(p));
  },

  /**
   * Commit message must not contain any of the given strings.
   * Missing ctx → return true.
   */
  commit_message_not_contains: (params, ctx) => {
    if (!ctx.commitMessage) return true;
    return !params.patterns.some(p => ctx.commitMessage.includes(p));
  },

  /**
   * The session must have a matching comply record.
   * Missing ctx.complianceEvents → return true (skip; another layer checks).
   */
  recent_event_exists: (params, ctx) => {
    if (!ctx.complianceEvents) return true;
    return ctx.complianceEvents.some(e =>
      e.event === params.event && e.action === params.action
    );
  },

  /**
   * Did any source-code file change?
   * Missing ctx → return false (semantics: when uncertain, don't trigger).
   */
  source_files_changed: (params, ctx) => {
    if (!ctx.changedSourceFiles) return false;
    return params.patterns.some(p =>
      ctx.changedSourceFiles.some(f => globMatch(f, p))
    );
  },

  /**
   * Bash command must match at least one regex pattern (v1.19.20).
   * Use case: "the command must contain X" — e.g. docker build must include
   * --no-cache. Missing ctx.command → return true (no command, skip).
   * Invalid regex pattern → treated as a non-match (conservative).
   */
  command_matches: (params, ctx) => {
    if (!ctx.command) return true;
    return params.patterns.some(p => {
      try {
        return new RegExp(p).test(ctx.command);
      } catch {
        return false;
      }
    });
  },

  /**
   * Bash command must NOT match any regex pattern (v1.19.20).
   * Use case: "the command must not contain X" — e.g. no sshpass.
   * Missing ctx.command → return true.
   * Invalid regex pattern → treated as a non-match (i.e. no violation).
   */
  command_not_matches: (params, ctx) => {
    if (!ctx.command) return true;
    return !params.patterns.some(p => {
      try {
        return new RegExp(p).test(ctx.command);
      } catch {
        return false;
      }
    });
  }
};

// ============================================================
// FIX_HINTS — actionable remediation message per check type.
//
// Hint strings are deliberately kept in Chinese because:
//   1. They are shown directly to the user/AI as actionable guidance.
//   2. Tests assert on the exact Chinese substrings
//      (`'，請 git add ... 後重試'`, `'不要帶 rule_code'`).
// ============================================================

const FIX_HINTS = {
  staged_files_include: (params, ctx) => {
    if (!ctx.stagedFiles) return '';
    const missing = params.patterns.filter(p =>
      !ctx.stagedFiles.some(f => globMatch(f, p))
    );
    return missing.length > 0 ? `，請 git add ${missing.join(' ')} 後重試` : '';
  },
  staged_files_exclude: (params, ctx) => {
    if (!ctx.stagedFiles) return '';
    const found = params.patterns.filter(p =>
      ctx.stagedFiles.some(f => globMatch(f, p))
    );
    return found.length > 0 ? `，請 git reset HEAD ${found.join(' ')} 移除` : '';
  },
  commit_message_contains: () => '，請修改 commit message',
  commit_message_not_contains: () => '，請修改後重試',
  // Today every rule's params.action is 'comply'; if 'violate' / 'skip' show
  // up later the hint will still apply but read slightly oddly (e.g. "please
  // call ... action: 'violate'") — revisit then.
  // JSON.stringify safely embeds the event / action literal (avoids single
  // quotes / special chars breaking the JS literal).
  recent_event_exists: (params) => {
    const event = JSON.stringify(params.event);
    const action = JSON.stringify(params.action);
    return `，請呼叫：ownmind_report_compliance({ rule_title: ${event}, action: ${action} })` +
      `（注意：不要帶 rule_code、否則 event 欄位會被覆蓋）`;
  },
  command_matches: (params) => `，指令必須符合：${params.patterns.join(' 或 ')}`,
  command_not_matches: (params) => `，指令不能含：${params.patterns.join(' 或 ')}`,
};

// ============================================================
// evaluateConditions — recursively walks the condition tree.
// ============================================================

/**
 * Evaluate a verification condition.
 *
 * Three node shapes are supported:
 *   1. Leaf       — { type, params, message }
 *   2. Composite  — { operator: "AND"|"OR", checks: [...] }
 *   3. Conditional — { when: {...}, then: {...} }
 *
 * @param {object} conditions - the verification.conditions block
 * @param {object} context - data supplied by the runtime
 * @returns {{ pass: boolean, failures: string[] }}
 */
function evaluateConditions(conditions, context) {
  // when/then conditional.
  if (conditions.when) {
    const whenResult = evaluateConditions(conditions.when, context);
    if (!whenResult.pass) {
      // when is false → not applicable → pass.
      return { pass: true, failures: [] };
    }
    // when is true → evaluate then.
    return evaluateConditions(conditions.then, context);
  }

  // Leaf: single check.
  if (conditions.type) {
    const handler = CHECK_HANDLERS[conditions.type];
    if (!handler) return { pass: true, failures: [] }; // unknown type, safe skip
    const pass = handler(conditions.params, context);
    if (pass) return { pass: true, failures: [] };
    const baseMsg = conditions.message || conditions.type;
    const hintFn = FIX_HINTS[conditions.type];
    const hint = hintFn ? hintFn(conditions.params, context) : '';
    return { pass: false, failures: [baseMsg + hint] };
  }

  // Composite: AND / OR.
  if (!conditions.checks || !Array.isArray(conditions.checks)) {
    return { pass: true, failures: [] }; // invalid shape, safe skip
  }

  const results = conditions.checks.map(c => evaluateConditions(c, context));

  if (conditions.operator === 'OR') {
    const allFail = results.every(r => !r.pass);
    return { pass: !allFail, failures: allFail ? results.flatMap(r => r.failures) : [] };
  }

  // Default AND (also covers cases where operator is missing).
  const failures = results.flatMap(r => r.failures);
  return { pass: failures.length === 0, failures };
}

// ============================================================
// Exports
// ============================================================

export { evaluateConditions, CHECK_HANDLERS, globMatch };
