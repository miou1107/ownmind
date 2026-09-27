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
 * The list is a field rather than something re-guessed from the prose every time, because a
 * field can be corrected and a guess cannot. It is filled from the prose when the rule is
 * written without one, and `required_skills_source` records whether a person set it:
 *
 *   'auto'   — filled from the text; refilled whenever the text changes
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

/** A line that talks about skills at all. */
const SKILL_WORD_RE = /skill|技能|スキル/i;

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
 * Only names in backticks count, and only in a rule that mentions skills somewhere, because
 * backticks also hold file names, commands and flags. Within such a rule:
 *
 *   - a name on a line that itself mentions skills counts in any shape (`pdf`, `simplify`)
 *   - elsewhere, only a hyphenated or plugin-prefixed name counts; a bare word such as `git`
 *     or `bash` is far more often a program than a skill
 *
 * It is a first guess that a person can overwrite, not a verdict: see the header.
 *
 * @param {string} content the rule's text
 * @returns {string[]} distinct names in order of appearance, at most REQUIRED_SKILLS_MAX
 */
export function extractSkillNames(content) {
  const text = String(content ?? '');
  if (!SKILL_WORD_RE.test(text)) return [];

  const found = [];
  for (const line of text.split('\n')) {
    const lineMentionsSkills = SKILL_WORD_RE.test(line);
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const name = toSkillName(m[1]);
      if (!name || !plausibleSkill(name)) continue;
      if (!lineMentionsSkills && !/[-:]/.test(name)) continue;
      if (!found.includes(name)) found.push(name);
      if (found.length >= REQUIRED_SKILLS_MAX) return found;
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
 * every rule for the check to start working.
 *
 * @param {{ content?: string, metadata?: object|null }} rule
 * @returns {string[]}
 */
export function requiredSkillsOf(rule) {
  const stored = rule?.metadata?.required_skills;
  if (Array.isArray(stored)) {
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
    if (!unchanged || incoming.required_skills_source === 'manual') {
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
