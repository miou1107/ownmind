import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import app from '../src/app.js';

function listenApp() {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
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
