import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { stripOwnMindEnv, HARNESS_PREFIXES } from './helpers/isolate-env.js';

/**
 * Issue #201 — a developer's own OwnMind key must not reach the hooks a test spawns.
 *
 * On 2026-10-24 `npm test` failed 30 tests on a Mac whose login shell exports
 * OWNMIND_API_KEY, OWNMIND_API_URL and OWNMIND_REPLY_LINT_MODE, and passed every test with
 * those three unset. The hooks under test found the real key in the inherited environment,
 * fetched the real account's rules from the production server, and printed them.
 *
 * The fix is `tests/helpers/isolate-env.js`, loaded by `npm test` through `--import`. These
 * tests hold the three things it depends on:
 *
 *   1. run the suite the way `npm test` runs it, with a key in the parent environment and a
 *      developer-style ~/.gitconfig that sets core.hooksPath, and a process a test file spawns
 *      must see neither (this is the one that went red first, once for each half);
 *   2. the harness-only prefixes it keeps are read by no product code, so keeping them cannot
 *      change what a hook does — the list of names is read from the source, not typed here;
 *   3. the strip itself removes OwnMind names in any case and leaves everything else alone.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

/**
 * The arguments `npm test` gives `node`, read from package.json so this test runs exactly
 * what developers and CI run. A copy typed here would keep passing after the script lost
 * its `--import`, which is the regression this file exists to catch.
 */
function npmTestNodeArgs() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const segment = pkg.scripts.test
    .split('&&')
    .map((s) => s.trim())
    .find((s) => s.startsWith('node --test'));
  assert.ok(segment, `package.json scripts.test has no "node --test" step: ${pkg.scripts.test}`);
  return segment.split(/\s+/).slice(1);
}

describe('issue #201: tests do not hand the developer’s OwnMind settings to what they spawn', () => {
  it('a process spawned from a test file run by `npm test` sees neither the shell’s OWNMIND_API_KEY nor the developer’s global git hooks', () => {
    const dir = tempDir('ownmind-env-isolation-');
    const report = path.join(dir, 'child-saw.json');
    const fixture = path.join(dir, 'spawns-a-child.test.mjs');
    // The fixture spawns its child the way about 80 real test files do: `{ ...process.env }`.
    fs.writeFileSync(fixture, [
      "import { it } from 'node:test';",
      "import fs from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "it('spawns a child with the inherited environment', () => {",
      "  const out = execFileSync(process.execPath, ['-e',",
      "    'process.stdout.write(JSON.stringify({ key: process.env.OWNMIND_API_KEY ?? null,'",
      "    + ' url: process.env.OWNMIND_API_URL ?? null, mode: process.env.ownmind_reply_lint_mode ?? null,'",
      "    + ' harness: process.env.OWNMIND_TEST_DB_READY_ATTEMPTS ?? null }))'],",
      "    { env: { ...process.env } });",
      // The developer's ~/.gitconfig carries core.hooksPath into every scratch repo a test makes.
      "  let hooksPath = null;",
      "  try {",
      "    hooksPath = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'],",
      "      { env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;",
      "  } catch { hooksPath = null; }",
      "  const saw = JSON.parse(out); saw.hooksPath = hooksPath;",
      `  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(saw));`,
      '});',
      '',
    ].join('\n'));

    // Stands in for the ~/.gitconfig OwnMind's installer leaves on a developer's machine.
    const developerGitconfig = path.join(dir, 'developer.gitconfig');
    fs.writeFileSync(developerGitconfig, '[core]\n\thooksPath = /home/dev/.ownmind/git-hooks\n');

    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: developerGitconfig,
      OWNMIND_API_KEY: 'fake-key-from-the-developer-shell',
      OWNMIND_API_URL: 'https://ownmind.invalid',
      // Lower case on purpose: on Windows this is the same variable as the upper-case one.
      ownmind_reply_lint_mode: 'off',
      OWNMIND_TEST_DB_READY_ATTEMPTS: '7',
    };
    // A nested runner that finds this refuses to run ("called recursively within a test file").
    delete env.NODE_TEST_CONTEXT;

    const run = spawnSync(process.execPath, [...npmTestNodeArgs(), fixture], {
      cwd: REPO, env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(run.status, 0, `nested test run failed:\n${run.stdout}\n${run.stderr}`);

    const saw = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(saw.key, null, 'the spawned child saw the developer’s OWNMIND_API_KEY');
    assert.equal(saw.url, null, 'the spawned child saw the developer’s OWNMIND_API_URL');
    assert.equal(saw.mode, null, 'the spawned child saw a lower-case OwnMind variable');
    assert.equal(saw.harness, '7', 'a harness switch (OWNMIND_TEST_*) was removed but must pass through');
    assert.equal(saw.hooksPath, null,
      'git in a spawned child still sees the developer’s global core.hooksPath, so a scratch-repo '
      + 'commit would run their real OwnMind pre-commit hook');
  });

  it('no product code reads a variable under a prefix the strip keeps', () => {
    const roots = ['hooks', 'shared', 'mcp', 'scripts', 'src', 'configs'];
    const topLevel = fs.readdirSync(REPO).filter((f) => /\.(sh|ps1|js|mjs|cjs)$/.test(f));
    const files = [...topLevel.map((f) => path.join(REPO, f))];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(sh|ps1|psm1|js|mjs|cjs|ts|json)$/.test(e.name)) files.push(p);
      }
    };
    for (const r of roots) if (fs.existsSync(path.join(REPO, r))) walk(path.join(REPO, r));
    assert.ok(files.length > 100, `scanned only ${files.length} files; the walk is broken`);

    const offenders = [];
    for (const f of files) {
      const names = fs.readFileSync(f, 'utf8').match(/OWNMIND_[A-Z0-9_]+/gi) || [];
      for (const n of names) {
        if (HARNESS_PREFIXES.some((p) => n.toUpperCase().startsWith(p))) {
          offenders.push(`${path.relative(REPO, f)}: ${n}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'product code reads a variable the test isolation lets through from the developer’s shell; '
      + 'rename it or drop its prefix from HARNESS_PREFIXES in tests/helpers/isolate-env.js');
  });

  it('strips OwnMind names in any case and keeps everything else', () => {
    const env = {
      OWNMIND_API_KEY: 'k', ownmind_api_url: 'u', OwnMind_Locale_Force: 'ja',
      OWNMIND_TEST_DB_READY_ATTEMPTS: '2', OWNMIND_ACCEPTANCE_KEEP: '1',
      PATH: '/bin', NOT_OWNMIND_API_KEY: 'x',
    };
    const removed = stripOwnMindEnv(env);
    assert.deepEqual(removed.sort(), ['OWNMIND_API_KEY', 'OwnMind_Locale_Force', 'ownmind_api_url']);
    assert.deepEqual(Object.keys(env).sort(),
      ['NOT_OWNMIND_API_KEY', 'OWNMIND_ACCEPTANCE_KEEP', 'OWNMIND_TEST_DB_READY_ATTEMPTS', 'PATH']);
  });
});
