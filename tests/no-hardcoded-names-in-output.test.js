import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBigSkillMd, buildReferenceFile } from '../src/utils/iron-rule-sync.js';
import { suggestSkillMdFormat } from '../src/utils/iron-rule-suggest.js';
import { buildMessages } from '../src/lib/llm-narrative.js';

/**
 * v1.26.35 — no hardcoded personal names in user-facing generated output.
 *
 * The SKILL.md generators, the rule-suggestion text, and the narrative LLM
 * prompt hardcoded the owner's name ("Vin"), so every OTHER OwnMind user saw
 * someone else's name in their own generated skill files / reports. These
 * builders receive no user identity, so the correct de-identified form is a
 * generic second-person phrasing ("your iron rules"), and prompt few-shot
 * examples use a placeholder example name, not a real person.
 *
 * (Dev comments that reference "Vin" as project history are accurate and
 * developer-facing, not a multi-user leak, and are out of scope here.)
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const NAME = /\bVin\b/;

describe('v1.26.35 — no hardcoded personal name in generated output', () => {
  it('buildBigSkillMd output has no hardcoded personal name', () => {
    const out = buildBigSkillMd([
      { id: 1, code: 'R1', title: 'do not commit secrets', content: 'body', tags: ['trigger:commit'], status: 'active' },
    ]);
    assert.doesNotMatch(out, NAME, 'the big SKILL.md must not embed a personal name');
  });

  it('buildReferenceFile (legacy auto-frontmatter) output has no hardcoded personal name', () => {
    const out = buildReferenceFile(
      { id: 2, code: 'R2', title: 'a legacy rule', content: 'plain legacy text, no frontmatter', tags: ['trigger:commit'] }
    );
    assert.doesNotMatch(out, NAME, 'the auto-frontmatter reference file must not embed a personal name');
  });

  it('suggestSkillMdFormat description has no hardcoded personal name', () => {
    const res = suggestSkillMdFormat(
      { code: 'R3', title: 'a rule', content: 'plain text, no frontmatter', tags: ['trigger:commit'] }
    );
    assert.doesNotMatch(JSON.stringify(res), NAME, 'the suggested description must not embed a personal name');
  });

  it('narrative LLM prompt has no real personal name in its examples', () => {
    const msgs = buildMessages({ ranking: [] });
    assert.doesNotMatch(JSON.stringify(msgs), NAME, 'the narrative prompt must use placeholder example names');
  });

  it('client default layout profile has no hardcoded personal name', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'client/src/App.jsx'), 'utf8');
    assert.doesNotMatch(src, /name:\s*'Vin'/, 'the default layout profile must not hardcode a personal name');
  });
});

/**
 * Source-scan guard: no owner personal name in product CODE files (comments
 * included). The `author` field in package.json (legitimate authorship) is not
 * a code file and is intentionally not scanned. Test fixtures are excluded.
 */
describe('v1.26.36 — no hardcoded owner name in product code files', () => {
  const SCAN_DIRS = ['src', 'mcp', 'hooks', 'shared', 'client/src'];
  const NAME_RE = /\b(Vin|Vincent)\b/;
  const SKIP_PATH = /node_modules|\.min\.|\/dist\/|\/assets\/|\/bundle/;
  const SCAN_EXT = /\.(js|jsx|ts|tsx|cjs|mjs|cmd|sh|html)$/;

  function walk(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (SKIP_PATH.test(full)) continue;
      if (entry.isDirectory()) walk(full, acc);
      else if (SCAN_EXT.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  it('no product code file embeds the owner name (use generic phrasing / example names)', () => {
    const files = SCAN_DIRS
      .map((d) => path.join(repoRoot, d))
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => walk(d, []));

    const violations = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (NAME_RE.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
    }
    assert.equal(violations.length, 0,
      `Found the owner name in product code (use generic "your"/second-person, ` +
      `or a placeholder example name):\n${violations.join('\n')}`);
  });
});
