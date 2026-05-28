/**
 * shared/language-lint.js — language-quality lint shared library (v1.17.95).
 *
 * Why this exists:
 *   The same two checks need to run in two places:
 *     - mixed Chinese/English ratio too high (event LINT_LANGUAGE_MIXED_RATIO)
 *     - jargon without a plain-Chinese explanation (event
 *       LINT_JARGON_EXPLANATION_REQUIRED)
 *   1. v1.17.94 iron-rule quality lint (when writing a rule)
 *   2. v1.17.95 reply lint (when AI replies — Stop hook integration came later)
 *
 *   Lifted to shared/ so both call sites import the same module and the logic
 *   never drifts.
 *
 *   v1.20.4: violation entries' `rule` field now uses neutral event constants
 *   and no longer hardcodes personal iron-rule codes (IR-XXX). The
 *   "event → personal rule code" mapping is resolved by callers via a rule
 *   cache lookup.
 *
 * Main exports:
 *   - TECH_WHITELIST: 80+ tech terms (OwnMind-approved, not counted as mixed)
 *   - checkMixedLanguage(content, threshold): mixed-ratio check
 *   - checkJargonExplanation(content): jargon check
 *   - lintReply(content): run both and return {ok, violations}
 *
 * Design:
 *   - Pure functions, no IO, easy to test
 *   - Cross-platform (Mac/Linux/Windows) — pure JS, no native bindings
 */

// v1.20.4: lint event constants imported from the neutral module; we no
// longer hardcode personal iron-rule codes.
import {
  LINT_LANGUAGE_MIXED_RATIO,
  LINT_JARGON_EXPLANATION_REQUIRED,
} from './lint-event-types.js';

// Whitelist: common tech / OwnMind concept words, not counted as mixed.
// Same list as v1.17.94's src/utils/iron-rule-quality.js.
// v1.19.3: grown from 80 to 200+ words across 8 categories based on a
//          30-day audit of the top-30 most-flagged terms.
export const TECH_WHITELIST = new Set([
  // ─── 1. General protocols / data formats (v1.17.94 baseline) ───
  'API', 'SQL', 'SSH', 'URL', 'HTTP', 'HTTPS', 'JSON', 'JSONL', 'TSV', 'CSV', 'XML',
  'YAML', 'CLI', 'UI', 'UX', 'AI', 'LLM', 'MCP', 'CI', 'CD', 'PR',
  'TCP', 'UDP', 'WebSocket', 'SSE', 'OAuth', 'JWT', 'REST', 'GraphQL', 'gRPC',
  // ─── 2. Platforms / tools (v1.17.94 baseline + v1.19.3 expansion) ───
  'OwnMind', 'GitHub', 'GitLab', 'Git', 'Docker', 'Dockerfile', 'Linux', 'Mac', 'Windows',
  'Node', 'npm', 'Postgres', 'PostgreSQL', 'Redis', 'AES', 'Caddy', 'Nginx',
  'Kubernetes', 'k8s', 'Apache', 'AWS', 'GCP', 'Azure', 'Vercel', 'Netlify',
  // ─── 3. SQL keywords (v1.17.94 baseline) ───
  'WHERE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'FROM', 'COPY',
  'COALESCE', 'NULL', 'IS', 'AS', 'ON', 'AND', 'OR', 'NOT',
  // ─── 4. Dev actions / workflow terms (v1.17.94 + v1.19.3 top-30 expansion) ───
  'IR', 'commit', 'commits', 'deploy', 'edit', 'fix', 'bug', 'debug',
  'push', 'pull', 'force', 'build', 'cache', 'rebase', 'merge', 'checkout',
  'env', 'file', 'path', 'repo', 'hash', 'port', 'host', 'log', 'test', 'tests', 'run',
  'code', 'type', 'name', 'key', 'value', 'health', 'endpoint',
  'install', 'uninstall', 'update', 'upgrade', 'script', 'module',
  'import', 'export', 'require',
  // v1.19.3: audit Top 30 — Git / dev workflow
  'main', 'origin', 'branch', 'worktree', 'remote', 'tag', 'stash',
  'review', 'reviewer', 'prod', 'staging', 'spec', 'prompt', 'task', 'tasks',
  'pipeline', 'stage', 'chunk', 'monorepo', 'redirect', 'apply', 'archive',
  'container', 'fresh', 'trigger', 'success', 'failure',
  'plan', 'publish', 'deploy', 'rollback', 'hotfix', 'release',
  // v1.19.3: audit Top 30 — common technical concepts
  'hook', 'render', 'retry', 'batch', 'topic', 'vertical', 'horizontal',
  'server', 'client', 'handoff', 'project', 'brand', 'token', 'title',
  'async', 'await', 'callback', 'promise', 'middleware', 'dispatcher',
  'payload', 'handler', 'router', 'service', 'factory', 'singleton',
  'instance', 'function', 'class', 'interface', 'schema',
  'array', 'string', 'boolean', 'number', 'error', 'exception', 'timeout',
  'queue', 'lock', 'mutex', 'throttle', 'debounce', 'polling',
  'request', 'response', 'header', 'body', 'query', 'param',
  'pagination', 'sorting', 'auth',
  // ─── 5. Business terms (v1.17.94 baseline + v1.19.3 expansion) ───
  'filter', 'cutoff', 'audit', 'admin', 'session', 'context',
  'fetch', 'sync', 'flush', 'spool', 'pool', 'event', 'events',
  'metric', 'metrics', 'tier', 'role',
  // ─── 6. AI tool names (v1.17.94 baseline + v1.19.3 big-company names) ───
  'Claude', 'Codex', 'Cursor', 'Copilot', 'Gemini', 'ChatGPT', 'Antigravity',
  'OpenCode', 'Windsurf',
  // v1.19.3: audit Top 30 — big-company / big-platform names
  'Google', 'Meta', 'OpenAI', 'Anthropic', 'Microsoft', 'Apple', 'Amazon',
  'Chrome', 'Firefox', 'Safari', 'Edge', 'YouTube', 'Podcast', 'Imagen',
  'Llama', 'Perplexity', 'Remotion', 'Evernote', 'Sheets', 'Slides', 'Docs',
  'Drive', 'Gmail', 'Calendar', 'Slack', 'Discord', 'Telegram', 'LINE',
  'Notion', 'Figma', 'Looker', 'Tableau',
  // ─── 7. OwnMind internal docs / concepts (v1.17.94 baseline + v1.19.3) ───
  'README', 'CHANGELOG', 'FILELIST', 'SKILL', 'Skill', 'OpenSpec',
  'Spec', 'Memory', 'Project', 'Adapter', 'status', 'Status',
  'Format', 'Reference', 'reference',
  'Pipeline', 'Step', 'Phase', 'Stage', 'Notes', 'Research', 'Description',
  // ─── 8. Vin's personal project names (v1.19.3 added, audit Top 30) ───
  'adog', 'fapa', 'fontrip', 'ring', 'ownmind', 'vincent',
  'auto', 'speech', 'ima', 'asir', 'funit', 'majitreats',
  'kkvin', 'tutorial', 'rescue', 'narrative',
  // ─── 9. v1.19.5 missing-word fixes (uncovered by real misses) ───
  // shell / terminal / console family: v1.19.4 test reply self-introduction missed
  'terminal', 'shell', 'console', 'stdout', 'stderr', 'tty',
  // Release verbs
  'bump',
  // Tech terms exposed by v1.19.4 test prompts
  'Suspense', 'Concurrent', 'Pod', 'Saga', 'Envoy', 'Istio',
  'sidecar', 'service mesh', 'kubernetes',
  'monad', 'functor', 'applicative', 'observable',
  'mergeMap', 'switchMap', 'concatMap', 'combineLatest',
  'ajax', 'fromEvent', 'subscribe', 'pipe',
  // Microservices / distributed
  'choreography', 'orchestration', 'orchestrator',
  // Functional programming
  'Maybe', 'Either', 'Just', 'Nothing',
  // React / frontend
  'hydration', 'reactive', 'Reactive',
]);

// v1.19.5: lowercase version of the whitelist for case-insensitive lookup.
// Why it exists: v1.19.3 originally did `TECH_WHITELIST.has(w.toLowerCase())`
// which looks normalized but Set.has is exact string match. The whitelist
// holds 'Claude' (PascalCase), so lookups of 'claude' always returned false.
// Real miss: Vin's v1.19.4 new-session intro "我是 claude" — claude slipped
// through and triggered a violation.
export const TECH_WHITELIST_LOWER = new Set(
  Array.from(TECH_WHITELIST).map(w => w.toLowerCase())
);

/**
 * v1.19.3: detect "isolated capitalized word" as a proper noun (person
 * name, brand) and skip it.
 * Rule: leading uppercase + 1 or more lowercase letters (e.g. Google, Eric,
 * Phoebe). All-caps words (AWS, IDE) are already in TECH_WHITELIST and
 * caught earlier.
 */
export function looksLikeProperNoun(word) {
  return /^[A-Z][a-z]+$/.test(word);
}

/**
 * v1.19.3: detect whether content has code blocks / inline code (so we can
 * loosen the threshold).
 */
function hasCodeMarkers(content) {
  return /```[\s\S]*?```|`[^`]+`/.test(content);
}

/**
 * v1.19.3: detect whether this is a code-review context (contains
 * 'code review' / 'code-review', case-insensitive).
 */
function isCodeReviewContext(content) {
  return /\bcode[\s-]review\b/i.test(content);
}

/**
 * Strip code blocks, URLs, and markdown links from the content to avoid
 * false positives.
 */
function stripCodeAndLinks(content) {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * Find every 4+ contiguous Latin-letter word, minus the whitelist and
 * v1.19.3 proper-noun filter.
 * v1.19.5: whitelist lookup uses TECH_WHITELIST_LOWER (case-insensitive fix).
 */
function extractNonWhitelistEnglishWords(cleaned) {
  const words = cleaned.match(/[A-Za-z]{4,}/g) || [];
  return words.filter(w => {
    if (TECH_WHITELIST_LOWER.has(w.toLowerCase())) return false;
    // v1.19.3: leading-uppercase isolated words are treated as proper nouns
    // (person / company / brand) and skipped.
    if (looksLikeProperNoun(w)) return false;
    return true;
  });
}

/**
 * Mixed Chinese/English ratio check (event LINT_LANGUAGE_MIXED_RATIO).
 *
 * v1.19.3 changes:
 *   - Threshold varies by context: pure chat 15%, with code marker 25%,
 *     code review exempt.
 *   - extractNonWhitelistEnglishWords filters out proper nouns automatically.
 *
 * @param {string} content
 * @param {number|object} thresholdOrOptions number = forced threshold; object
 *   = { threshold } options
 * @returns {{ok: boolean, ratio: number, mixedWords: string[]}}
 */
export function checkMixedLanguage(content, thresholdOrOptions = undefined) {
  // v1.19.3: code-review context is exempt outright (decided pre-strip on
  // the original content).
  if (typeof content === 'string' && isCodeReviewContext(content)) {
    return { ok: true, ratio: 0, mixedWords: [] };
  }

  // v1.19.3: code markers present → threshold relaxes from 0.15 to 0.25.
  // Dynamic decision only kicks in when caller didn't supply a threshold;
  // an explicit value wins (backward compatibility for tests).
  let threshold;
  if (typeof thresholdOrOptions === 'number') {
    threshold = thresholdOrOptions;
  } else if (thresholdOrOptions && typeof thresholdOrOptions === 'object' && typeof thresholdOrOptions.threshold === 'number') {
    threshold = thresholdOrOptions.threshold;
  } else if (typeof content === 'string' && hasCodeMarkers(content)) {
    threshold = 0.25;
  } else {
    threshold = 0.15;
  }

  const cleaned = stripCodeAndLinks(content);
  const mixedWords = extractNonWhitelistEnglishWords(cleaned);
  if (mixedWords.length === 0) return { ok: true, ratio: 0, mixedWords: [] };

  const englishCharCount = mixedWords.reduce((sum, w) => sum + w.length, 0);
  const totalCharCount = cleaned.replace(/\s/g, '').length;
  const ratio = totalCharCount > 0 ? englishCharCount / totalCharCount : 0;

  return {
    ok: ratio <= threshold,
    ratio,
    mixedWords,
  };
}

/**
 * Scan text and add into seenWords every word that has an explanation
 * within the next 80 characters (i.e. mark already-explained terms).
 *
 * Extracted in v1.20.2 follow-up #3 to be shared across the cross-reply
 * vocabulary memory.
 *
 * Note: the explanation-detector regexes deliberately keep the Chinese
 * tokens "即|也就是|意思是|簡稱" because they identify explanation phrases in
 * Chinese-language replies.
 *
 * @param {string} text - text already stripped of code blocks and links
 * @param {Set<string>} seenWords - cumulative set of explained words (mutated)
 */
function collectExplainedWords(text, seenWords) {
  const wordRegex = /[A-Za-z]{4,}/g;
  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0];
    if (TECH_WHITELIST_LOWER.has(word.toLowerCase())) continue;
    if (looksLikeProperNoun(word)) continue;

    const lowerWord = word.toLowerCase();
    if (seenWords.has(lowerWord)) continue;

    const afterEnd = match.index + word.length;
    const window = text.slice(afterEnd, afterEnd + 80);
    const hasExplanation = /[\(（]/.test(window) ||
                           /[:：]/.test(window) ||
                           /-\s/.test(window) ||
                           /(即|也就是|意思是|簡稱)/.test(window);

    if (hasExplanation) {
      seenWords.add(lowerWord);
    }
  }
}

/**
 * Jargon / technical terms must have a plain-Chinese explanation
 * (event LINT_JARGON_EXPLANATION_REQUIRED).
 *
 * Logic:
 *   - Find non-whitelist English words (≥4 contiguous letters).
 *   - Same word repeated only counts on its first occurrence.
 *   - Within 30 chars after the first occurrence, expect either a
 *     "(plain explanation)" or a ": explanation" — anything else is a
 *     violation.
 *
 * v1.20.2 follow-up #3: cross-reply vocabulary memory.
 *   - historicalCorpus is the concatenated text of all earlier assistant
 *     replies in the session.
 *   - Pre-scan it to populate seenWords with already-explained terms.
 *   - Finally implements the rule's "if explained upstream, skip" clause.
 *
 * @param {string} content - the current reply to check
 * @param {string} [historicalCorpus=''] - concatenated earlier assistant
 *   replies in the same session (optional)
 * @returns {{ok: boolean, jargonWithoutExplanation: string[]}}
 */
export function checkJargonExplanation(content, historicalCorpus = '') {
  const cleaned = stripCodeAndLinks(content);
  const seenWords = new Set();

  // v1.20.2 follow-up #3: pre-scan the historical corpus and seed
  // seenWords with explained terms.
  if (historicalCorpus && typeof historicalCorpus === 'string') {
    const historicalCleaned = stripCodeAndLinks(historicalCorpus);
    collectExplainedWords(historicalCleaned, seenWords);
  }

  const jargonWithoutExplanation = [];

  // Match contiguous English words and their positions.
  const wordRegex = /[A-Za-z]{4,}/g;
  let match;
  while ((match = wordRegex.exec(cleaned)) !== null) {
    const word = match[0];
    const pos = match.index;

    // Whitelist skip (v1.19.5: uses LOWER set to fix case-insensitivity bug).
    if (TECH_WHITELIST_LOWER.has(word.toLowerCase())) {
      continue;
    }

    // v1.19.3: proper noun (person / company name) skip.
    if (looksLikeProperNoun(word)) continue;

    // Same word only counts on first occurrence.
    const lowerWord = word.toLowerCase();
    if (seenWords.has(lowerWord)) continue;
    seenWords.add(lowerWord);

    // v1.19.3: window grown from 50 to 80 chars (Codex adversarial review
    // noted Chinese context needs more room — explanations often spill past
    // 50 chars).
    const afterEnd = pos + word.length;
    const window = cleaned.slice(afterEnd, afterEnd + 80);

    // Accepted explanation forms:
    // 1. Inside parens: (...) or （...）
    // 2. After colon: :... or ：...
    // 3. Leading "即" / "也就是" markers
    // 4. Leading "-" same-position explanation (e.g. refactor - rewrite no behavior change)
    // v1.19.3: explanation no longer needs to sit right after the term;
    //          anywhere within 80 chars works (Chinese context often
    //          spreads supplements across sentences).
    // The Chinese tokens "即|也就是|意思是|簡稱" are kept on purpose: they
    // identify explanation phrases in Chinese-language replies.
    const hasExplanation = /[\(（]/.test(window) ||
                           /[:：]/.test(window) ||
                           /-\s/.test(window) ||
                           /(即|也就是|意思是|簡稱)/.test(window);

    if (!hasExplanation) {
      jargonWithoutExplanation.push(word);
    }
  }

  return {
    ok: jargonWithoutExplanation.length === 0,
    jargonWithoutExplanation,
  };
}

/**
 * Run both checks and return a unified result.
 *
 * v1.20.2 follow-up #3: cross-reply vocabulary memory.
 *   - historicalCorpus is the concatenated text of all earlier assistant
 *     replies in the session.
 *   - When provided, "previously explained terms skip the jargon check"
 *     takes effect.
 *
 * Note: the legacy-fallback violation messages below are deliberately kept
 * in Chinese — they are shown to the AI as guidance to "switch to plain
 * Chinese." Translating them would be self-contradictory and weaken the
 * feedback loop.
 *
 * @param {string} content - the current reply to check
 * @param {string} [historicalCorpus=''] - concatenated earlier assistant
 *   replies in the same session (optional)
 * @returns {{ok: boolean, violations: Array<{rule: string, message: string}>}}
 */
export function lintReply(content, enabledValidatorsOrHistorical, context = {}) {
  // v1.21.0: two calling conventions
  //   - new API: lintReply(content, resolvedValidators, context)
  //     resolvedValidators is [{rule, validator, check, params}, ...] —
  //     the caller has already resolved the check fn.
  //   - legacy API: lintReply(content, historicalCorpus) — backward
  //     compatible; historicalCorpus is a string.
  let resolvedValidators = [];
  let mergedContext = { ...context };
  // v1.26.13: track whether the caller actually used the new API. The old
  // code only switched to the rule-driven path when resolvedValidators was
  // non-empty, so callers that passed an empty array (user opted in to no
  // validators) silently fell through to the legacy fallback below and ran
  // every built-in check unconditionally. That blocked users like Eric who
  // never enabled any jargon/mixed-language rule but still got linted.
  let usingNewAPI = false;
  if (typeof enabledValidatorsOrHistorical === 'string') {
    mergedContext.historicalCorpus = enabledValidatorsOrHistorical;
  } else if (Array.isArray(enabledValidatorsOrHistorical)) {
    resolvedValidators = enabledValidatorsOrHistorical;
    usingNewAPI = true;
  }

  const violations = [];

  // v1.21.0: rule-driven path — run only the caller-resolved validator
  // check functions. v1.26.13: also entered when the array is empty, so an
  // empty opt-in means "skip every check" instead of "run every built-in."
  if (usingNewAPI) {
    for (const entry of resolvedValidators) {
      if (typeof entry.check !== 'function') continue;
      try {
        const result = entry.check(content, entry.params || {}, mergedContext);
        if (!result || result.ok) continue;
        const v = result.violation || {};
        violations.push({
          rule: v.event || entry.validator || 'unknown',
          message: v.message || '',
          detail: v.detail || {},
          sourceRule: entry.rule || '',
        });
      } catch { /* validator internal failure must not break main flow */ }
    }
    return { ok: violations.length === 0, violations };
  }

  // Legacy API fallback: callers that don't pass enabledValidators
  // (backward compatibility — second arg is a string historicalCorpus or
  // undefined). This path is preserved for older callers / tests, not used
  // by the production reply-lint hook since v1.21.0.
  const mixed = checkMixedLanguage(content);
  if (!mixed.ok) {
    violations.push({
      rule: LINT_LANGUAGE_MIXED_RATIO,
      message: `中英混雜比例 ${(mixed.ratio * 100).toFixed(1)}% > 15% — 找到 ${mixed.mixedWords.length} 個非白名單英文詞（前 5：${mixed.mixedWords.slice(0, 5).join(', ')}）。請改成白話中文`,
      detail: { ratio: mixed.ratio, mixedWords: mixed.mixedWords },
    });
  }

  const jargon = checkJargonExplanation(content, mergedContext.historicalCorpus || '');
  if (!jargon.ok) {
    violations.push({
      rule: LINT_JARGON_EXPLANATION_REQUIRED,
      message: `行話 / 專有名詞沒附白話說明 — ${jargon.jargonWithoutExplanation.length} 個詞（${jargon.jargonWithoutExplanation.slice(0, 5).join(', ')}）後面 50 字內沒有「（白話）」「：解釋」「即...」之類補充`,
      detail: { jargon: jargon.jargonWithoutExplanation },
    });
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
