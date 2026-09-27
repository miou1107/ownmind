/**
 * Issue #139 — which skills an iron rule tells the AI to use.
 *
 * The report: a rule said to call `zh-tw-doc-copy` before writing Chinese and `humanizer-tw`
 * after. Neither was installed, the rule was delivered anyway, and nothing said so. These
 * cases pin how a rule's needs are read (shared/required-skills.js); tests/missing-skills.test.js
 * covers what a machine does with them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSkillNames, normalizeRequiredSkills, requiredSkillsOf, resolveRequiredSkills,
  requiredSkillsNote, REQUIRED_SKILLS_MAX,
} from '../shared/required-skills.js';

/** Close to the rule in the report: the skill names sit in backticks in Chinese prose. */
const REPORTED_RULE = [
  '## 規則',
  '寫任何要給人讀的中文之前，先用技能 `zh-tw-doc-copy` 起稿；寫完之後再叫 `humanizer-tw` 檢查。',
  '',
  '## 為什麼',
  '直接寫出來的中文太像翻譯稿，改寫過的文件存在 `docs/` 底下。',
].join('\n');

describe('reading a rule\'s text', () => {
  it('finds both skills in the rule from the report', () => {
    assert.deepEqual(extractSkillNames(REPORTED_RULE), ['zh-tw-doc-copy', 'humanizer-tw']);
  });

  it('a rule that never mentions skills names none, whatever it quotes', () => {
    // The ordinary iron rule: commands, flags and file names in backticks, no skill at all.
    const text = '寫 `set -e` 腳本不准加 `2>/dev/null`。改完跑 `npm test`，看 `hooks/lib/x.js` 跟 `pre-commit`。';
    assert.deepEqual(extractSkillNames(text), []);
  });

  it('in a rule that does mention skills, a bare word elsewhere is not taken for one', () => {
    // `git` and `bash` are programs far more often than skills; only a line that itself talks
    // about skills can make a bare word count.
    const text = 'Use the `code-review` skill.\nThen run `git` and `bash` as usual.';
    assert.deepEqual(extractSkillNames(text), ['code-review']);
  });

  it('a bare word on a line that talks about skills counts', () => {
    assert.deepEqual(extractSkillNames('Always call the `pdf` skill for PDFs.'), ['pdf']);
  });

  it('a slash command is read as the skill it is', () => {
    assert.deepEqual(extractSkillNames('Run the `/simplify` skill before committing.'), ['simplify']);
  });

  it('a plugin-prefixed skill keeps its prefix; trigger tags and node modules do not count', () => {
    const text = 'Use skill `superpowers:brainstorming` first. Tagged `trigger:deploy`, see `node:fs`.';
    assert.deepEqual(extractSkillNames(text), ['superpowers:brainstorming']);
  });

  it('names file paths and anything with a dot or a space as nothing', () => {
    const text = 'The skill lives in `skills/foo-bar/SKILL.md`; also `foo.bar-baz` and `two words`.';
    assert.deepEqual(extractSkillNames(text), []);
  });

  it('versions, ports and encodings are not skills, even in a rule about skills', () => {
    // Measured in review: all four came out of a rule that mentioned skills, and each one
    // would have become a warning on every machine that loads the rule.
    const text = 'Use the skill `x-y`. Server on `localhost:3000`, cache `redis:7`, `utf-8`, `node-20`, `git-bash`.';
    assert.deepEqual(extractSkillNames(text), ['x-y']);
  });

  it('a person may still name such a thing on purpose', () => {
    // The exclusions are for guessing. A list someone writes is taken as written.
    assert.deepEqual(normalizeRequiredSkills(['utf-8']), { ok: true, skills: ['utf-8'] });
  });

  it('a name mentioned twice is listed once, and the list is capped', () => {
    // Letters, not digits: a part that is only digits reads as a version, not a skill.
    const many = Array.from({ length: 15 }, (_, i) => `\`skill-${String.fromCharCode(97 + i)}\``).join(' ');
    assert.equal(extractSkillNames(`skills: ${many} \`skill-a\``).length, REQUIRED_SKILLS_MAX);
    assert.deepEqual(extractSkillNames('skill `a-b` and again `a-b`'), ['a-b']);
  });

  it('empty and missing text read as needing nothing', () => {
    assert.deepEqual(extractSkillNames(''), []);
    assert.deepEqual(extractSkillNames(undefined), []);
  });
});

describe('a list someone wrote', () => {
  it('is tidied: slash dropped, duplicates removed', () => {
    assert.deepEqual(normalizeRequiredSkills(['/a-b', 'a-b', 'c']), { ok: true, skills: ['a-b', 'c'] });
  });

  it('an empty list is a real answer', () => {
    assert.deepEqual(normalizeRequiredSkills([]), { ok: true, skills: [] });
  });

  it('refuses what is not a list of skill names, and says which one', () => {
    assert.equal(normalizeRequiredSkills('zh-tw-doc-copy').ok, false);
    const bad = normalizeRequiredSkills(['ok-name', 'Not A Skill']);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /"Not A Skill"/);
    assert.equal(normalizeRequiredSkills([42]).ok, false);
  });

  it('refuses more than the cap', () => {
    const tooMany = Array.from({ length: REQUIRED_SKILLS_MAX + 1 }, (_, i) => `s-${i}`);
    assert.equal(normalizeRequiredSkills(tooMany).ok, false);
  });
});

describe('what a stored rule needs', () => {
  it('the field wins over the text, including an empty field', () => {
    assert.deepEqual(requiredSkillsOf({ content: REPORTED_RULE, metadata: { required_skills: ['x-y'] } }), ['x-y']);
    assert.deepEqual(requiredSkillsOf({ content: REPORTED_RULE, metadata: { required_skills: [] } }), []);
  });

  it('a rule saved before the field existed is read from its text', () => {
    assert.deepEqual(requiredSkillsOf({ content: REPORTED_RULE, metadata: null }),
      ['zh-tw-doc-copy', 'humanizer-tw']);
  });

  it('a corrupted field reads as nothing rather than as garbage', () => {
    assert.deepEqual(requiredSkillsOf({ content: '', metadata: { required_skills: ['BAD NAME'] } }), []);
  });
});

describe('what a write stores', () => {
  const guessed = { required_skills: ['zh-tw-doc-copy', 'humanizer-tw'], required_skills_source: 'auto' };

  it('a new rule without the field gets the guess', () => {
    const r = resolveRequiredSkills({ incoming: { tool: 'x' }, previous: undefined, content: REPORTED_RULE, contentChanged: true });
    assert.deepEqual(r, { ok: true, fields: guessed });
  });

  it('a list the caller sends is kept as theirs', () => {
    const r = resolveRequiredSkills({ incoming: { required_skills: ['only-this'] }, previous: guessed, content: REPORTED_RULE, contentChanged: false });
    assert.deepEqual(r.fields, { required_skills: ['only-this'], required_skills_source: 'manual' });
  });

  it('a bad list is refused before anything is written', () => {
    const r = resolveRequiredSkills({ incoming: { required_skills: 'nope' }, previous: undefined, content: '', contentChanged: true });
    assert.equal(r.ok, false);
  });

  it('a person\'s list survives an edit to the text', () => {
    const mine = { required_skills: ['keep-me'], required_skills_source: 'manual' };
    const r = resolveRequiredSkills({ incoming: undefined, previous: mine, content: 'skill `other-one`', contentChanged: true });
    assert.deepEqual(r.fields, mine);
  });

  it('and survives metadata sent without it — metadata replaces the stored object', () => {
    // The update tool REPLACES metadata. An AI changing some other key would otherwise erase
    // a list the person set.
    const mine = { required_skills: ['keep-me'], required_skills_source: 'manual' };
    const r = resolveRequiredSkills({ incoming: { tool: 'claude-code' }, previous: mine, content: 'x', contentChanged: false });
    assert.deepEqual(r.fields, mine);
  });

  it('a guess sent back untouched is still a guess', () => {
    // The update tool tells callers to send back all the metadata they read. That is not a
    // person deciding the list is right, and must not freeze the guess.
    const r = resolveRequiredSkills({ incoming: { ...guessed, tool: 'x' }, previous: guessed, content: 'use skill `new-one`', contentChanged: true });
    assert.deepEqual(r.fields, { required_skills: ['new-one'], required_skills_source: 'auto' });
  });

  it('confirming a guess on purpose makes it a person\'s list', () => {
    const r = resolveRequiredSkills({ incoming: { ...guessed, required_skills_source: 'manual' }, previous: guessed, content: REPORTED_RULE, contentChanged: false });
    assert.deepEqual(r.fields, { required_skills: guessed.required_skills, required_skills_source: 'manual' });
  });

  it('a guess is redone when the text changes, and kept when it does not', () => {
    const redone = resolveRequiredSkills({ incoming: undefined, previous: guessed, content: 'use skill `new-one`', contentChanged: true });
    assert.deepEqual(redone.fields, { required_skills: ['new-one'], required_skills_source: 'auto' });
    const kept = resolveRequiredSkills({ incoming: undefined, previous: guessed, content: 'use skill `new-one`', contentChanged: false });
    assert.deepEqual(kept.fields, guessed);
  });
});

describe('telling the author what was guessed', () => {
  it('names the guess and how to correct it', () => {
    const note = requiredSkillsNote({ required_skills: ['a-b', 'c-d'], required_skills_source: 'auto' });
    assert.match(note, /a-b, c-d/);
    assert.match(note, /metadata\.required_skills/);
  });

  it('says nothing for a list a person set, or for no skills at all', () => {
    assert.equal(requiredSkillsNote({ required_skills: ['a-b'], required_skills_source: 'manual' }), null);
    assert.equal(requiredSkillsNote({ required_skills: [], required_skills_source: 'auto' }), null);
    assert.equal(requiredSkillsNote(null), null);
  });
});
