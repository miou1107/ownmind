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
import { renderOriginContextSection } from '../src/utils/iron-rule-origin-context.js';

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

/**
 * Issue #197 — names a rule mentions without telling the AI to use them.
 *
 * Four real rules each produced a "this machine cannot follow it" warning for something that is
 * not a skill: an npm package in an incident write-up, the git branch in the generated origin
 * section, a CLI tool, and a project-only skill given as an example. The lines below are close to
 * the ones that produced each name. Every one of these rules mentions skills somewhere, which was
 * enough for any hyphenated name in backticks to count.
 */
describe('names a rule mentions without telling the AI to use them (#197)', () => {
  it('a package named in an incident write-up is not a skill', () => {
    const text = '修法：`hooks/lib/conditional-sync-cli.js` 起 static import，鏈到 `js-yaml`，'
      + '結果 `~/.claude/skills/ownmind-iron-rules/` 這個 big skill 永遠不更新。';
    assert.deepEqual(extractSkillNames(text), []);
  });

  it('the generated origin section is skipped: its branch and folder are not skills', () => {
    const origin = renderOriginContextSection({
      captured_at: '2026-07-30T04:08:51.349Z', confidence: 'high', project: 'some-app',
      cwd: '/Users/someone/some-app', git_branch: 'ghost-account-recovery',
      event: 'A review by a subagent missed it.', user_quote: 'check with a second skill',
    });
    const body = '排查時 SOP 或 skill 文件描述的機制不能盡信，要回程式碼確認。';
    assert.deepEqual(extractSkillNames(`${body}\n\n${origin}\n`), []);
  });

  it('a skill named above the origin section still counts', () => {
    const origin = renderOriginContextSection({ git_branch: 'feature-branch', cwd: '/tmp/x-y' });
    assert.deepEqual(extractSkillNames(`Use the \`code-review\` skill.\n\n${origin}`), ['code-review']);
  });

  it('a tool the draft is sent to is not a skill, even on a line that says skill', () => {
    const text = '2. 兩隻 skill 跑完之後，再把草稿送 `agy` 做一次用詞審查。';
    assert.deepEqual(extractSkillNames(text), []);
  });

  it('names listed in a checklist, without being called or named skills, do not count', () => {
    const text = '有沒有用 skill？工具呼叫紀錄裡，`tone-draft`、`tone-polish`、`agy` 用詞審查四項是不是都跑過？';
    assert.deepEqual(extractSkillNames(text), []);
  });

  it('a skill given as an example is not required; the ones the rule calls are', () => {
    const text = '動筆之前先調用 `tone-draft`（資訊架構），文字寫完再調用 `tone-polish`。'
      + '專案有自己的文案 skill（例如 funpass 的 `funpass-report-copy`）時，先跑那一份。';
    assert.deepEqual(extractSkillNames(text), ['tone-draft', 'tone-polish']);
  });

  it('an example stays an example even right next to a verb', () => {
    assert.deepEqual(extractSkillNames('專案自己有 skill 時先跑那一份，例如調用 `local-only`。'), []);
    assert.deepEqual(extractSkillNames('Projects may add their own skill, e.g. use the `local-only` skill.'), []);
  });

  it('every name in a list that is called counts', () => {
    assert.deepEqual(extractSkillNames('先調用技能 `a-one`、`b-two` 與 `c-three`。'), ['a-one', 'b-two', 'c-three']);
    assert.deepEqual(extractSkillNames('`a-one` 與 `b-two` 兩個技能都要跑。'), ['a-one', 'b-two']);
  });

  it('a verb alone does not make a bare word a skill; calling it a skill does', () => {
    assert.deepEqual(extractSkillNames('This rule is about skills. Run `git` first.'), []);
    assert.deepEqual(extractSkillNames('This rule is about skills. Run the `pdf` skill first.'), ['pdf']);
  });

  it('a guess stored by an older version is redone from the text; a person\'s list is not', () => {
    const text = '修法鏈到 `js-yaml`，結果那個 skill 不更新。';
    assert.deepEqual(requiredSkillsOf({ content: text, metadata: { required_skills: ['js-yaml'], required_skills_source: 'auto' } }), []);
    assert.deepEqual(requiredSkillsOf({ content: text, metadata: { required_skills: ['js-yaml'], required_skills_source: 'manual' } }), ['js-yaml']);
  });
});

describe('review of the #197 guessing', () => {
  it('long runs of spaces read in linear time', () => {
    // The first version took 0.9 s on 20,000 spaces: two adjacent \s* retried on every split.
    const started = Date.now();
    extractSkillNames(`skill${' '.repeat(50000)}x \`a-b\``);
    extractSkillNames(`skill ${'`a` '.repeat(20000)}`);
    assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
  });

  it('a negated verb mentions a skill so as not to use it', () => {
    assert.deepEqual(extractSkillNames('不用 `a-b` 這個 skill。'), []);
    assert.deepEqual(extractSkillNames('Skills: never invoke `a-b`, don\'t use the `c-d` skill.'), []);
    assert.deepEqual(extractSkillNames('瀏覽器的 skill：用 `ego-browser`，不用 `claude-in-chrome`。'), ['ego-browser']);
  });

  it('叫 alone names something; 再叫 calls it', () => {
    assert.deepEqual(extractSkillNames('這條跟 skill 有關：套件叫 `js-yaml`，分支叫 `ghost-account-recovery`。'), []);
    assert.deepEqual(extractSkillNames('先用技能起稿，寫完之後再叫 `humanizer-tw` 檢查。'), ['humanizer-tw']);
  });

  it('bold or quote marks around a name do not hide it', () => {
    assert.deepEqual(extractSkillNames('先調用 **`x-y`** skill。'), ['x-y']);
    assert.deepEqual(extractSkillNames('寫中文前一定要調用「`zh-copy`」這個技能。'), ['zh-copy']);
  });

  it('an example in an earlier clause does not reach a name called for real', () => {
    assert.deepEqual(extractSkillNames('例如寫報告時，要先調用 `zh-tw-doc-copy`。這是 skill 規則。'), ['zh-tw-doc-copy']);
  });

  it('a plugin-prefixed name counts wherever it sits in a rule about skills', () => {
    const text = '以下三個 skill 必須調用：\n1. 完成實作後 → `superpowers:verification-before-completion`';
    assert.deepEqual(extractSkillNames(text), ['superpowers:verification-before-completion']);
    assert.deepEqual(extractSkillNames('This skill rule mentions `trigger:deploy` and `node:fs`.'), []);
  });

  it('more ways rules call a skill', () => {
    assert.deepEqual(extractSkillNames('Use a skill called `foo`.'), ['foo']);
    assert.deepEqual(extractSkillNames('`a-b`、`c-d` 這兩個技能都要跑。'), ['a-b', 'c-d']);
  });

  it('metadata read before /init redid the guess and sent back is still a guess', () => {
    // An AI read ['js-yaml'] (the old guess), /init rewrote it to [], then the AI sent the
    // metadata it had read back with another change. That must not freeze the old guess.
    const r = resolveRequiredSkills({
      incoming: { required_skills: ['js-yaml'], required_skills_source: 'auto', note: 'x' },
      previous: { required_skills: [], required_skills_source: 'auto' },
      content: 'skill 鏈到 `js-yaml`', contentChanged: false,
    });
    assert.deepEqual(r.fields, { required_skills: [], required_skills_source: 'auto' });
  });
});
