import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectFrontmatter } from '../src/utils/iron-rule-frontmatter.js';

describe('v1.18.0 — iron-rule-frontmatter detectFrontmatter', () => {
  it('純文字（無 frontmatter）→ has: false', () => {
    const r = detectFrontmatter('IR-002: 不要 commit .env 或密碼\n\n內容...');
    assert.equal(r.has, false);
  });

  it('空 content → has: false', () => {
    assert.equal(detectFrontmatter('').has, false);
    assert.equal(detectFrontmatter(null).has, false);
    assert.equal(detectFrontmatter(undefined).has, false);
  });

  it('合法 SKILL.md → has: true + frontmatter + body', () => {
    const content = `---
name: ir-002-no-commit-secrets
description: |
  Use when about to git commit / push any change.
---

# IR-002: 不要 commit .env

body 內容...`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.equal(r.parseError, undefined);
    assert.equal(r.frontmatter.name, 'ir-002-no-commit-secrets');
    assert.match(r.frontmatter.description, /Use when about to git commit/);
    assert.match(r.body, /^# IR-002: 不要 commit \.env/);
    assert.match(r.body, /body 內容/);
  });

  it('開頭有 --- 但結尾沒 marker → has: false（不算合法）', () => {
    const content = `---
name: x
description: y

# 內容沒有結尾 marker`;
    assert.equal(detectFrontmatter(content).has, false);
  });

  it('結尾 marker 在檔尾無 newline → 不接受（保守）', () => {
    const content = `---
name: x
---`;
    assert.equal(detectFrontmatter(content).has, false);
  });

  it('YAML 非法語法 → has: true + parseError', () => {
    const content = `---
name: x
description: : invalid : yaml :
---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /YAML 解析失敗/);
    assert.equal(r.body, 'body');
  });

  it('frontmatter 是 null → parseError', () => {
    const content = `---

---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /frontmatter 不能為空/);
  });

  it('frontmatter 是 array（非 object）→ parseError', () => {
    const content = `---
- name: x
- description: y
---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /必須是 key-value object/);
  });

  it('frontmatter 是 scalar string → parseError', () => {
    const content = `---
just a string
---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /必須是 key-value object/);
  });

  it('開頭有空白行（前導 \\n）→ 不接受（嚴格 ---\\n 開頭）', () => {
    const content = `\n---\nname: x\ndescription: y\n---\n\nbody`;
    assert.equal(detectFrontmatter(content).has, false);
  });

  it('frontmatter 含巢狀 list / object', () => {
    const content = `---
name: complex
description: |
  multi line
  description here
nested:
  key1: value1
  key2:
    - a
    - b
---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.equal(r.frontmatter.name, 'complex');
    assert.deepEqual(r.frontmatter.nested.key2, ['a', 'b']);
  });

  it('YAML JSON_SCHEMA 不執行任意 JS（安全）', () => {
    // YAML !!js/function tag 在 JSON_SCHEMA 下會被拒、不會執行任意程式
    const content = `---
name: x
description: y
exploit: !!js/function "function() { return 'pwned'; }"
---

body`;
    const r = detectFrontmatter(content);
    // 安全模式應該拒絕 !!js/function
    assert.equal(r.has, true);
    assert.ok(r.parseError, 'JSON_SCHEMA 應拒絕 !!js/function tag');
  });

  it('frontmatter body 有多個 --- 但開頭那組才算', () => {
    const content = `---
name: x
description: y
---

body 含 --- 分隔線

---

body 還有更多`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.equal(r.frontmatter.name, 'x');
    // body 應該包含後面所有東西、含內部的 ---
    assert.match(r.body, /body 含 --- 分隔線/);
    assert.match(r.body, /body 還有更多/);
  });
});
