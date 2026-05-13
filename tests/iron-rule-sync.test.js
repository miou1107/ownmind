import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildBigSkillMd,
  buildReferenceFile,
  syncToFilesystem,
  syncToAllTools,
  TOOL_TARGETS,
} from '../src/utils/iron-rule-sync.js';

/**
 * v1.18.0 — iron-rule-sync.js 測試
 *
 * Pure builders 直接驗 string output、syncToFilesystem 走 tmp HOME 真實檔案 IO
 * （不 mock fs、實際 mkdir/writeFile/readdir、確保跨平台行為對）。
 */

const SAMPLE_RULES = [
  {
    id: 1,
    code: 'IR-002',
    title: '不要 commit .env 或密碼',
    content: '純文字鐵律 v1.17.94 格式。適用情境：commit 前。規則：必須先檢查、不要 add . 然後不看。',
    tags: ['trigger:commit', 'trigger:git'],
    status: 'active',
  },
  {
    id: 2,
    code: 'IR-003',
    title: '修 bug 前先寫 reproduction test',
    content: `---
name: ir-003-bug-reproduction-test
description: |
  Use when about to fix any bug. Required so the fix can be verified and won't regress.
  Triggers on: bug fix, debug, edit related to broken behavior.
---

# IR-003: 修 bug 前先寫 reproduction test

## 為什麼存在
2026-03 起、修 bug 沒測試的規則。

## 該做
- 先寫一條 fail 的 test、確認 bug
- 修 → test 變綠
- 不該跳過先寫 test 直接修`,
    tags: ['trigger:edit', 'trigger:debug'],
    status: 'active',
  },
];

describe('v1.18.0 — buildBigSkillMd', () => {
  it('回字串、含 SKILL.md frontmatter (name + description)', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    assert.match(md, /^---\nname: ownmind-iron-rules\n/, '必須以 SKILL.md frontmatter 開頭');
    assert.match(md, /description: \|/);
    assert.match(md, /Use whenever you do ANY action covered by Vin's iron rules/);
    assert.match(md, /\n---\n/, '必須有結尾 marker');
  });

  it('description 提到 N 條鐵律總數', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    // description 會 word-wrap、用 [\s\S]*? 容忍中間 \n
    assert.match(md, /OwnMind has 2 iron[\s\S]*?rules/);
  });

  it('觸發索引按 trigger 分類', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    assert.match(md, /### trigger: commit/);
    assert.match(md, /### trigger: git/);
    assert.match(md, /### trigger: edit/);
    assert.match(md, /### trigger: debug/);
  });

  it('每條鐵律列出 code + title + reference path', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    assert.match(md, /\*\*IR-002\*\*: 不要 commit .env 或密碼/);
    assert.match(md, /references\/ir-002-/);
    assert.match(md, /\*\*IR-003\*\*: 修 bug 前先寫/);
    assert.match(md, /references\/ir-003-/);
  });

  it('觸發索引輸出 deterministic（按字母排序）', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    const triggerHeaders = (md.match(/### trigger: \w+/g) || []);
    const triggerNames = triggerHeaders.map(h => h.replace('### trigger: ', ''));
    assert.deepEqual(triggerNames, [...triggerNames].sort(), 'trigger 區塊必須按字母排序');
  });

  it('無 trigger tag 的鐵律歸 general', () => {
    const md = buildBigSkillMd([{
      id: 99, code: 'IR-099', title: 'No trigger rule', content: '...', tags: [],
    }]);
    assert.match(md, /### trigger: general/);
  });

  it('空 rules → 仍輸出 frontmatter + 0 條訊息', () => {
    const md = buildBigSkillMd([]);
    assert.match(md, /name: ownmind-iron-rules/);
    assert.match(md, /OwnMind has 0 iron[\s\S]*?rules/);
  });
});

describe('v1.18.0 — buildReferenceFile', () => {
  it('已是 SKILL.md 格式 → 原樣回', () => {
    const r = SAMPLE_RULES[1];  // IR-003 是 SKILL.md
    const out = buildReferenceFile(r);
    assert.equal(out, r.content, '合法 SKILL.md 應原樣回');
  });

  it('Legacy free-text → 自動補 minimal frontmatter', () => {
    const r = SAMPLE_RULES[0];  // IR-002 是 legacy
    const out = buildReferenceFile(r);
    assert.match(out, /^---\nname: ir-002\n/);
    assert.match(out, /description: \|/);
    assert.match(out, /IR-002: 不要 commit \.env 或密碼/);
    assert.match(out, /Triggers on: commit, git/);
    assert.match(out, /auto-generated[\s\S]*?legacy/, 'description 提示自動生成 (跨 wrap 行也算)');
    // body 包含原內容
    assert.ok(out.includes(r.content), 'body 必須含原 content');
  });

  it('Legacy 無 trigger tag → general 分類', () => {
    const out = buildReferenceFile({
      id: 99, code: 'IR-099', title: 'X', content: '內容', tags: [],
    });
    assert.match(out, /Triggers on: general/);
  });

  it('frontmatter 解析失敗 → 視為 legacy（auto-wrap）', () => {
    const out = buildReferenceFile({
      id: 4, code: 'IR-004', title: 'broken', tags: ['trigger:edit'],
      content: `---\n: invalid : yaml :\n---\n\nbody`,
    });
    assert.match(out, /^---\nname: ir-004\n/);
    assert.match(out, /auto-generated/);
  });
});

let tmpHome;

function setup() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-sync-test-'));
}
function cleanup() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

describe('v1.18.0 — syncToFilesystem (Claude Code skill folder)', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('父目錄 ~/.claude/skills 不存在 → skip + reason', () => {
    const r = syncToFilesystem(SAMPLE_RULES, 'claude', { home: tmpHome });
    assert.equal(r.written, false);
    assert.match(r.reason, /tool not installed/);
  });

  it('父目錄存在 → 寫 SKILL.md + references/', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude/skills'), { recursive: true });
    const r = syncToFilesystem(SAMPLE_RULES, 'claude', { home: tmpHome });
    assert.equal(r.written, true);
    const skillPath = path.join(tmpHome, '.claude/skills/ownmind-iron-rules/SKILL.md');
    assert.ok(fs.existsSync(skillPath));
    const refDir = path.join(tmpHome, '.claude/skills/ownmind-iron-rules/references');
    const refFiles = fs.readdirSync(refDir);
    assert.equal(refFiles.length, 2);
    assert.ok(refFiles.some(f => f.startsWith('ir-002')));
    assert.ok(refFiles.some(f => f.startsWith('ir-003')));
  });

  it('重跑 sync → 舊 reference 被清掉、不殘留 disabled 鐵律', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude/skills'), { recursive: true });
    syncToFilesystem(SAMPLE_RULES, 'claude', { home: tmpHome });
    // 模擬第二次 sync：剩下 1 條（IR-003 被 disable）
    syncToFilesystem([SAMPLE_RULES[1]], 'claude', { home: tmpHome });
    const refDir = path.join(tmpHome, '.claude/skills/ownmind-iron-rules/references');
    const refFiles = fs.readdirSync(refDir);
    assert.equal(refFiles.length, 1, '舊 IR-002 應該被清掉');
    assert.ok(refFiles[0].startsWith('ir-003'));
  });
});

describe('v1.18.0 — syncToFilesystem (Cursor inline_md)', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('父目錄不存在 → skip', () => {
    const r = syncToFilesystem(SAMPLE_RULES, 'cursor', { home: tmpHome });
    assert.equal(r.written, false);
  });

  it('寫單檔含 big skill + 所有 reference', () => {
    fs.mkdirSync(path.join(tmpHome, '.cursor/rules'), { recursive: true });
    const r = syncToFilesystem(SAMPLE_RULES, 'cursor', { home: tmpHome });
    assert.equal(r.written, true);
    const filePath = path.join(tmpHome, '.cursor/rules/ownmind-iron-rules.md');
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf8');
    assert.match(content, /name: ownmind-iron-rules/, '含 big skill frontmatter');
    assert.match(content, /## IR-002:/, '含每條鐵律 H2 header');
    assert.match(content, /## IR-003:/);
  });
});

describe('v1.18.0 — syncToFilesystem (Codex AGENTS.md block)', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('父目錄不存在 → skip', () => {
    const r = syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    assert.equal(r.written, false);
  });

  it('AGENTS.md 不存在 → 建檔含 marker block', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const r = syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    assert.equal(r.written, true);
    const content = fs.readFileSync(path.join(tmpHome, '.codex/AGENTS.md'), 'utf8');
    assert.match(content, /<!-- ownmind-iron-rules:start -->/);
    assert.match(content, /<!-- ownmind-iron-rules:end -->/);
    assert.match(content, /name: ownmind-iron-rules/);
  });

  it('AGENTS.md 已有其他內容 → 保留、append marker block', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex/AGENTS.md'), '# My existing AGENTS\n\nMy custom rules here.\n');
    syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    const content = fs.readFileSync(path.join(tmpHome, '.codex/AGENTS.md'), 'utf8');
    assert.match(content, /My existing AGENTS/);
    assert.match(content, /My custom rules here/);
    assert.match(content, /<!-- ownmind-iron-rules:start -->/);
  });

  it('再次 sync → 舊 marker block 被替換、不重複 append', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    const content = fs.readFileSync(path.join(tmpHome, '.codex/AGENTS.md'), 'utf8');
    const startCount = (content.match(/<!-- ownmind-iron-rules:start -->/g) || []).length;
    assert.equal(startCount, 1, 'marker block 不該重複');
  });
});

describe('v1.18.0 — syncToAllTools', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('沒裝任何工具 → 全部 skip', () => {
    const results = syncToAllTools(SAMPLE_RULES, { home: tmpHome });
    assert.ok(results.length > 0);
    assert.ok(results.every(r => r.written === false));
  });

  it('只裝 Claude + Codex → 只寫這兩個、其他 skip', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude/skills'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const results = syncToAllTools(SAMPLE_RULES, { home: tmpHome });
    const written = results.filter(r => r.written);
    const skipped = results.filter(r => !r.written);
    assert.equal(written.length, 2);
    assert.equal(written.map(r => r.target).sort().join(','), 'claude,codex');
    assert.ok(skipped.length > 0);
  });

  it('TOOL_TARGETS 涵蓋 6+ 個工具', () => {
    const expected = ['claude', 'cursor', 'antigravity', 'windsurf', 'codex', 'opencode', 'gemini'];
    for (const k of expected) {
      assert.ok(TOOL_TARGETS[k], `應包含 target: ${k}`);
    }
  });
});
