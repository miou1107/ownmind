import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { suggestSkillMdFormat } from '../src/utils/iron-rule-suggest.js';
import { detectFrontmatter } from '../src/utils/iron-rule-frontmatter.js';
import { lintIronRule } from '../src/utils/iron-rule-quality.js';

/**
 * v1.18.0 — iron-rule-suggest tests
 *
 * suggestSkillMdFormat takes a legacy rule and mechanically assembles a
 * SKILL.md proposal. It must:
 *   1. Detect "already SKILL.md" → already_skill_md=true, return as-is.
 *   2. Legacy → proposed_content has valid frontmatter.
 *   3. proposed_content passes lintIronRule (round-trip).
 *   4. notes mentions the source / LLM-not-enabled / missing trigger tag etc.
 */

describe('v1.18.0 — suggestSkillMdFormat', () => {
  it('already SKILL.md → already_skill_md=true, returned as-is', () => {
    const skillMdRule = {
      id: 1, code: 'IR-001',
      title: 'X',
      content: `---\nname: ir-001-x\ndescription: |\n  Use when X happens. Required to do Y. Triggers on: edit.\n---\n\n# IR-001: X\n\n規則必須遵守。`,
      tags: ['trigger:edit'],
    };
    const r = suggestSkillMdFormat(skillMdRule);
    assert.equal(r.already_skill_md, true);
    assert.equal(r.proposed_content, skillMdRule.content);
    assert.match(r.notes.join(' '), /Already in SKILL.md format/);
  });

  it('Legacy → already_skill_md=false; proposed has valid frontmatter', () => {
    const legacy = {
      id: 2, code: 'IR-002',
      title: '不要 commit .env 或密碼',
      content: 'commit 前不要把 .env、credentials 等敏感檔 push 上 git。萬一 commit 了立刻 git filter-branch 移除歷史、輪換 key。',
      tags: ['trigger:commit', 'trigger:git'],
    };
    const r = suggestSkillMdFormat(legacy);
    assert.equal(r.already_skill_md, false);
    const fm = detectFrontmatter(r.proposed_content);
    assert.equal(fm.has, true, 'proposed must have frontmatter');
    assert.equal(fm.parseError, undefined, 'frontmatter YAML must be valid');
    assert.equal(typeof fm.frontmatter.name, 'string');
    assert.equal(typeof fm.frontmatter.description, 'string');
  });

  it('Legacy proposed_content passes lintIronRule', () => {
    const legacy = {
      id: 3, code: 'IR-003',
      title: '修 bug 前先寫 reproduction test',
      content: '修任何 bug 前必須先寫一條 fail 的 test、確認 bug 真的存在、再開始修。修完 test 變綠才算完成。不該跳過寫 test 直接動手修。',
      tags: ['trigger:edit'],
    };
    const r = suggestSkillMdFormat(legacy);
    const lintResult = lintIronRule({
      title: legacy.title,
      content: r.proposed_content,
      tags: legacy.tags,
    });
    assert.equal(lintResult.format, 'skill_md');
    assert.equal(lintResult.ok, true, `lint must pass; errors: ${JSON.stringify(lintResult.errors)}`);
  });

  it('Legacy without trigger tag → notes warns + description uses "general"', () => {
    const legacy = {
      id: 99, code: 'IR-099',
      title: '無觸發測試規則',
      content: '這條鐵律沒有 trigger tag。內容必須足夠長以通過 lint 檢查。應該做的事就是這個。不該做的就是相反的事。'.repeat(2),
      tags: [],
    };
    const r = suggestSkillMdFormat(legacy);
    assert.match(r.notes.join(' '), /no trigger:xxx tag/);
    assert.match(r.proposed_content, /general/i);
  });

  it('notes mentions LLM not enabled (template-based)', () => {
    const legacy = {
      id: 4, code: 'IR-004',
      title: '測試規則',
      content: '內容夠長、規則必須遵守、不要違反。'.repeat(5),
      tags: ['trigger:edit'],
    };
    const r = suggestSkillMdFormat(legacy);
    assert.match(r.notes.join(' '), /LLM suggest 未啟用|Template-based/);
  });

  it('proposed name is ASCII kebab-case (review I4: cross-platform fs safety)', () => {
    const legacy = {
      id: 5, code: 'IR-005',
      title: '不要 BLIND edit',
      content: '不要盲目編輯、必須先讀檔。'.repeat(10),
      tags: ['trigger:edit'],
    };
    const r = suggestSkillMdFormat(legacy);
    const fm = detectFrontmatter(r.proposed_content);
    assert.match(fm.frontmatter.name, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      `name must be ASCII kebab-case; actual: ${fm.frontmatter.name}`);
    // Must not contain Chinese.
    assert.ok(!/[一-鿿]/.test(fm.frontmatter.name),
      `name must not contain Chinese (cross-platform fs risk); actual: ${fm.frontmatter.name}`);
  });

  it('pure-Chinese title → name uses hash + code (no ASCII hint)', () => {
    const legacy = {
      id: 6, code: 'IR-039',
      title: '修報表加查詢條件讓數字歸零前先檢查資料',
      content: '修報表加查詢條件讓數字歸零前必須先檢查資料是不是還在、避免誤判資料缺失。'.repeat(3),
      tags: ['trigger:bug'],
    };
    const r = suggestSkillMdFormat(legacy);
    const fm = detectFrontmatter(r.proposed_content);
    assert.match(fm.frontmatter.name, /^ir-039-[a-f0-9]{6}$/,
      `pure-Chinese title → ir-XXX-{6-char hash}; actual: ${fm.frontmatter.name}`);
  });

  it('mixed title (Chinese + English) → name contains ASCII hint + hash', () => {
    const legacy = {
      id: 7, code: 'IR-002',
      title: '不要 commit env 或密碼',
      content: 'commit 前不要 push .env、必須先檢查、否則密碼會外洩。'.repeat(3),
      tags: ['trigger:commit'],
    };
    const r = suggestSkillMdFormat(legacy);
    const fm = detectFrontmatter(r.proposed_content);
    // Should pick up both commit / env ASCII words.
    assert.match(fm.frontmatter.name, /^ir-002-(commit|env)/,
      `should pick up commit / env ASCII hint; actual: ${fm.frontmatter.name}`);
    assert.match(fm.frontmatter.name, /-[a-f0-9]{6}$/,
      `tail should be a 6-char hash; actual: ${fm.frontmatter.name}`);
  });
});
