import { test } from 'node:test';
import { startServer } from './helpers/app-server.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// src/utils/crypto.js process.exit(1) if ENCRYPTION_KEY unset at import-time.
// Set a test-only key BEFORE dynamically importing app so the suite is
// runnable with plain `npm test` (no env prefix required).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || 'test-only-encryption-key-32-chars-x';
const { default: app } = await import('../src/app.js');

// v1.26.158 — through the shared helper: `listen(0)` can hand back a port `fetch` refuses to
// dial, which is the v1.26.143 finding. See tests/helpers/app-server.js.
async function listenApp() {
  const started = await startServer(createServer(app));
  return { server: { close: started.close }, base: started.url };
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.text();
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

test('GET /bootstrap.sh serves bash script without auth', async () => {
  const { server, base } = await listenApp();
  try {
    const res = await get(base, '/bootstrap.sh');
    assert.equal(res.status, 200);
    assert.match(res.body, /^#!\/usr\/bin\/env bash/);
    assert.match(res.headers['content-type'] || '', /text\/x-shellscript/i);
  } finally {
    server.close();
  }
});

test('GET /bootstrap.ps1 serves PowerShell script without auth', async () => {
  const { server, base } = await listenApp();
  try {
    const res = await get(base, '/bootstrap.ps1');
    assert.equal(res.status, 200);
    assert.match(res.body, /ErrorActionPreference\s*=\s*"Stop"/);
    assert.match(res.headers['content-type'] || '', /text\/plain/i);
  } finally {
    server.close();
  }
});
