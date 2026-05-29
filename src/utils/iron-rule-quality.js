import { detectFrontmatter } from './iron-rule-frontmatter.js';
import { validateOriginContext } from './iron-rule-origin-context.js';

/**
 * lintIronRule — iron-rule quality check (program-level enforcement of IR-027).
 *
 * v1.18.0 upgrade: detect SKILL.md frontmatter
 *   - has frontmatter   -> schema lint S1-S9 (spec.md §1.3)
 *   - no frontmatter    -> v1.17.94 regex lint (backward compatible, the 35
 *     existing iron rules still pass)
 *
 * v1.17.94 rules (used when there is no frontmatter):
 *   1. title length 5~100
 *   2. content length 50~3000
 *   3. must have at least one trigger:xxx tag
 *   4. content must contain "scenario section" keywords
 *   5. content must contain "rule section" keywords
 *   6. context-dependent phrases are forbidden
 *   7. mixed Chinese-English check (IR-037)
 *
 * Pure function — does not touch the DB; easy to test and reuse.
 *
 * @param {Object} rule - { title, content, tags }
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   warnings?: string[],
 *   format?: 'skill_md' | 'legacy_text'
 * }}
 *   - ok: true only when errors is empty (warnings do not count)
 *   - format: for the server response, so the client can show which lint path ran
 */
export function lintIronRule(rule) {
  const content = (rule?.content || '').trim();

  // v1.18.0: detect frontmatter first — if present, run schema lint
  const fm = detectFrontmatter(content);
  let result;
  if (fm.has) {
    // v1.18.0 review B1 fix: YAML parse failure -> fall back to legacy regex lint.
    //   Rationale: a user may write `---` as a divider (not really a SKILL.md),
    //   so rejecting outright on parseError is confusing. Fall back + warn the
    //   user "detected but failed to parse".
    if (fm.parseError) {
      const legacyResult = lintLegacyTextRule(rule);
      const warnings = [...(legacyResult.warnings || [])];
      warnings.push(
        `Detected a frontmatter marker (---) but YAML parsing failed (${fm.parseError}) — ` +
        `falling back to free-text lint. If you meant to write SKILL.md format, fix the YAML syntax; if --- is just a content divider, ignore this warning.`
      );
      result = { ...legacyResult, warnings };
    } else {
      result = lintSkillMdRule(rule, fm);
    }
  } else {
    result = lintLegacyTextRule(rule);
  }

  // v1.18.2: origin_context check (lenient design — warning, not a reject)
  const originCheck = checkOriginContext(rule);
  if (originCheck.warnings.length > 0) {
    result.warnings = [...(result.warnings || []), ...originCheck.warnings];
  }
  if (originCheck.errors.length > 0) {
    // Only an invalid origin_context structure (present but malformed) is an error
    result.errors = [...(result.errors || []), ...originCheck.errors];
    result.ok = false;
  }
  return result;
}

/**
 * v1.18.2: check metadata.origin_context
 *   - no origin_context     -> warning ("encourage recording the backstory")
 *   - present but malformed  -> error
 *   - present and valid      -> silent
 */
function checkOriginContext(rule) {
  const oc = rule?.metadata?.origin_context;
  if (oc === undefined || oc === null) {
    return {
      warnings: [
        'Consider adding metadata.origin_context to record the backstory (why this iron rule was created / in which project / the user\'s original words) — not blocking, but a future AI will come back asking when it cannot follow the history.'
      ],
      errors: [],
    };
  }
  const v = validateOriginContext(oc);
  if (!v.ok) {
    return { warnings: [], errors: v.errors.map(e => `origin_context: ${e}`) };
  }
  return { warnings: [], errors: [] };
}

/**
 * v1.18.0 — SKILL.md frontmatter schema lint (rules S1-S9)
 * Aligned with spec.md §1.3
 *
 * @param {Object} rule
 * @param {{ has: boolean, frontmatter?: object, body?: string, parseError?: string }} fm
 *   detectFrontmatter() result
 */
export function lintSkillMdRule(rule, fm) {
  const errors = [];
  const warnings = [];
  const tags = Array.isArray(rule?.tags) ? rule.tags : [];

  // S1 — YAML parses successfully
  if (fm.parseError) {
    errors.push(`S1 frontmatter YAML parse failed: ${fm.parseError}`);
    return { ok: false, errors, warnings, format: 'skill_md' };
  }

  const frontmatter = fm.frontmatter;
  const body = (fm.body || '').trim();

  // S2 — name required, kebab-case, ASCII only
  //
  // v1.18.0-rc3 review I4 fix: we briefly accepted Chinese BMP chars, but that
  //   is dangerous for cross-platform fs (macOS NFC/NFD normalize mismatch,
  //   Linux git path breaks across platforms)
  //   -> tightened back to ASCII only. The suggest helper now derives name from
  //   "title hash + ASCII hint".
  //
  // Aligned with the official Anthropic SKILL.md examples (pdf, xlsx,
  // skill-creator), which are all ASCII.
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!name) {
    errors.push('S2 frontmatter is missing the name field (required)');
  } else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
    errors.push(`S2 name "${name}" is not kebab-case (must match ^[a-z0-9-]+$, no leading/trailing -, ASCII only)`);
  }

  // S3 — name length 3-60
  if (name) {
    if (name.length < 3) errors.push(`S3 name too short (${name.length} chars, min 3)`);
    else if (name.length > 60) errors.push(`S3 name too long (${name.length} chars, max 60)`);
  }

  // S4 — description required, 20-500 chars
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) {
    errors.push('S4 frontmatter is missing the description field (required — must state when it triggers / 「何時觸發」)');
  } else {
    if (description.length < 20) errors.push(`S4 description too short (${description.length} chars, min 20) — if it is unclear the AI will not trigger this iron rule`);
    else if (description.length > 500) errors.push(`S4 description too long (${description.length} chars, max 500) — a summary should not exceed 500 chars; put details in the body`);
  }

  // S5 — description contains a trigger word
  if (description && description.length >= 20) {
    if (!/when|whenever|use\s+when|triggers\s+on|何時|觸發|情境|準備|要做/i.test(description)) {
      errors.push('S5 description does not state when it triggers — must contain a trigger word such as 「when / 何時 / 觸發 / 情境 / 準備」, so the AI knows when to invoke this iron rule');
    }
  }

  // S6 — body length ≥ 100
  if (body.length < 100) {
    errors.push(`S6 body too short (${body.length} chars, min 100) — the body is the detail the AI reads; too short loses the do/don't lesson of the iron rule`);
  }

  // S7 — body contains rule-section keywords (carried over from v1.17.94 #5)
  if (body.length >= 100 && !/規則|該做|不該做|禁止|必須|應該|不可|不要/.test(body)) {
    errors.push('S7 body is missing a rule section — must spell out 「規則該做什麼 / 不該做什麼 / 禁止 / 必須」, otherwise the AI cannot tell what to do');
  }

  // S8 — removed in v1.18.1 — IR-037 mixed Chinese-English should not apply to SKILL.md body.
  // Same reason as removing rule #7 in lintLegacyTextRule:
  //   IR-037 is for "AI replies"; the reply-lint Stop hook already handles that.
  //   An iron-rule body is a "technical note" for the AI — having tech terms is natural.
  //   Evidence: 26 of 35 prod iron rules failed (74%), 17 of them on IR-037 — a design
  //   error, not an over-strict rule.

  // S9 — description length < 50 -> warning (not a reject)
  if (description && description.length >= 20 && description.length < 50) {
    warnings.push(`S9 description is a bit short at ${description.length} chars (50+ recommended — more pushy, higher AI trigger rate)`);
  }

  // tags structure check (preserves v1.17.94 reviewer Minor 3 behaviour)
  if (rule?.tags !== undefined && rule?.tags !== null && !Array.isArray(rule.tags)) {
    errors.push(`tags must be an array, got ${typeof rule.tags}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    format: 'skill_md',
  };
}

/**
 * v1.17.94 — legacy free-text lint (used when there is no frontmatter)
 */
export function lintLegacyTextRule(rule) {
  const errors = [];
  const title = (rule?.title || '').trim();
  const content = (rule?.content || '').trim();

  // v1.17.94 reviewer Minor 3: tags must be an array; give a clear message for other types
  if (rule?.tags !== undefined && rule?.tags !== null && !Array.isArray(rule.tags)) {
    errors.push(`tags must be an array, got ${typeof rule.tags} (value: ${JSON.stringify(rule.tags).slice(0, 50)})`);
  }
  const tags = Array.isArray(rule?.tags) ? rule.tags : [];

  // (1) title length (min 5 so a short real title like "時區強制定標準" at 7 chars passes; keep 100 max)
  if (title.length < 5) {
    errors.push(`title too short (${title.length} chars) — title needs at least 5 chars and should state the scenario`);
  } else if (title.length > 100) {
    errors.push(`title too long (${title.length} chars) — title max is 100 chars; too long makes the iron-rule list hard to read`);
  }

  // (2) content length (min lowered to 50 so the existing IR-020 at 48 chars is close to passing; new rules 100+ recommended)
  if (content.length < 50) {
    errors.push(`content too short (${content.length} chars) — not enough information, min 50 chars (100+ recommended)`);
  } else if (content.length > 3000) {
    errors.push(`content too long (${content.length} chars) — over 3000 chars, the point gets lost, please trim`);
  }

  // (3) trigger:xxx tag
  const triggers = tags.filter(t => typeof t === 'string' && t.startsWith('trigger:'));
  if (triggers.length === 0) {
    errors.push('missing a trigger:xxx tag — without a trigger word the AI does not know when to recall this iron rule. tags must contain at least one of trigger:edit / trigger:commit / trigger:deploy etc.');
  }

  // (4) scenario section (v1.17.94 reviewer Important 1: expanded keywords)
  // Accepted phrasings: 「什麼時候適用」「觸發情境」「使用時機」「在什麼場合」「適用場景」「用於」「用在」
  const hasScenarioSection = /適用|觸發|情境|何時|什麼時候|時機|場合|場景|用於|用在/.test(content);
  if (!hasScenarioSection) {
    errors.push('missing a scenario section — the content must explain 「什麼時候適用 / 觸發情境 / 使用時機 / 適用場景」, otherwise a future AI cannot tell when to trigger it');
  }

  // (5) rule section
  const hasRuleSection = /規則|該做|不該做|禁止|必須|應該|不可|不要/.test(content);
  if (!hasRuleSection) {
    errors.push('missing a rule section — the content must spell out 「規則該做什麼 / 不該做什麼 / 禁止 / 必須」, otherwise the reader cannot tell what to do');
  }

  // (6) context-dependent phrases are forbidden
  const contextPhrases = ['上次', '之前那個', '剛剛', '這次 session', '這次對話', '剛才那個', '剛才那條'];
  const foundContextPhrases = contextPhrases.filter(p => content.includes(p));
  if (foundContextPhrases.length > 0) {
    errors.push(
      `Context-dependent phrases make a future AI lose the thread — found: ${foundContextPhrases.join('、')}. Please rewrite without relying on the current context (e.g. use 「v1.17.92 的修法」 instead of 「上次的修法」)`
    );
  }

  // (7) removed in v1.18.1 — the IR-037 mixed Chinese-English check should not apply to "iron-rule content"
  //
  // Why it was removed:
  //   IR-037 ("replies must be plain Chinese, no mixed Chinese-English") was designed for
  //   "AI replies"; the reply-lint Stop hook (v1.17.96) already handles that.
  //
  //   Iron-rule content itself is a "technical note for the AI" — having tech terms like
  //   docker / Python / OpenSpec / Bob / Alice is natural. Applying IR-037 to iron-rule
  //   lint is "the right rule in the wrong place", not "the rule being too strict".
  //
  //   Evidence: the v1.18.1 audit script ran 35 prod iron rules, 26 failed (74%), 17 of
  //   them on the IR-037 mixed-language threshold — proving that applying IR-037 to
  //   iron-rule content is a design error, not an isolated case.
  //
  //   v1.17.94 shipped for 6 months without anyone noticing because lint only ran on
  //   POST/PUT, never back-validating existing rows, which masked it. The upgrade
  //   assistant blew the problem open, which is a good thing.

  return {
    ok: errors.length === 0,
    errors,
    warnings: [],
    format: 'legacy_text',
  };
}

/**
 * Mixed Chinese-English check
 * Rule: collect runs of English words, subtract a whitelist (tech terms, code);
 * fail if they exceed 10% of the total character count.
 */
function checkMixedLanguage(content) {
  // Whitelist: common tech terms that do not count as mixed
  // v1.17.94 reviewer Important 2: expanded to avoid false-positives blocking reasonable rules
  const techWhitelist = new Set([
    // General protocols / data formats
    'API', 'SQL', 'SSH', 'URL', 'HTTP', 'HTTPS', 'JSON', 'TSV', 'CSV', 'XML',
    'YAML', 'CLI', 'UI', 'UX', 'AI', 'LLM', 'MCP', 'CI', 'CD', 'PR',
    // Platforms / tools
    'OwnMind', 'GitHub', 'GitLab', 'Git', 'Docker', 'Dockerfile', 'Linux', 'Mac', 'Windows',
    'Node', 'npm', 'Postgres', 'PostgreSQL', 'Redis', 'AES', 'Caddy', 'Nginx',
    // SQL keywords
    'WHERE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'FROM', 'COPY',
    'COALESCE', 'NULL', 'IS', 'AS', 'ON', 'AND', 'OR', 'NOT',
    // Dev actions / workflow terms
    'IR', 'commit', 'deploy', 'edit', 'fix', 'bug', 'debug', 'PR',
    'push', 'pull', 'force', 'build', 'cache', 'rebase', 'merge', 'checkout',
    'env', 'file', 'path', 'repo', 'hash', 'port', 'host', 'log', 'test', 'run',
    'code', 'type', 'name', 'key', 'value', 'health', 'endpoint',
    // Business terms (common when discussing hidden data / observability)
    'filter', 'cutoff', 'audit', 'admin', 'session', 'context',
    // AI tool names
    'Claude', 'Codex', 'Cursor', 'Copilot', 'Gemini', 'ChatGPT', 'Antigravity',
    'OpenCode', 'Windsurf',
    // OwnMind internal docs / concepts
    'README', 'CHANGELOG', 'FILELIST', 'SKILL', 'Skill', 'OpenSpec',
    'Spec', 'Memory', 'Project', 'Adapter', 'status', 'Status',
    'Format', 'Reference', 'reference',
  ]);

  // Strip code blocks (``` ... ```), inline code (`...`), and links
  let cleaned = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // keep the text of a markdown link

  // Collect all runs of 4+ English letters
  const words = cleaned.match(/[A-Za-z]{4,}/g) || [];

  // Subtract the whitelist (case-insensitive)
  const mixedWords = words.filter(w => {
    const lower = w.toLowerCase();
    const upper = w.toUpperCase();
    return !techWhitelist.has(w) && !techWhitelist.has(lower) && !techWhitelist.has(upper);
  });

  if (mixedWords.length === 0) return null;

  // Compute the ratio: total English letters / total content chars
  const englishCharCount = mixedWords.reduce((sum, w) => sum + w.length, 0);
  const totalCharCount = cleaned.replace(/\s/g, '').length;
  const ratio = totalCharCount > 0 ? englishCharCount / totalCharCount : 0;

  // v1.17.94 reviewer Important 2 compromise: threshold raised from 10% to 15%
  // Gives reasonable room to absorb 1-2 missing tech terms, while still blocking
  // an obvious violation like "a whole English paragraph"
  if (ratio > 0.15) {
    return `Mixed Chinese-English ratio ${(ratio * 100).toFixed(1)}% > 15% (IR-037 violation) — found ${mixedWords.length} non-whitelisted English words (first 5: ${mixedWords.slice(0, 5).join(', ')}). Please rewrite in plain Chinese; tech terms may stay (e.g. SQL/API/IR-XXX)`;
  }

  return null;
}
