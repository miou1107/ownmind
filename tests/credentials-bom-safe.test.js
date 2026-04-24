import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { readCredentials, readJsonSafe } = await import('../shared/helpers.js');

/**
 * v1.17.12 — readCredentials 必須容忍 UTF-8 BOM（回報者 Adam/Eric root cause）
 *
 * install.ps1 在 PS 5.1 用 `Set-Content -Encoding UTF8` 寫 settings.json，會
 * 加 UTF-8 BOM (EF BB BF)。Node.js 的 JSON.parse 不吃 BOM，直接 throw
 * SyntaxError → readCredentials() catch 後回空字串 → scanner 提早 exit 無任
 * 何 heartbeat / event。Windows × 4 使用者全部卡這個。
 *
 * install.ps1 已在 v1.17.12 改 WriteAllText 避免 BOM，但現有受害者的
 * settings.json 已有 BOM → Node 讀取端必須防禦性 strip。Defense in depth。
 */

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-creds-bom-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('readCredentials — BOM tolerance', () => {
  it('無 BOM settings.json 正常 parse', () => {
    const p = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k1', OWNMIND_API_URL: 'u1' } } }
    }));
    const r = readCredentials(p);
    assert.equal(r.apiKey, 'k1');
    assert.equal(r.apiUrl, 'u1');
  });

  it('帶 UTF-8 BOM 的 settings.json 仍能 parse（Adam/Eric 受害者）', () => {
    const p = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(p, '\uFEFF' + JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k2', OWNMIND_API_URL: 'u2' } } }
    }));
    const r = readCredentials(p);
    assert.equal(r.apiKey, 'k2', 'BOM 導致 JSON.parse fail → creds 空 → scanner 提早退');
    assert.equal(r.apiUrl, 'u2');
  });

  it('壞 JSON 仍回空 creds（不 crash）', () => {
    const p = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(p, 'not json');
    const r = readCredentials(p);
    assert.equal(r.apiKey, '');
    assert.equal(r.apiUrl, '');
  });

  it('不存在的檔案回空 creds', () => {
    const r = readCredentials(path.join(tmpDir, 'nope.json'));
    assert.equal(r.apiKey, '');
  });
});

describe('readJsonSafe — BOM tolerance', () => {
  it('無 BOM 正常', () => {
    const p = path.join(tmpDir, 'a.json');
    fs.writeFileSync(p, '{"foo":"bar"}');
    assert.deepEqual(readJsonSafe(p), { foo: 'bar' });
  });

  it('帶 BOM 仍能 parse', () => {
    const p = path.join(tmpDir, 'a.json');
    fs.writeFileSync(p, '\uFEFF{"foo":"baz"}');
    assert.deepEqual(readJsonSafe(p), { foo: 'baz' });
  });
});
