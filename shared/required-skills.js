/**
 * shared/required-skills.js — which skills an iron rule tells the AI to use (issue #139).
 *
 * A rule reading "call `zh-tw-doc-copy` before writing Chinese" was delivered to a machine
 * that did not have that skill. The AI read it and could not follow it, and nothing said so:
 * the reminder looked the same either way, and the compliance report said "comply".
 *
 * So a rule now says what it needs, in `metadata.required_skills`, and each machine compares
 * that list with what it has installed (hooks/lib/missing-skills.js).
 *
 * The list is a field, because a field can be corrected and a guess cannot. It is filled from
 * the prose when the rule is written without one, and `required_skills_source` records whether
 * a person set it:
 *
 *   'auto'   — guessed from the text; read from the text again whenever it is used, so a fix
 *              to the guessing reaches every old guess (#197). The stored copy is what the
 *              admin console shows, and /init keeps it in step.
 *   'manual' — sent by the caller; kept as it is until the caller sends another
 *
 * An empty list is a real answer ("this rule needs no skill"), not an absent one.
 */

/** A rule naming more skills than this is prose, not a dependency list. */
export const REQUIRED_SKILLS_MAX = 10;

/**
 * A Claude Code skill name — lowercase letters, digits and hyphens, at most 64 — optionally
 * prefixed by the plugin that provides it (`plugin:skill`).
 */
const NAME = '[a-z0-9][a-z0-9-]{0,63}';
const SKILL_NAME_RE = new RegExp(`^(?:${NAME}:)?${NAME}$`);

/**
 * `node:fs` and `trigger:deploy` have the plugin-prefixed shape and are never skills. The
 * trigger tags are the common case: rules quote them all the time.
 */
const NOT_A_PLUGIN = new Set(['node', 'trigger', 'http', 'https', 'file', 'npm', 'git']);

/** A rule that talks about skills at all. */
const SKILL_WORD_RE = /skill|技能|スキル/i;

/**
 * Issue #197: in a rule that talks about skills, most names in backticks are still not skills
 * the rule tells the AI to use — a package in an incident write-up, a CLI tool the draft is sent
 * to, a project-only skill given as an example. A name counts only when the sentence calls it a
 * skill or calls it up, right next to it.
 */
// Each pattern below is anchored to the name and has no two adjacent unbounded repeats, so it
// runs in linear time; review measured the first version at 0.9 s on 20,000 spaces.
/** Quote marks or bold around a name: `**\`x\`**`, `「\`x\`」`. */
const OPEN_WRAP = '[*_「『"“（(]{0,3}';
const CLOSE_WRAP = '[*_」』"”）)]{0,3}';
/** "the", "a" between a word and the name: `use the \`x\``. */
const ARTICLE = '(?:(?:the|a|an)\\s+)?';
/**
 * Verbs that call something up. 用、跑、執行 also precede CLI tools (`用 \`docker-compose\``), a
 * trade-off kept because rules call skills that way far more often than they quote such tools,
 * and only hyphenated names count after a verb. 叫 alone also means "is named" (套件叫
 * \`js-yaml\`), so it counts only after a word that makes it an instruction (再叫、先叫).
 */
const VERB = '(?:調用|呼叫|叫用|使用|[再先去要就來會請]叫|用|跑|執行|啟用|載入|(?<![A-Za-z])(?:call|invoke|run|use|load|launch))';
/** "skill" (or 技能 / スキル) right before the name: `use skill \`x\``, `a skill called \`x\``, `skills: \`x\``. */
const NOUN_BEFORE_RE = new RegExp(`(?:(?<![A-Za-z])skills?(?:\\s+(?:called|named))?|技能|スキル)\\s*(?:[:：]\\s*)?${ARTICLE}${OPEN_WRAP}$`, 'i');
/** "skill" right after the name: `the \`pdf\` skill`, `\`a\` 與 \`b\` 這兩個技能`. */
const NOUN_AFTER_RE = new RegExp(`^${CLOSE_WRAP}\\s*(?:[這那此]?[兩二三四五六幾]?[個隻支項]\\s*)?(?:skills?(?![A-Za-z])|技能|スキル)`, 'i');
/** A verb right before the name: `調用 \`x\``, `call the \`x\``. */
const VERB_BEFORE_RE = new RegExp(`${VERB}\\s*(?:[:：]\\s*)?${ARTICLE}${OPEN_WRAP}$`, 'i');
/** The same verb negated: `不用 \`x\``, `don't use \`x\`` mention a skill so as not to use it. */
const NEGATED_RE = new RegExp(`(?:不|別|勿|禁止|don'?t|do\\s+not|never|not)\\s*(?:要|准|可|能|得|再)?\\s*${VERB}\\s*(?:[:：]\\s*)?${ARTICLE}${OPEN_WRAP}$`, 'i');
/** How much of the text before a name the patterns above look at. */
const CUE_REACH = 40;
/** Names in a run separated only by these are one list: `\`a\`、\`b\` 與 \`c\``. */
const LIST_GAP_RE = /^[\s、，,／/*_「」『』"“”]*(?:(?:以及|與|和|跟|及|或|and|or|&)[\s、，,／/*_「」『』"“”]*)?$/i;
/** An example is not a requirement: `例如 funpass 的 \`funpass-report-copy\``. */
const EXAMPLE_RE = /例如|比如|譬如|舉例|e\.g\.|for example|for instance|such as/i;
/** How far back an example marker still governs the name, within the same clause. */
const EXAMPLE_REACH = 24;
const CLAUSE_END_RE = /[，；。！？;]/g;

/**
 * The origin section `src/utils/iron-rule-origin-context.js` appends to a rule. It quotes the
 * folder and git branch in backticks, and a branch such as `ghost-account-recovery` has the shape
 * of a skill name.
 */
const ORIGIN_HEADING_RE = /^(#{1,6})\s*起源（自動 render/;

/** The rule's text without the generated origin section (up to the next heading of its level). */
function withoutOriginSection(text) {
  const kept = [];
  let skipLevel = 0;
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (skipLevel && heading && heading[1].length <= skipLevel) skipLevel = 0;
    const origin = ORIGIN_HEADING_RE.exec(line);
    if (origin) skipLevel = origin[1].length;
    if (!skipLevel) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Whether an example marker governs a name: within EXAMPLE_REACH characters before it and in
 * the same clause. 「例如寫報告時，要先調用 \`x\`」 sets a scene, then calls `x` for real.
 *
 * @param {string} before the line up to the name
 */
function isExample(before) {
  const tail = before.slice(-EXAMPLE_REACH);
  let clauseStart = 0;
  for (const m of tail.matchAll(CLAUSE_END_RE)) clauseStart = m.index + 1;
  return EXAMPLE_RE.test(tail.slice(clauseStart));
}

/**
 * Backtick spans on one line, grouped into runs that read as one list.
 *
 * @param {string} line
 * @returns {{ start: number, end: number, names: string[] }[]}
 */
function backtickRuns(line) {
  const runs = [];
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const start = m.index;
    const end = m.index + m[0].length;
    const last = runs[runs.length - 1];
    if (last && LIST_GAP_RE.test(line.slice(last.end, start))) {
      last.names.push(m[1]);
      last.end = end;
    } else {
      runs.push({ start, end, names: [m[1]] });
    }
  }
  return runs;
}

/**
 * Hyphenated words rules quote that are not skills. Only consulted when guessing from the
 * text; a list a person writes is taken as written.
 */
const NOT_A_SKILL = new Set([
  'git-bash', 'pre-commit', 'pre-push', 'commit-msg', 'post-merge', 'post-commit',
  'no-verify', 'dry-run', 'read-only', 'e-mail', 'x-api-key', 'code-point',
]);

/**
 * Whether a well-formed name is plausibly a skill rather than something else in backticks.
 *
 * A part that is only digits marks a version, a port or an encoding — `utf-8`, `node-20`,
 * `localhost:3000`, `redis:7` — never a skill.
 */
function plausibleSkill(name) {
  if (NOT_A_SKILL.has(name)) return false;
  return !name.split(/[-:]/).some((part) => /^\d+$/.test(part));
}

/**
 * Tidy one candidate, or return null when it cannot be a skill name.
 *
 * A leading `/` is dropped because rules name slash commands (`/code-review`) and a slash
 * command is a skill.
 */
function toSkillName(raw) {
  const name = String(raw).trim().replace(/^\//, '');
  if (!SKILL_NAME_RE.test(name)) return null;
  const colon = name.indexOf(':');
  if (colon !== -1 && NOT_A_PLUGIN.has(name.slice(0, colon))) return null;
  return name;
}

/**
 * The skill names a rule's text appears to call for.
 *
 * Only names in backticks count, only in a rule that mentions skills somewhere, and only when
 * the sentence itself says so, right next to the name (a list counts as one name):
 *
 *   - called a skill (`use skill \`pdf\``, `the \`pdf\` skill`, `先用技能 \`x\``): any shape
 *   - called up by a verb (`調用 \`a-b\``, `call \`a-b\``): only a hyphenated or plugin-prefixed
 *     name; a bare word such as `git` after "run" is far more often a program than a skill
 *   - a plugin-prefixed name (`superpowers:brainstorming`) anywhere: nothing else in rules has
 *     that shape once `node:`, `trigger:` and versions are excluded
 *
 * Never counted: the generated origin section, a name an example marker (例如, e.g.) points at
 * in the same clause, and a name after a negated verb (不用、don't use). It is a first guess that
 * a person can overwrite, not a verdict: see the header.
 *
 * @param {string} content the rule's text
 * @returns {string[]} distinct names in order of appearance, at most REQUIRED_SKILLS_MAX
 */
export function extractSkillNames(content) {
  const text = withoutOriginSection(String(content ?? ''));
  if (!SKILL_WORD_RE.test(text)) return [];

  const found = [];
  for (const line of text.split('\n')) {
    for (const run of backtickRuns(line)) {
      const before = line.slice(Math.max(0, run.start - CUE_REACH), run.start);
      if (isExample(line.slice(0, run.start)) || NEGATED_RE.test(before)) continue;
      const calledSkill = NOUN_BEFORE_RE.test(before) || NOUN_AFTER_RE.test(line.slice(run.end, run.end + CUE_REACH));
      const calledUp = calledSkill || VERB_BEFORE_RE.test(before);
      for (const raw of run.names) {
        const name = toSkillName(raw);
        if (!name || !plausibleSkill(name)) continue;
        const prefixed = name.includes(':');
        if (!calledUp && !prefixed) continue;
        if (!calledSkill && !prefixed && !name.includes('-')) continue;
        if (!found.includes(name)) found.push(name);
        if (found.length >= REQUIRED_SKILLS_MAX) return found;
      }
    }
  }
  return found;
}

/**
 * Check a caller-supplied `metadata.required_skills`.
 *
 * @param {unknown} value
 * @returns {{ ok: true, skills: string[] } | { ok: false, error: string }}
 */
export function normalizeRequiredSkills(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'metadata.required_skills must be a list of skill names' };
  }
  const skills = [];
  for (const item of value) {
    const name = typeof item === 'string' ? toSkillName(item) : null;
    if (!name) {
      return {
        ok: false,
        error: `metadata.required_skills: ${JSON.stringify(item)} is not a skill name `
          + '(lowercase letters, digits and hyphens, optionally "plugin:skill")',
      };
    }
    if (!skills.includes(name)) skills.push(name);
  }
  if (skills.length > REQUIRED_SKILLS_MAX) {
    return { ok: false, error: `metadata.required_skills may name at most ${REQUIRED_SKILLS_MAX} skills` };
  }
  return { ok: true, skills };
}

/**
 * The skills a stored rule needs, whether or not the field has been written yet.
 *
 * A rule saved before #139 has no field; its text is read instead, so nobody has to re-save
 * every rule for the check to start working. A stored guess is read from the text too: it was
 * made by whichever version saved it, and an older guess must not outlive a fix to the guessing
 * (#197). Only a list a person set is taken as stored.
 *
 * @param {{ content?: string, metadata?: object|null }} rule
 * @returns {string[]}
 */
export function requiredSkillsOf(rule) {
  const stored = rule?.metadata?.required_skills;
  if (Array.isArray(stored) && rule.metadata.required_skills_source !== 'auto') {
    const checked = normalizeRequiredSkills(stored);
    return checked.ok ? checked.skills : [];
  }
  return extractSkillNames(rule?.content);
}

/**
 * Decide what `required_skills` a write should store, for an iron rule.
 *
 * @param {object} args
 * @param {object|null|undefined} args.incoming  metadata the caller sent (undefined = not sent)
 * @param {object|null|undefined} args.previous  metadata already stored (undefined on create)
 * @param {string} args.content                  the rule's text after this write
 * @param {boolean} args.contentChanged          whether this write changes the text
 * @returns {{ ok: true, fields: { required_skills: string[], required_skills_source: 'auto'|'manual' } | null }
 *   | { ok: false, error: string }}
 *   `fields` is null when nothing about the list needs writing.
 */
export function resolveRequiredSkills({ incoming, previous, content, contentChanged }) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const hadList = Array.isArray(prev.required_skills);

  if (incoming && typeof incoming === 'object' && incoming.required_skills !== undefined) {
    const checked = normalizeRequiredSkills(incoming.required_skills);
    if (!checked.ok) return checked;
    // The update tool tells callers to read the metadata and send all of it back, so the
    // stored list often returns untouched. That is not a person deciding anything: keep
    // whatever it was, or a guess would be frozen as a decision and never redone. Someone
    // confirming a guess as right says so with required_skills_source: 'manual'.
    const unchanged = hadList
      && checked.skills.length === prev.required_skills.length
      && checked.skills.every((s, i) => s === prev.required_skills[i]);
    // A list sent with `required_skills_source: 'auto'` is metadata read earlier and sent back,
    // possibly from before /init redid the guess (#197). It is still a guess, not a decision.
    const echoedGuess = incoming.required_skills_source === 'auto';
    if (!echoedGuess && (!unchanged || incoming.required_skills_source === 'manual')) {
      return { ok: true, fields: { required_skills: checked.skills, required_skills_source: 'manual' } };
    }
  }

  const wasManual = hadList && prev.required_skills_source === 'manual';

  // A person's list survives an edit to the text; a guess is redone from the new text.
  if (wasManual) {
    return { ok: true, fields: { required_skills: prev.required_skills, required_skills_source: 'manual' } };
  }
  if (hadList && !contentChanged) {
    return { ok: true, fields: { required_skills: prev.required_skills, required_skills_source: 'auto' } };
  }
  return { ok: true, fields: { required_skills: extractSkillNames(content), required_skills_source: 'auto' } };
}

/**
 * What to tell whoever saved the rule when the list was guessed, so a wrong guess is seen
 * while the person who can correct it is still there.
 *
 * @param {{ required_skills?: string[], required_skills_source?: string }|null} metadata
 * @returns {string|null}
 */
export function requiredSkillsNote(metadata) {
  const skills = metadata?.required_skills;
  if (metadata?.required_skills_source !== 'auto' || !Array.isArray(skills) || skills.length === 0) {
    return null;
  }
  return `OwnMind read this rule as needing these skills: ${skills.join(', ')}. Each machine `
    + 'that loads the rule will say so if one is not installed there. If that list is wrong, '
    + 'update the rule with metadata.required_skills set to the right list ([] for none).';
}
