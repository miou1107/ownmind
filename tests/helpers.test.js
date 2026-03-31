import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonSafe, getChangedSourceFiles, getClientVersion, readCredentials, SOURCE_PATTERNS } from '../shared/helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('readJsonSafe', () => {
  it('reads valid JSON file', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-helpers-valid.json');
    fs.writeFileSync(tmpFile, '{"key": "value"}');
    const result = readJsonSafe(tmpFile);
    assert.deepEqual(result, { key: 'value' });
    fs.unlinkSync(tmpFile);
  });

  it('returns null for missing file', () => {
    const result = readJsonSafe('/tmp/nonexistent-helpers-test.json');
    assert.equal(result, null);
  });

  it('returns null for invalid JSON', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-helpers-invalid.json');
    fs.writeFileSync(tmpFile, 'not json');
    const result = readJsonSafe(tmpFile);
    assert.equal(result, null);
    fs.unlinkSync(tmpFile);
  });
});

describe('SOURCE_PATTERNS', () => {
  it('is an array of RegExp', () => {
    assert.ok(Array.isArray(SOURCE_PATTERNS));
    assert.ok(SOURCE_PATTERNS.every(p => p instanceof RegExp));
  });
});

describe('getChangedSourceFiles', () => {
  it('filters files matching SOURCE_PATTERNS', () => {
    const files = ['src/app.js', 'README.md', 'mcp/index.js', 'docs/setup.md', 'shared/helpers.js'];
    const result = getChangedSourceFiles(files);
    assert.deepEqual(result, ['src/app.js', 'mcp/index.js', 'shared/helpers.js']);
  });

  it('returns empty for no matches', () => {
    const result = getChangedSourceFiles(['README.md', 'docs/setup.md']);
    assert.deepEqual(result, []);
  });

  it('accepts custom patterns', () => {
    const result = getChangedSourceFiles(['lib/foo.js', 'src/bar.js'], [/^lib\//]);
    assert.deepEqual(result, ['lib/foo.js']);
  });
});

describe('getClientVersion', () => {
  it('returns a version string', () => {
    const version = getClientVersion();
    assert.ok(typeof version === 'string');
    assert.ok(version.length > 0);
  });
});

describe('readCredentials', () => {
  it('returns empty strings when settings file does not exist', () => {
    const result = readCredentials('/tmp/nonexistent-settings.json');
    assert.deepEqual(result, { apiKey: '', apiUrl: '' });
  });

  it('reads credentials from settings file', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-settings.json');
    fs.writeFileSync(tmpFile, JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: 'https://example.com' } } }
    }));
    const result = readCredentials(tmpFile);
    assert.deepEqual(result, { apiKey: 'test-key', apiUrl: 'https://example.com' });
    fs.unlinkSync(tmpFile);
  });
});
