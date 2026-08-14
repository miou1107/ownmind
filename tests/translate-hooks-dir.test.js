// Tests the --dir generalization of client/src/scripts/translate.mjs (Task 6 of
// gate-message-i18n): pure argv-parsing/path-resolution logic, override precedence, and one
// full-script integration run in manual mode (no TRANSLATE_API_KEY set, so no live LLM call)
// proving the whole pipeline — dictionaries, cache file, glossary, overrides — resolves under
// an arbitrary --dir instead of the hardcoded client/src/i18n default, and never touches
// client/src/i18n when --dir points elsewhere.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseDirArg,
  resolveI18nDir,
  applyOverride,
  DEFAULT_I18N_DIR,
} from '../client/src/scripts/translate.mjs';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'client', 'src', 'scripts', 'translate.mjs');

describe('parseDirArg', () => {
  it('returns null when --dir is absent', () => {
    assert.equal(parseDirArg([]), null);
    assert.equal(parseDirArg(['--other', 'x']), null);
  });

  it('returns the value following --dir', () => {
    assert.equal(parseDirArg(['--dir', 'hooks/locales']), 'hooks/locales');
  });

  it('returns null when --dir is the last argv token with no value after it', () => {
    assert.equal(parseDirArg(['--dir']), null);
  });
});

describe('resolveI18nDir', () => {
  it('defaults to client/src/i18n (byte-identical to pre-Task-6 behavior) when --dir is absent', () => {
    assert.equal(resolveI18nDir([]), DEFAULT_I18N_DIR);
    assert.ok(DEFAULT_I18N_DIR.endsWith(path.join('client', 'src', 'i18n')));
  });

  it('resolves a relative --dir against the given cwd', () => {
    assert.equal(
      resolveI18nDir(['--dir', 'hooks/locales'], { cwd: '/repo' }),
      path.resolve('/repo', 'hooks/locales')
    );
  });

  it('leaves an absolute --dir untouched regardless of cwd', () => {
    assert.equal(
      resolveI18nDir(['--dir', '/abs/path'], { cwd: '/repo' }),
      '/abs/path'
    );
  });

  it('ignores an unrelated cwd override when --dir is absent (default never depends on cwd)', () => {
    assert.equal(resolveI18nDir([], { cwd: '/somewhere/else' }), DEFAULT_I18N_DIR);
  });
});

describe('applyOverride', () => {
  it('overwrites a key the target already has', () => {
    const target = { greeting: 'llm output' };
    applyOverride(target, { greeting: 'pinned value' });
    assert.equal(target.greeting, 'pinned value');
  });

  it('adds a key the target does not have yet', () => {
    const target = {};
    applyOverride(target, { greeting: 'pinned value' });
    assert.equal(target.greeting, 'pinned value');
  });

  it('ignores underscore-prefixed keys like _comment', () => {
    const target = { greeting: 'kept' };
    applyOverride(target, { greeting: 'kept', _comment: 'explanatory text, not a dictionary entry' });
    assert.equal(target.greeting, 'kept');
    assert.equal('_comment' in target, false);
  });

  it('mutates the target in place and returns nothing', () => {
    const target = { a: '1' };
    const result = applyOverride(target, { a: '2' });
    assert.equal(result, undefined);
    assert.equal(target.a, '2');
  });
});

describe('translate.mjs --dir end-to-end (manual mode — TRANSLATE_API_KEY unset, no live LLM call)', () => {
  it('reads and writes every file under the given --dir, never under client/src/i18n', () => {
    const dir = tempDir('translate-dir-fixture-');
    fs.writeFileSync(path.join(dir, 'zh.json'), JSON.stringify({ hello: '哈囉' }));
    fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, 'ja.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, 'en.override.json'), JSON.stringify({ hello: 'Hello' }));
    fs.writeFileSync(path.join(dir, 'ja.override.json'), JSON.stringify({ hello: 'こんにちは' }));

    const env = { ...process.env };
    delete env.TRANSLATE_API_KEY; // force manual mode: no live LLM call
    const stdout = execFileSync(process.execPath, [scriptPath, '--dir', dir], {
      cwd: repoRoot, env, encoding: 'utf8',
    });

    assert.match(stdout, /manual mode/i);

    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
    const ja = JSON.parse(fs.readFileSync(path.join(dir, 'ja.json'), 'utf8'));
    assert.equal(en.hello, 'Hello', 'the override, not the (unrun) LLM, must decide the output');
    assert.equal(ja.hello, 'こんにちは');

    // A --dir run must never write into the default client dictionary.
    const clientEn = JSON.parse(fs.readFileSync(path.join(DEFAULT_I18N_DIR, 'en.json'), 'utf8'));
    assert.equal(clientEn.hello, undefined, 'a --dir run must never write into client/src/i18n');
  });

  it('bootstraps a brand-new directory: missing en.json/ja.json/glossary.json/overrides default to empty instead of crashing', () => {
    const dir = tempDir('translate-dir-bootstrap-');
    fs.writeFileSync(path.join(dir, 'zh.json'), JSON.stringify({ hello: '哈囉' }));
    // en.json, ja.json, glossary.json, en.override.json, ja.override.json intentionally absent.

    const env = { ...process.env };
    delete env.TRANSLATE_API_KEY;
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [scriptPath, '--dir', dir], { cwd: repoRoot, env, encoding: 'utf8' });
    });

    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
    const ja = JSON.parse(fs.readFileSync(path.join(dir, 'ja.json'), 'utf8'));
    assert.deepEqual(en, {});
    assert.deepEqual(ja, {});
  });

  it('throws a clear error when zh.json (the required source of truth) is missing', () => {
    const dir = tempDir('translate-dir-no-source-');
    // zh.json intentionally absent — every other file is optional, this one is not.
    assert.throws(() => {
      execFileSync(process.execPath, [scriptPath, '--dir', dir], {
        cwd: repoRoot, env: { ...process.env }, encoding: 'utf8', stdio: 'pipe',
      });
    });
  });
});
