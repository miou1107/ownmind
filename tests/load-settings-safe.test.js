import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, '..', 'scripts', 'install-helpers', 'load-settings-safe.cjs');

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-load-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Inline node script that exercises the helper. Prints stdout JSON if loaded,
// otherwise the helper itself prints a stderr warning and process.exit(0).
function runHelper(filePath, fallback = '{}') {
  const code = `
    const { loadOrSkip } = require('${HELPER}');
    const result = loadOrSkip('${filePath.replace(/\\/g, '\\\\')}', ${fallback});
    process.stdout.write(JSON.stringify(result));
  `;
  return spawnSync('node', ['-e', code], { encoding: 'utf8' });
}

describe('loadOrSkip — settings.json safe loader', () => {
  it('returns fallback when file does not exist', () => {
    withTmp((dir) => {
      const r = runHelper(path.join(dir, 'missing.json'), '{ "default": true }');
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '{"default":true}');
    });
  });

  it('returns parsed JSON when file is valid', () => {
    withTmp((dir) => {
      const p = path.join(dir, 'valid.json');
      fs.writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [] } }));
      const r = runHelper(p);
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(r.stdout), { hooks: { SessionStart: [] } });
    });
  });

  it('exits 0 with stderr warning when file is corrupted (does NOT throw)', () => {
    withTmp((dir) => {
      const p = path.join(dir, 'broken.json');
      const original = '{not valid json{{{';
      fs.writeFileSync(p, original);
      const r = runHelper(p);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}, stderr: ${r.stderr}`);
      assert.match(r.stderr, /JSON|parse|invalid|skip/i);
      // Critical: caller never gets to the writeFile path → file content unchanged
      assert.equal(fs.readFileSync(p, 'utf8'), original);
    });
  });

  it('does NOT overwrite a corrupted file even if caller would write the fallback', () => {
    // This is the regression case: prior to v1.17.60, update.sh would
    // catch JSON.parse and proceed with empty {}, then write {} to disk,
    // erasing the user's recoverable settings.
    withTmp((dir) => {
      const p = path.join(dir, 'broken.json');
      const original = 'corrupted but has user data: { "secret": "value"';
      fs.writeFileSync(p, original);
      // Run a "naive" update flow: load → would write back if we got past load
      const code = `
        const fs = require('fs');
        const { loadOrSkip } = require('${HELPER}');
        const s = loadOrSkip('${p}', {});
        // If loadOrSkip didn't exit, this code runs and would clobber the file
        s.injected = true;
        fs.writeFileSync('${p}', JSON.stringify(s));
      `;
      const r = spawnSync('node', ['-e', code], { encoding: 'utf8' });
      assert.equal(r.status, 0);
      // File content must still be original (loadOrSkip exited before writeFile)
      assert.equal(fs.readFileSync(p, 'utf8'), original);
    });
  });

  it('exits 0 when file contains valid JSON but not an object (null / array / primitive)', () => {
    for (const bad of ['null', '42', '"string"', '[1,2,3]']) {
      withTmp((dir) => {
        const p = path.join(dir, 'badshape.json');
        fs.writeFileSync(p, bad);
        const r = runHelper(p);
        assert.equal(r.status, 0, `expected exit 0 for ${bad}, got ${r.status}`);
        assert.match(r.stderr, /不是 JSON object|skip/i);
        assert.equal(fs.readFileSync(p, 'utf8'), bad, `original content of ${bad} preserved`);
      });
    }
  });

  it('exits 0 when file is empty (zero bytes)', () => {
    withTmp((dir) => {
      const p = path.join(dir, 'empty.json');
      fs.writeFileSync(p, '');
      const r = runHelper(p);
      assert.equal(r.status, 0);
      assert.match(r.stderr, /JSON|parse|invalid/i);
    });
  });

  it('exits 0 with warning when file is unreadable (permission denied)', () => {
    if (process.platform === 'win32') return; // chmod semantics differ on Windows
    withTmp((dir) => {
      const p = path.join(dir, 'noperm.json');
      fs.writeFileSync(p, '{}');
      fs.chmodSync(p, 0o000);
      try {
        const r = runHelper(p);
        // On macOS/Linux as non-root, this triggers EACCES; the helper warns + exits 0
        // (Some CI environments run as root and would still read; assert non-throw either way)
        assert.equal(r.status, 0);
      } finally {
        fs.chmodSync(p, 0o644); // restore so cleanup can rmSync
      }
    });
  });
});
