import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { suggestSkillMdFormat } from '../src/utils/iron-rule-suggest.js';
import { detectFrontmatter } from '../src/utils/iron-rule-frontmatter.js';
import { lintIronRule } from '../src/utils/iron-rule-quality.js';

/**
 * v1.18.0 — iron-rule-suggest 測試
 *
 * suggestSkillMdFormat 接 legacy rule、機械式拼 SKILL.md proposal。
 * 必須：
 *   1. 已是 SKILL.md 偵測到 → already_skill_md=true、原樣回
 *   2. Legacy → proposed_content 有合法 frontmatter
 *   3. proposed_content 過 lintIronRule (round-trip)
 *   4. notes 提示來源 / LLM 未啟用 / 缺 trigger tag 等
 */

describe('v1.18.0 — suggestSkillMdFormat', () => {
  it('已是 SKILL.md → already_skill_md=true、原樣回', () => {
    const skillMdRule = {
      id: 1, code: 'IR-001',
      title: 'X',
      content: `---\nname: ir-001-x\ndescription: |\n  Use when X happens. Required to do Y. Triggers on: edit.\n---\n\n# IR-001: X\n\n規則必須遵守。`,
      tags: ['trigger:edit'],
    };
    const r = suggestSkillMdFormat(skillMdRule);
    assert.equal(r.already_skill_md, true);
    assert.equal(r.proposed_content, skillMdRule.content);
    assert.match(r.notes.join(' '), /已是 SKILL.md 格式/);
  });

  it('Legacy → already_skill_md=false、proposed 有合法 frontmatter', () => {
    const legacy = {
      id: 2, code: 'IR-002',
      title: '不要 commit .env 或密碼',
      content: 'commit 前不要把 .env、credentials 等敏感檔 push 上 git。萬一 commit 了立刻 git filter-branch 移除歷史、輪換 key。',
      tags: ['trigger:commit', 'trigger:git'],
    };
    const r = suggestSkillMdFormat(legacy);
    assert.equal(r.already_skill_md, false);
    const fm = detectFrontmatter(r.proposed_content);
    assert.equal(fm.has, true, 'proposed 必須有 frontmatter');
    assert.equal(fm.parseError, undefined, 'frontmatter YAML 必須合法');
    assert.equal(typeof fm.frontmatter.name, 'string');
    assert.equal(typeof fm.frontmatter.description, 'string');
  });

  it('Legacy proposed_content 過 lintIronRule', () => {
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
    assert.equal(lintResult.ok, true, `lint 必須過、errors: ${JSON.stringify(lintResult.errors)}`);
  });

  it('Legacy 無 trigger tag → notes 警告 + description 用 general', () => {
    const legacy = {
      id: 99, code: 'IR-099',
      title: '無觸發測試規則',
      content: '這條鐵律沒有 trigger tag。內容必須足夠長以通過 lint 檢查。應該做的事就是這個。不該做的就是相反的事。'.repeat(2),
      tags: [],
    };
    const r = suggestSkillMdFormat(legacy);
    assert.match(r.notes.join(' '), /無 trigger:xxx tag/);
    assert.match(r.proposed_content, /general/i);
  });

  it('notes 提示 LLM 未啟用 (template-based)', () => {
    const legacy = {
      id: 4, code: 'IR-004',
      title: '測試規則',
      content: '內容夠長、規則必須遵守、不要違反。'.repeat(5),
      tags: ['trigger:edit'],
    };
    const r = suggestSkillMdFormat(legacy);
    assert.match(r.notes.join(' '), /LLM suggest 未啟用|Template-based/);
  });

  it('proposed name 是 ASCII kebab-case (review I4: 跨平台 fs 安全)', () => {
    const legacy = {
      id: 5, code: 'IR-005',
      title: '不要 BLIND edit',
      content: '不要盲目編輯、必須先讀檔。'.repeat(10),
      tags: ['trigger:edit'],
    };
    const r = suggestSkillMdFormat(legacy);
    const fm = detectFrontmatter(r.proposed_content);
    assert.match(fm.frontmatter.name, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      `name 必須 ASCII kebab-case、實際: ${fm.frontmatter.name}`);
    // 不能含中文
    assert.ok(!/[一-鿿]/.test(fm.frontmatter.name),
      `name 不可含中文 (跨平台 fs 風險)、實際: ${fm.frontmatter.name}`);
  });

  it('純中文 title → name 用 hash + code (無 ASCII hint)', () => {
    const legacy = {
      id: 6, code: 'IR-039',
      title: '修報表加查詢條件讓數字歸零前先檢查資料',
      content: '修報表加查詢條件讓數字歸零前必須先檢查資料是不是還在、避免誤判資料缺失。'.repeat(3),
      tags: ['trigger:bug'],
    };
    const r = suggestSkillMdFormat(legacy);
    const fm = detectFrontmatter(r.proposed_content);
    assert.match(fm.frontmatter.name, /^ir-039-[a-f0-9]{6}$/,
      `純中文 title → ir-XXX-{6 字 hash}、實際: ${fm.frontmatter.name}`);
  });

  it('mixed title (中英) → name 含 ASCII hint + hash', () => {
    const legacy = {
      id: 7, code: 'IR-002',
      title: '不要 commit env 或密碼',
      content: 'commit 前不要 push .env、必須先檢查、否則密碼會外洩。'.repeat(3),
      tags: ['trigger:commit'],
    };
    const r = suggestSkillMdFormat(legacy);
    const fm = detectFrontmatter(r.proposed_content);
    // 應該抓到 commit/env 兩個 ASCII 詞
    assert.match(fm.frontmatter.name, /^ir-002-(commit|env)/,
      `應抓 commit / env ASCII hint、實際: ${fm.frontmatter.name}`);
    assert.match(fm.frontmatter.name, /-[a-f0-9]{6}$/,
      `結尾應為 6 字 hash、實際: ${fm.frontmatter.name}`);
  });
});
