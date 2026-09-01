import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const installSh = path.join(repoRoot, 'install.sh');
const updateSh = path.join(repoRoot, 'scripts/update.sh');

/**
 * gate-message-i18n task 7 — `hooks/locales/*.json` (the gate/lint/compliance message
 * dictionaries `hooks/lib/i18n.js` reads at runtime) is a directory of extension-filtered
 * files exactly like `hooks/lib/*.js`, but it did not exist when install.sh and
 * scripts/update.sh's copy-to-`~/.claude/hooks` fallback globs were last written, so neither
 * one shipped it there. A machine relying on the `~/.claude/hooks` fallback location (rather
 * than running hooks straight out of the `~/.ownmind` checkout) would have every dictionary
 * key resolve through `t()`'s per-key fallback to the raw key string, silently, since
 * `hooks/lib/i18n.js`'s `resetI18nCacheForTests`/`t()` never throws on a missing file — see
 * `tests/hook-i18n.test.js`'s "total function" cases for that contract.
 *
 * Both blocks are lifted out of the real scripts rather than restated here — the same
 * reasoning `tests/update-sh-upgrade-rule.test.js` documents: a copy drifts, and then this
 * file tests a version of the code nobody runs.
 */

/** Extract a `# --- N. …` section from `src` up to (not including) the next such header. */
function extractSection(filePath, markerSubstring) {
  const src = fs.readFileSync(filePath, 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith('# --- ') && l.includes(markerSubstring));
  assert.ok(start > 0, `section containing "${markerSubstring}" should still be findable in ${filePath}`);
  let end = start + 1;
  while (end < src.length && !src[end].startsWith('# --- ')) end += 1;
  assert.ok(end < src.length, 'the extracted section should be followed by another section header');
  return src.slice(start, end).join('\n');
}

/** A minimal but realistic `$OWNMIND_DIR/hooks` tree: the shell hooks, hooks/lib, hooks/locales. */
function stageOwnmindHooks(ownmindDir, { withLocales = true } = {}) {
  const hooksDir = path.join(ownmindDir, 'hooks');
  fs.mkdirSync(path.join(hooksDir, 'lib'), { recursive: true });
  for (const name of ['ownmind-iron-rule-check.sh', 'ownmind-session-start.sh']) {
    fs.writeFileSync(path.join(hooksDir, name), '#!/bin/bash\necho stub\n');
  }
  fs.writeFileSync(path.join(hooksDir, 'lib', 'i18n.js'), '// stub\n');
  if (withLocales) {
    fs.mkdirSync(path.join(hooksDir, 'locales'), { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'locales', 'en.json'), JSON.stringify({ 'gate.ask.verbal': 'stub-en' }));
    fs.writeFileSync(path.join(hooksDir, 'locales', 'zh.json'), JSON.stringify({ 'gate.ask.verbal': 'stub-zh' }));
    fs.writeFileSync(path.join(hooksDir, 'locales', 'ja.json'), JSON.stringify({ 'gate.ask.verbal': 'stub-ja' }));
  }
  return hooksDir;
}

function runShellBlock(script, home) {
  const scriptPath = path.join(home, 'block.sh');
  fs.writeFileSync(scriptPath, script);
  return execFileSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

describe('install.sh section 4b ships hooks/locales/*.json to the ~/.claude/hooks fallback', () => {
  it('copies every locale dictionary into ~/.claude/hooks/locales', () => {
    const home = tempDir('ownmind-install4b-');
    const ownmindDir = path.join(home, '.ownmind');
    stageOwnmindHooks(ownmindDir);

    const block = extractSection(installSh, '4b.');
    runShellBlock([
      '#!/bin/bash',
      'set -e',
      `OWNMIND_DIR="${ownmindDir}"`,
      block,
    ].join('\n'), home);

    const destDir = path.join(home, '.claude', 'hooks', 'locales');
    const shipped = fs.readdirSync(destDir).sort();
    assert.deepEqual(shipped, ['en.json', 'ja.json', 'zh.json']);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(destDir, 'ja.json'), 'utf8')),
      { 'gate.ask.verbal': 'stub-ja' },
    );
  });

  it('does not fail when hooks/locales does not exist (older checkout)', () => {
    const home = tempDir('ownmind-install4b-nolocale-');
    const ownmindDir = path.join(home, '.ownmind');
    stageOwnmindHooks(ownmindDir, { withLocales: false });

    const block = extractSection(installSh, '4b.');
    const out = runShellBlock([
      '#!/bin/bash',
      'set -e',
      `OWNMIND_DIR="${ownmindDir}"`,
      block,
    ].join('\n'), home);

    assert.match(out, /Installed hook scripts/);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'hooks', 'locales', 'en.json')), false);
  });
});

describe('scripts/update.sh section 2 ships hooks/locales/*.json to the ~/.claude/hooks fallback', () => {
  it('copies every locale dictionary into ~/.claude/hooks/locales', () => {
    const home = tempDir('ownmind-update2-');
    const ownmindDir = path.join(home, '.ownmind');
    stageOwnmindHooks(ownmindDir);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // section 2 guards on this existing

    const block = extractSection(updateSh, '2. Sync hook scripts');
    runShellBlock([
      '#!/bin/bash',
      `OWNMIND_DIR="${ownmindDir}"`,
      block,
    ].join('\n'), home);

    const destDir = path.join(home, '.claude', 'hooks', 'locales');
    const shipped = fs.readdirSync(destDir).sort();
    assert.deepEqual(shipped, ['en.json', 'ja.json', 'zh.json']);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(destDir, 'zh.json'), 'utf8')),
      { 'gate.ask.verbal': 'stub-zh' },
    );
  });

  it('a stale fallback dictionary is overwritten on re-sync rather than left behind', () => {
    const home = tempDir('ownmind-update2-restale-');
    const ownmindDir = path.join(home, '.ownmind');
    stageOwnmindHooks(ownmindDir);
    const destDir = path.join(home, '.claude', 'hooks', 'locales');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'en.json'), JSON.stringify({ 'gate.ask.verbal': 'THREE VERSIONS OLD' }));

    const block = extractSection(updateSh, '2. Sync hook scripts');
    runShellBlock([
      '#!/bin/bash',
      `OWNMIND_DIR="${ownmindDir}"`,
      block,
    ].join('\n'), home);

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(destDir, 'en.json'), 'utf8')),
      { 'gate.ask.verbal': 'stub-en' },
    );
  });

  it('does not fail when hooks/locales does not exist (older checkout)', () => {
    const home = tempDir('ownmind-update2-nolocale-');
    const ownmindDir = path.join(home, '.ownmind');
    stageOwnmindHooks(ownmindDir, { withLocales: false });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    const block = extractSection(updateSh, '2. Sync hook scripts');
    const out = runShellBlock([
      '#!/bin/bash',
      `OWNMIND_DIR="${ownmindDir}"`,
      block,
    ].join('\n'), home);

    assert.match(out, /Hook scripts synced/);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'hooks', 'locales', 'en.json')), false);
  });
});
