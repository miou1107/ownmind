import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * The last line of a successful install tells the AI what to do next (zero-touch-install, Task 12).
 *
 *   Claude desktop app  -> NEXT:verify:new-session          (the AI opens a verification conversation)
 *   Claude Code in a terminal, or an unknown tool with a terminal -> NEXT:verify:manual:<terminal sentence>
 *   anything else       -> NEXT:verify:manual:<generic sentence>
 *
 * Both installers decide once, after the self-check, from two environment variables the Claude
 * desktop app and Claude Code set: CLAUDE_CODE_ENTRYPOINT and CLAUDE_CODE_DESKTOP_APP_VERSION.
 * Static checks keep the three branches, the variable names and the "last line" position; a run
 * of the shell block shows what each environment prints.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks', 'locales', 'en.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

const START = '# What the AI does next';

/** The NEXT decision block through the end of the script. */
export function nextBlock(text) {
  const at = text.indexOf(START);
  return at === -1 ? '' : text.slice(at);
}

/** Lines in the block that print something, comments and blank lines left out. */
export function printLines(block) {
  return block.split('\n').filter((l) => /\becho\b|Write-Host/.test(l) && !/^\s*#/.test(l));
}

const SCRIPTS = ['install.sh', 'install.ps1'];

describe('the NEXT line at the end of a successful install', () => {
  for (const rel of SCRIPTS) {
    const text = read(rel);
    const block = nextBlock(text);

    it(`${rel}: has the desktop, terminal and generic branches`, () => {
      assert.ok(block, `${rel} has no "${START}" block`);
      assert.match(block, /NEXT:verify:new-session/);
      assert.equal(printLines(block).filter((l) => l.includes('NEXT:verify:manual:')).length, 2, 'one terminal and one generic manual line');
      assert.match(block, /install\.next\.verify_manual_terminal/);
      assert.match(block, /install\.next\.verify_manual_generic/);
      assert.ok(block.includes(en['install.next.verify_manual_terminal']), 'the English terminal sentence fallback');
      assert.ok(block.includes(en['install.next.verify_manual_generic']), 'the English generic sentence fallback');
      assert.match(block, /claude-desktop/);
      assert.match(block, /['"=]cli['"]|-eq 'cli'/);
    });

    it(`${rel}: the decision reads exactly CLAUDE_CODE_ENTRYPOINT and CLAUDE_CODE_DESKTOP_APP_VERSION`, () => {
      const names = new Set(block.match(/CLAUDE_CODE_[A-Z_]+/g) || []);
      assert.deepEqual([...names].sort(), ['CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_CODE_ENTRYPOINT']);
    });

    it(`${rel}: the NEXT line is the last thing printed on success`, () => {
      const prints = printLines(block);
      assert.equal(prints.length, 3, `the block prints ${prints.length} lines, expected only the three NEXT lines:\n${prints.join('\n')}`);
      for (const line of prints) assert.match(line, /NEXT:verify:/);
      const tail = text.trimEnd().split('\n').pop().trim();
      assert.match(tail, /^(fi|\})$/, `the file must end with the closing of the NEXT block, not "${tail}"`);
    });

    it(`${rel}: the old closing sentence is gone`, () => {
      assert.doesNotMatch(text, /Open a new (AI|Claude Code) session/);
    });
  }

  it('the checker would catch a banner printed after the NEXT block', () => {
    const bad = `${START}\nif x; then\n  echo "NEXT:verify:new-session"\nfi\necho "Open a new AI session"\n`;
    assert.equal(printLines(nextBlock(bad)).length, 2);
  });
});

describe('install.sh: what each environment prints', () => {
  const block = nextBlock(read('install.sh'));
  const dir = tempDir('install-next-');
  const script = path.join(dir, 'next.sh');
  // ownmind_say is install.sh's own helper: the English literal when no checkout answers.
  fs.writeFileSync(script, `ownmind_say() { printf '%s\\n' "$2"; }\n${block}\n`);

  const run = (env) => spawnSync('bash', [script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, ...env },
  });

  it('the desktop app (ENTRYPOINT=claude-desktop) gets NEXT:verify:new-session', () => {
    assert.equal(run({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }).stdout, 'NEXT:verify:new-session\n');
  });

  it('the desktop app version variable alone is enough', () => {
    assert.equal(run({ CLAUDE_CODE_DESKTOP_APP_VERSION: '1.2.3' }).stdout, 'NEXT:verify:new-session\n');
  });

  it('Claude Code in a terminal (ENTRYPOINT=cli) gets the /exit and claude sentence', () => {
    assert.equal(run({ CLAUDE_CODE_ENTRYPOINT: 'cli' }).stdout, `NEXT:verify:manual:${en['install.next.verify_manual_terminal']}\n`);
  });

  it('no variable and no terminal on stdin gets the generic sentence', () => {
    assert.equal(run({}).stdout, `NEXT:verify:manual:${en['install.next.verify_manual_generic']}\n`);
  });

  it('another entry point (an editor extension) gets the generic sentence', () => {
    assert.equal(run({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }).stdout, `NEXT:verify:manual:${en['install.next.verify_manual_generic']}\n`);
  });
});
