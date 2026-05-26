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
 * v1.18.0 — iron-rule-sync.js tests
 *
 * Pure builders are verified directly against their string output;
 * syncToFilesystem runs real file IO under a tmp HOME (no fs mock — actually
 * mkdir/writeFile/readdir to ensure correct cross-platform behavior).
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
  it('returns a string starting with SKILL.md frontmatter (name + description)', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    assert.match(md, /^---\nname: ownmind-iron-rules\n/, 'must start with SKILL.md frontmatter');
    assert.match(md, /description: \|/);
    assert.match(md, /Use whenever you do ANY action covered by Vin's iron rules/);
    assert.match(md, /\n---\n/, 'must have a closing marker');
  });

  it('description references N total iron rules', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    // The description word-wraps; use [\s\S]*? to tolerate intervening newlines.
    assert.match(md, /OwnMind has 2 iron[\s\S]*?rules/);
  });

  it('trigger index is grouped by trigger', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    assert.match(md, /### trigger: commit/);
    assert.match(md, /### trigger: git/);
    assert.match(md, /### trigger: edit/);
    assert.match(md, /### trigger: debug/);
  });

  it('each rule lists code + title + reference path', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    assert.match(md, /\*\*IR-002\*\*: 不要 commit .env 或密碼/);
    assert.match(md, /references\/ir-002-/);
    assert.match(md, /\*\*IR-003\*\*: 修 bug 前先寫/);
    assert.match(md, /references\/ir-003-/);
  });

  it('trigger index output is deterministic (alphabetical)', () => {
    const md = buildBigSkillMd(SAMPLE_RULES);
    const triggerHeaders = (md.match(/### trigger: \w+/g) || []);
    const triggerNames = triggerHeaders.map(h => h.replace('### trigger: ', ''));
    assert.deepEqual(triggerNames, [...triggerNames].sort(), 'trigger sections must be alphabetically sorted');
  });

  it('rule without a trigger tag goes into the general bucket', () => {
    const md = buildBigSkillMd([{
      id: 99, code: 'IR-099', title: 'No trigger rule', content: '...', tags: [],
    }]);
    assert.match(md, /### trigger: general/);
  });

  it('empty rules → still emits frontmatter + 0-count message', () => {
    const md = buildBigSkillMd([]);
    assert.match(md, /name: ownmind-iron-rules/);
    assert.match(md, /OwnMind has 0 iron[\s\S]*?rules/);
  });
});

describe('v1.18.0 — buildReferenceFile', () => {
  it('already in SKILL.md format → returned as-is', () => {
    const r = SAMPLE_RULES[1];  // IR-003 is SKILL.md
    const out = buildReferenceFile(r);
    assert.equal(out, r.content, 'valid SKILL.md should be returned as-is');
  });

  it('legacy free-text → auto-prepends a minimal frontmatter', () => {
    const r = SAMPLE_RULES[0];  // IR-002 is legacy
    const out = buildReferenceFile(r);
    assert.match(out, /^---\nname: ir-002\n/);
    assert.match(out, /description: \|/);
    assert.match(out, /IR-002: 不要 commit \.env 或密碼/);
    assert.match(out, /Triggers on: commit, git/);
    assert.match(out, /auto-generated[\s\S]*?legacy/, 'description must mention auto-generated (across wrapped lines too)');
    // body contains the original content
    assert.ok(out.includes(r.content), 'body must contain the original content');
  });

  it('legacy without trigger tag → general bucket', () => {
    const out = buildReferenceFile({
      id: 99, code: 'IR-099', title: 'X', content: '內容', tags: [],
    });
    assert.match(out, /Triggers on: general/);
  });

  it('frontmatter parse failure → treated as legacy (auto-wrap)', () => {
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

  it('parent directory ~/.claude/skills missing → skip + reason', () => {
    const r = syncToFilesystem(SAMPLE_RULES, 'claude', { home: tmpHome });
    assert.equal(r.written, false);
    assert.match(r.reason, /tool not installed/);
  });

  it('parent directory exists → writes SKILL.md + references/', () => {
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

  it('re-sync → stale references are cleaned; disabled rules do not linger', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude/skills'), { recursive: true });
    syncToFilesystem(SAMPLE_RULES, 'claude', { home: tmpHome });
    // Simulate a second sync: only 1 rule left (IR-003 disabled).
    syncToFilesystem([SAMPLE_RULES[1]], 'claude', { home: tmpHome });
    const refDir = path.join(tmpHome, '.claude/skills/ownmind-iron-rules/references');
    const refFiles = fs.readdirSync(refDir);
    assert.equal(refFiles.length, 1, 'stale IR-002 should be removed');
    assert.ok(refFiles[0].startsWith('ir-003'));
  });
});

describe('v1.18.0 — syncToFilesystem (Cursor inline_md)', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('parent directory missing → skip', () => {
    const r = syncToFilesystem(SAMPLE_RULES, 'cursor', { home: tmpHome });
    assert.equal(r.written, false);
  });

  it('writes a single file containing big skill + every reference', () => {
    fs.mkdirSync(path.join(tmpHome, '.cursor/rules'), { recursive: true });
    const r = syncToFilesystem(SAMPLE_RULES, 'cursor', { home: tmpHome });
    assert.equal(r.written, true);
    const filePath = path.join(tmpHome, '.cursor/rules/ownmind-iron-rules.md');
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf8');
    assert.match(content, /name: ownmind-iron-rules/, 'contains the big-skill frontmatter');
    assert.match(content, /## IR-002:/, 'contains each rule as an H2 header');
    assert.match(content, /## IR-003:/);
  });
});

describe('v1.18.0 — syncToFilesystem (Codex AGENTS.md block)', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('parent directory missing → skip', () => {
    const r = syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    assert.equal(r.written, false);
  });

  it('AGENTS.md missing → create the file with the marker block', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const r = syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    assert.equal(r.written, true);
    const content = fs.readFileSync(path.join(tmpHome, '.codex/AGENTS.md'), 'utf8');
    assert.match(content, /<!-- ownmind-iron-rules:start -->/);
    assert.match(content, /<!-- ownmind-iron-rules:end -->/);
    assert.match(content, /name: ownmind-iron-rules/);
  });

  it('AGENTS.md already has content → preserve it; append the marker block', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex/AGENTS.md'), '# My existing AGENTS\n\nMy custom rules here.\n');
    syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    const content = fs.readFileSync(path.join(tmpHome, '.codex/AGENTS.md'), 'utf8');
    assert.match(content, /My existing AGENTS/);
    assert.match(content, /My custom rules here/);
    assert.match(content, /<!-- ownmind-iron-rules:start -->/);
  });

  it('re-sync → stale marker block is replaced; not appended again', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    syncToFilesystem(SAMPLE_RULES, 'codex', { home: tmpHome });
    const content = fs.readFileSync(path.join(tmpHome, '.codex/AGENTS.md'), 'utf8');
    const startCount = (content.match(/<!-- ownmind-iron-rules:start -->/g) || []).length;
    assert.equal(startCount, 1, 'marker block must not repeat');
  });
});

describe('v1.18.0 — syncToAllTools', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('no tools installed → all skipped', () => {
    const results = syncToAllTools(SAMPLE_RULES, { home: tmpHome });
    assert.ok(results.length > 0);
    assert.ok(results.every(r => r.written === false));
  });

  it('only Claude + Codex installed → writes only those two; others skipped', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude/skills'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const results = syncToAllTools(SAMPLE_RULES, { home: tmpHome });
    const written = results.filter(r => r.written);
    const skipped = results.filter(r => !r.written);
    assert.equal(written.length, 2);
    assert.equal(written.map(r => r.target).sort().join(','), 'claude,codex');
    assert.ok(skipped.length > 0);
  });

  it('TOOL_TARGETS covers 6+ tools', () => {
    const expected = ['claude', 'cursor', 'antigravity', 'windsurf', 'codex', 'opencode', 'gemini'];
    for (const k of expected) {
      assert.ok(TOOL_TARGETS[k], `should include target: ${k}`);
    }
  });
});
