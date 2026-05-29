import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { readCredentials, readJsonSafe } = await import('../shared/helpers.js');

/**
 * v1.17.12 — readCredentials must tolerate a UTF-8 BOM (reported by Adam/Eric, root cause)
 *
 * On PS 5.1, install.ps1 wrote settings.json with `Set-Content -Encoding UTF8`,
 * which adds a UTF-8 BOM (EF BB BF). Node.js JSON.parse does not accept a BOM and
 * throws a SyntaxError → readCredentials() catches it and returns an empty string →
 * the scanner exits early with no heartbeat / event. 4 Windows users were all stuck on this.
 *
 * install.ps1 was changed to WriteAllText in v1.17.12 to avoid the BOM, but existing
 * victims' settings.json already has a BOM → the Node read side must defensively strip it.
 * Defense in depth.
 */

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-creds-bom-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('readCredentials — BOM tolerance', () => {
  it('settings.json without a BOM parses normally', () => {
    const p = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k1', OWNMIND_API_URL: 'u1' } } }
    }));
    const r = readCredentials(p);
    assert.equal(r.apiKey, 'k1');
    assert.equal(r.apiUrl, 'u1');
  });

  it('settings.json with a UTF-8 BOM still parses (Adam/Eric victims)', () => {
    const p = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(p, '\uFEFF' + JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k2', OWNMIND_API_URL: 'u2' } } }
    }));
    const r = readCredentials(p);
    assert.equal(r.apiKey, 'k2', 'BOM 導致 JSON.parse fail → creds 空 → scanner 提早退');
    assert.equal(r.apiUrl, 'u2');
  });

  it('broken JSON still returns empty creds (no crash)', () => {
    const p = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(p, 'not json');
    const r = readCredentials(p);
    assert.equal(r.apiKey, '');
    assert.equal(r.apiUrl, '');
  });

  it('a non-existent file returns empty creds', () => {
    const r = readCredentials(path.join(tmpDir, 'nope.json'));
    assert.equal(r.apiKey, '');
  });
});

describe('readJsonSafe — BOM tolerance', () => {
  it('parses normally without a BOM', () => {
    const p = path.join(tmpDir, 'a.json');
    fs.writeFileSync(p, '{"foo":"bar"}');
    assert.deepEqual(readJsonSafe(p), { foo: 'bar' });
  });

  it('still parses with a BOM', () => {
    const p = path.join(tmpDir, 'a.json');
    fs.writeFileSync(p, '\uFEFF{"foo":"baz"}');
    assert.deepEqual(readJsonSafe(p), { foo: 'baz' });
  });
});
