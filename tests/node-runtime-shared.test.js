// shared/node-runtime.js: the names and checksum helper the client scripts and the server agree on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempDir } from './helpers/temp-dir.js';
import {
  NODE_LTS_MAJOR, nodeArchiveName, nodeDistUrl, shasumsUrl, verifySha256,
} from '../shared/node-runtime.js';

describe('shared/node-runtime', () => {
  it('pins Node 22', () => {
    assert.equal(NODE_LTS_MAJOR, 22);
  });

  it('names the four archives the installer can ask for', () => {
    const version = 'v22.11.0';
    assert.equal(nodeArchiveName({ os: 'darwin', arch: 'arm64', version }), 'node-v22.11.0-darwin-arm64.tar.gz');
    assert.equal(nodeArchiveName({ os: 'darwin', arch: 'x64', version }), 'node-v22.11.0-darwin-x64.tar.gz');
    assert.equal(nodeArchiveName({ os: 'win32', arch: 'arm64', version }), 'node-v22.11.0-win-arm64.zip');
    assert.equal(nodeArchiveName({ os: 'win32', arch: 'x64', version }), 'node-v22.11.0-win-x64.zip');
  });

  it('rejects an unknown os or arch', () => {
    assert.throws(() => nodeArchiveName({ os: 'linux', arch: 'x64', version: 'v22.11.0' }), /unsupported/);
    assert.throws(() => nodeArchiveName({ os: 'darwin', arch: 'ia32', version: 'v22.11.0' }), /unsupported/);
  });

  it('builds the nodejs.org URLs', () => {
    assert.equal(
      nodeDistUrl('node-v22.11.0-win-x64.zip'),
      'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip',
    );
    assert.equal(shasumsUrl('v22.11.0'), 'https://nodejs.org/dist/v22.11.0/SHASUMS256.txt');
  });

  it('verifySha256 is true for the right digest (any case) and false otherwise', async () => {
    const file = path.join(tempDir('node-runtime-'), 'a.bin');
    fs.writeFileSync(file, 'hello');
    const good = crypto.createHash('sha256').update('hello').digest('hex');
    assert.equal(await verifySha256(file, good), true);
    assert.equal(await verifySha256(file, good.toUpperCase()), true);
    assert.equal(await verifySha256(file, 'f'.repeat(64)), false);
  });

  it('verifySha256 rejects when the file is missing', async () => {
    await assert.rejects(verifySha256(path.join(tempDir('node-runtime-'), 'nope'), 'a'.repeat(64)));
  });
});
