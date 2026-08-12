import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const updateSh = path.join(repoRoot, 'scripts/update.sh');

/**
 * v1.26.140 — the same "printed OK whatever happened" defect that was reported on Windows,
 * on the side every macOS, Linux and Git-Bash machine runs.
 *
 * `update.sh` never crashed the way `update.ps1` did — Node's readFileSync returns '' for an
 * empty file — but it ended the step with a fixed `[ OK ] Upgrade rules synced to detected
 * AI tools` that did not depend on anything that happened, and the strip step ended in
 * `|| true`, so a node that could not run left the old block in place while the append added
 * a second one.
 *
 * The block is lifted out of the real script rather than restated here: a copy would drift,
 * and then this file would be testing a version of the code nobody runs.
 */

/** The 1b block from the real script, with its two external dependencies stubbed. */
function extractBlock() {
  const src = fs.readFileSync(updateSh, 'utf8').split('\n');
  const start = src.findIndex((l) => l.includes('--- 1b.'));
  assert.ok(start > 0, 'the 1b block should still be findable in scripts/update.sh');
  // Up to the next section header. Stopping at the first `fi` would cut the block in half —
  // the summary is an if/else — and the truncation shows up as a bash syntax error rather
  // than as anything about this file.
  let end = start + 1;
  while (end < src.length && !src[end].startsWith('# --- ')) end += 1;
  assert.ok(end < src.length, 'the 1b block should be followed by another section');
  return src.slice(start, end).join('\n');
}

function runBlock({ tools = [], snippet = 'RULE BODY', breakNode = false } = {}) {
  const home = tempDir('ownmind-sh-');
  const ownmind = path.join(home, '.ownmind');
  fs.mkdirSync(path.join(ownmind, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(ownmind, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ownmind, 'skills/ownmind-upgrade-agents-snippet.md'), snippet);

  for (const [rel, content] of tools) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content !== null) fs.writeFileSync(full, content);
  }

  // `breakNode` puts a `node` on PATH that always fails, which is what an interrupted or
  // broken runtime looks like to this block.
  const binDir = path.join(home, 'fakebin');
  if (breakNode) {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }

  const script = path.join(home, 'block.sh');
  fs.writeFileSync(script, [
    '#!/bin/bash',
    `OWNMIND_DIR="${ownmind}"`,
    'to_win_path() { echo "$1"; }',
    extractBlock(),
  ].join('\n'));

  const out = execFileSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: breakNode ? `${binDir}:${process.env.PATH}` : process.env.PATH,
    },
  });
  return { home, out };
}

const read = (home, rel) => fs.readFileSync(path.join(home, rel), 'utf8');

describe('update.sh — the upgrade-rule sync reports what happened', () => {
  it('counts the tools it wrote instead of printing a fixed line', () => {
    const { out } = runBlock({ tools: [['.codex/AGENTS.md', 'my notes\n'], ['.gemini/GEMINI.md', null]] });
    assert.match(out, /\[ OK \] Upgrade rules synced to 2 detected AI tool\(s\)/);
  });

  it('reports zero when no AI tool is installed, rather than "synced"', () => {
    const { out } = runBlock({ tools: [] });
    assert.match(out, /synced to 0 detected AI tool\(s\)/);
  });

  it('an empty target file gets the rule — the case that broke the Windows updater', () => {
    const { home, out } = runBlock({ tools: [['.codex/AGENTS.md', '']] });
    assert.match(out, /\[ OK \]/);
    assert.match(read(home, '.codex/AGENTS.md'), /RULE BODY/);
  });

  it('running twice leaves one rule block and keeps the user\'s content', () => {
    const { home } = runBlock({ tools: [['.codex/AGENTS.md', 'keep me\n']] });
    // Second pass over the same HOME, through the same extracted block.
    const script = path.join(home, 'block.sh');
    execFileSync('bash', [script], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    const body = read(home, '.codex/AGENTS.md');
    assert.equal(body.match(/<!-- ownmind-upgrade-rule -->/g).length, 1);
    assert.match(body, /keep me/);
  });

  it('a strip that could not run is reported as a failure, not counted as written', () => {
    const { out } = runBlock({ tools: [['.codex/AGENTS.md', 'keep me\n']], breakNode: true });
    assert.match(out, /\[WARN\]/);
    assert.match(out, /failed:.*\.codex\/AGENTS\.md/);
    assert.doesNotMatch(out, /\[ OK \]/);
  });

  /**
   * Skipped where the setup cannot be made true rather than asserted anyway. `chmod 000` has
   * no effect on Windows, and root reads through it on POSIX — in both cases the file stays
   * readable, and a test whose premise did not hold would be reporting on nothing. Windows CI
   * is what caught this: the test failed there because the file was never unreadable.
   */
  it('a snippet that cannot be read is a failure, not an empty rule block', (t) => {
    const { home, out } = runBlock({ tools: [['.codex/AGENTS.md', null]] });
    assert.match(out, /\[ OK \]/, 'the control: readable snippet, reported as written');

    const snippet = path.join(home, '.ownmind/skills/ownmind-upgrade-agents-snippet.md');
    fs.chmodSync(snippet, 0o000);
    try {
      fs.readFileSync(snippet);
      t.skip('this platform/user reads through chmod 000, so the snippet is not unreadable');
      return;
    } catch {
      // Unreadable for real — the premise holds.
    }

    try {
      const second = execFileSync('bash', [path.join(home, 'block.sh')], {
        encoding: 'utf8', env: { ...process.env, HOME: home },
      });
      assert.match(second, /\[WARN\]/);
      assert.doesNotMatch(second, /\[ OK \]/);
    } finally {
      fs.chmodSync(snippet, 0o644);
    }
  });

  it('a failure in one tool does not stop the others', () => {
    const { home, out } = runBlock({
      tools: [['.codex/AGENTS.md', 'existing\n'], ['.gemini/GEMINI.md', null]],
      breakNode: true,
    });
    // .codex has a file so it goes through the strip and fails; .gemini has none, so it is
    // written without ever calling node.
    assert.match(out, /synced to 1 AI tool\(s\)/);
    assert.match(read(home, '.gemini/GEMINI.md'), /RULE BODY/);
  });
});

describe('update.sh — the silencer must not come back', () => {
  const block = extractBlock();

  it('the strip does not end in `|| true`', () => {
    assert.doesNotMatch(
      block,
      /update-err\.log"\s*\|\|\s*true/,
      'a node that cannot run would leave the old block in place while the append adds a second'
    );
  });

  it('the summary line interpolates a count', () => {
    const okLine = block.match(/echo "\[ OK \][^\n]*Upgrade rules[^\n]*/);
    assert.ok(okLine, 'the success line should still exist');
    assert.match(okLine[0], /\$RULE_WRITTEN/);
  });
});
