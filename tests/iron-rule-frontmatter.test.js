import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectFrontmatter } from '../src/utils/iron-rule-frontmatter.js';

describe('v1.18.0 — iron-rule-frontmatter detectFrontmatter', () => {
  it('plain text (no frontmatter) → has: false', () => {
    const r = detectFrontmatter('IR-002: 不要 commit .env 或密碼\n\n內容...');
    assert.equal(r.has, false);
  });

  it('empty content → has: false', () => {
    assert.equal(detectFrontmatter('').has, false);
    assert.equal(detectFrontmatter(null).has, false);
    assert.equal(detectFrontmatter(undefined).has, false);
  });

  it('valid SKILL.md → has: true + frontmatter + body', () => {
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

  it('opening --- without closing marker → has: false (not valid)', () => {
    const content = `---
name: x
description: y

# 內容沒有結尾 marker`;
    assert.equal(detectFrontmatter(content).has, false);
  });

  it('closing marker at EOF without newline → rejected (conservative)', () => {
    const content = `---
name: x
---`;
    assert.equal(detectFrontmatter(content).has, false);
  });

  it('invalid YAML syntax → has: true + parseError', () => {
    const content = `---
name: x
description: : invalid : yaml :
---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /YAML parse failed/);
    assert.equal(r.body, 'body');
  });

  it('frontmatter is null → parseError', () => {
    const content = `---

---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /frontmatter cannot be empty/);
  });

  it('frontmatter is an array (not object) → parseError', () => {
    const content = `---
- name: x
- description: y
---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /must be a key-value object/);
  });

  it('frontmatter is a scalar string → parseError', () => {
    const content = `---
just a string
---

body`;
    const r = detectFrontmatter(content);
    assert.equal(r.has, true);
    assert.match(r.parseError, /must be a key-value object/);
  });

  it('leading blank line (leading \\n) → rejected (strict ---\\n start)', () => {
    const content = `\n---\nname: x\ndescription: y\n---\n\nbody`;
    assert.equal(detectFrontmatter(content).has, false);
  });

  it('frontmatter contains nested list / object', () => {
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

  it('YAML JSON_SCHEMA does not execute arbitrary JS (safe)', () => {
    // The YAML !!js/function tag is rejected under JSON_SCHEMA, so no arbitrary code runs.
    const content = `---
name: x
description: y
exploit: !!js/function "function() { return 'pwned'; }"
---

body`;
    const r = detectFrontmatter(content);
    // Safe mode should reject !!js/function.
    assert.equal(r.has, true);
    assert.ok(r.parseError, 'JSON_SCHEMA should reject the !!js/function tag');
  });

  it('multiple --- in body, but only the leading pair counts', () => {
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
    // The body should include everything after the leading pair, even other --- markers.
    assert.match(r.body, /body 含 --- 分隔線/);
    assert.match(r.body, /body 還有更多/);
  });
});
