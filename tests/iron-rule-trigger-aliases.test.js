import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TRIGGER_TAG_ALIASES, ruleMatchesTrigger } from '../shared/helpers.js';

/**
 * `detectCommandTrigger` only ever answers commit / deploy / delete, and the hooks used to
 * keep a rule only when one of its tags was literally `trigger:<that word>`. Nothing tells
 * an author those three words are the whole vocabulary — `ownmind_save` takes any tag — so
 * rules get filed under the words people think in and then never fire. Stored, fetched,
 * filtered out, silent exit.
 *
 * Observed on a real account: three iron rules, tagged 回滾 / cleanup / 升級 / install /
 * 除錯, none of them reachable by any trigger.
 */

/** The rule set that exposed this, verbatim. */
const REAL_RULES = [
  { code: 'IR-003', tags: ['trigger:回滾', 'trigger:rollback', 'trigger:還原', 'trigger:cleanup', 'trigger:錯誤處理', 'trigger:升級', 'trigger:除錯', 'trigger:edit', 'trigger:write', 'trigger:design'] },
  { code: 'IR-002', tags: ['trigger:debug', 'trigger:shell', 'trigger:script', 'trigger:除錯', 'trigger:寫腳本', 'trigger:install', 'trigger:靜默失敗', 'trigger:edit', 'trigger:write'] },
  { code: 'IR-001', tags: ['trigger:換金鑰', 'trigger:切換帳號', 'trigger:install', 'trigger:setup', 'trigger:config', 'trigger:credential_rotation', 'trigger:api_key', 'trigger:驗證'] },
];

describe('trigger tag aliases', () => {
  it('a rollback rule is reachable by the operations that can trigger a rollback', () => {
    const ir003 = REAL_RULES.find(r => r.code === 'IR-003');
    assert.equal(ruleMatchesTrigger(ir003, 'delete'), true, 'tagged 回滾/cleanup/還原');
    assert.equal(ruleMatchesTrigger(ir003, 'deploy'), true, 'tagged 升級');
  });

  it('the old filter dropped it — this is the regression being pinned', () => {
    const ir003 = REAL_RULES.find(r => r.code === 'IR-003');
    const oldFilter = (r, trigger) => r.tags.some(t =>
      t === 'trigger:' + trigger || (trigger === 'commit' && t === 'trigger:git')
    );
    for (const trigger of ['commit', 'deploy', 'delete']) {
      assert.equal(oldFilter(ir003, trigger), false);
    }
  });

  it('does not make unrelated rules match — install/debug are not risky operations', () => {
    // Widening the vocabulary must not turn every rule into a reminder on every commit.
    for (const code of ['IR-001', 'IR-002']) {
      const rule = REAL_RULES.find(r => r.code === code);
      for (const trigger of ['commit', 'deploy', 'delete']) {
        assert.equal(ruleMatchesTrigger(rule, trigger), false, `${code} vs ${trigger}`);
      }
    }
  });

  it('keeps the pre-existing contracts', () => {
    assert.equal(ruleMatchesTrigger({ tags: [] }, 'commit'), true, 'untagged matches everything');
    assert.equal(ruleMatchesTrigger({}, 'delete'), true, 'no tags field at all');
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:git'] }, 'commit'), true, 'v1.19.x commit/git case');
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:command'] }, 'deploy'), true, 'command rules are always relevant');
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:deploy'] }, 'deploy'), true, 'the canonical name still works');
  });

  it('matches tags case-insensitively', () => {
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:Deploy'] }, 'deploy'), true);
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:CLEANUP'] }, 'delete'), true);
  });

  it('an unknown trigger falls back to its own name only', () => {
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:review'] }, 'review'), true);
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:回滾'] }, 'review'), false);
  });

  /**
   * v1.26.155 — the outward send.
   *
   * A team standard requiring an independent review before anything leaves was tagged
   * `trigger:send` by its author, and nothing had ever asked for that tag. Measured
   * 2026-08-12: it had never fired, including on the issue filed that same afternoon.
   */
  describe('outward send', () => {
    it('reaches the standard that was written for it', () => {
      assert.equal(ruleMatchesTrigger({ tags: ['trigger:send'] }, 'send'), true);
      assert.equal(ruleMatchesTrigger({ tags: ['trigger:送出'] }, 'send'), true);
      assert.equal(ruleMatchesTrigger({ tags: ['trigger:對外'] }, 'send'), true);
    });

    it('publish and 發布 match a send AND a deploy, because the word decides nothing', () => {
      // 發布新版本 is a deploy; 發布一篇文章 is an outward send. Whoever writes the memory
      // cannot know which bucket their tag lands in, so it lands in both. The cost of the
      // extra match is one line on an operation it does not apply to; the cost of picking
      // one is a rule that stays silent on the operation it was written for — and the
      // standard behind this gives the tiebreaker: what goes out cannot be taken back.
      for (const tag of ['trigger:publish', 'trigger:發布', 'trigger:發佈']) {
        assert.equal(ruleMatchesTrigger({ tags: [tag] }, 'send'), true, `${tag} vs send`);
        assert.equal(ruleMatchesTrigger({ tags: [tag] }, 'deploy'), true, `${tag} vs deploy`);
      }
    });

    it('does not drag the deploy-only vocabulary along with it', () => {
      // Otherwise every deployment standard turns up on a reply to an issue, which is the
      // noise this whole filter exists to remove.
      for (const tag of ['trigger:部署', 'trigger:kubectl', 'trigger:上線', 'trigger:升級']) {
        assert.equal(ruleMatchesTrigger({ tags: [tag] }, 'send'), false, `${tag} vs send`);
      }
    });

    it('and a send tag does not make something fire on a commit', () => {
      assert.equal(ruleMatchesTrigger({ tags: ['trigger:send'] }, 'commit'), false);
      assert.equal(ruleMatchesTrigger({ tags: ['trigger:對外'] }, 'edit'), false);
    });
  });
});

describe('the .sh hook has no copy of the table to drift', () => {
  const sh = readFileSync(new URL('../hooks/ownmind-iron-rule-check.sh', import.meta.url), 'utf8');

  /**
   * It used to have one. The filter was built inside `node -e`, and a module cannot be
   * imported from there without handing node a path — the move behind two silent Windows
   * failures (v1.26.88, v1.26.90) — so the table was duplicated and this file checked the two
   * copies still agreed.
   *
   * v1.26.151 moved the rendering into hooks/ownmind-render-context.js, which the hook runs
   * BY path as argv. That is a different thing from interpolating a path into source, and it
   * is what the hook already did for its other helpers. The file imports `ruleMatchesTrigger`,
   * so there is no second table left — which is a stronger guarantee than a test comparing
   * two of them, and the reason this describe asserts absence rather than agreement.
   */
  it('no longer carries an inline ALIASES table', () => {
    assert.doesNotMatch(sh, /const ALIASES = \{/,
      'a reinstated copy is the drift this change removed — put new aliases in TRIGGER_TAG_ALIASES');
  });

  it('does not filter rules itself at all', () => {
    assert.doesNotMatch(sh, /accepted\.add\('trigger:command'\)/);
    assert.doesNotMatch(sh, /r\.tags/,
      'tag matching belongs to ruleMatchesTrigger, reached through ownmind-render-context.js');
  });

  it('the renderer it delegates to imports the shared table', () => {
    const renderer = readFileSync(
      new URL('../hooks/ownmind-render-context.js', import.meta.url), 'utf8');
    assert.match(renderer, /import \{ ruleMatchesTrigger \} from '\.\.\/shared\/helpers\.js'/);
    // And the table it reaches is this module's, not a re-declaration next to the import.
    assert.doesNotMatch(renderer, /const ALIASES = \{/);
    assert.ok(TRIGGER_TAG_ALIASES.deploy.includes('部署'),
      'sanity: the shared table is the one carrying the vocabulary');
  });
});
