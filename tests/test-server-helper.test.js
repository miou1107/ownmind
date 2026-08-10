/**
 * v1.26.139 — the full suite failed a different two or three tests on every run, and none of
 * them was broken.
 *
 * Measured on Windows 2026-08-10 across four runs of `npm test`: 3 failures, then 4, then 4,
 * then 2, landing on a different set each time. Every one of them passed when its own file was
 * run alone, and the four files that failed most often passed 43/43 three times running when
 * executed together. A serial run of the whole suite (`--test-concurrency=1`, 4375 tests)
 * failed only the two that need a console build.
 *
 * So the tests were never the problem. The cause was in the harness they shared:
 *
 *     const srv = app.listen(0, async () => {
 *       const port = srv.address().port;          // …or read on the line after listen()
 *       await fetch(`http://127.0.0.1:${port}${path}`);
 *       srv.close();
 *     });
 *
 * Thirty-two files do this, several of them once per request, and `node --test` runs files in
 * parallel. Under that load `address()` does not reliably come back usable, nothing checks it,
 * and the port lands in the URL as `undefined`:
 *
 *     ✖ refuses further attempts once the ceiling is reached
 *       [TypeError: fetch failed] { [cause]: Error: bad port }
 *
 * Two of the four files read `address()` on the line straight after `listen(0)`, without
 * waiting for 'listening' at all — that one is a plain race, visible on any busy machine.
 *
 * `startServer` fixes both halves: it waits for 'listening', and it refuses to build a URL out
 * of an address it cannot use. This file pins the helper's own behaviour, because everything
 * that depends on it now depends on those two properties.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from './helpers/app-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('startServer', () => {
  it('hands back a URL that actually answers', async () => {
    const app = express();
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    const server = await startServer(app);
    try {
      const r = await fetch(`${server.url}/ping`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
    } finally {
      await server.close();
    }
  });

  it('the URL carries a real port, never undefined', () => {
    // The whole defect in one assertion: `http://127.0.0.1:undefined/…` is what undici
    // rejects as "bad port", and it is what a template string produces from a null address.
    return (async () => {
      const server = await startServer(express());
      try {
        assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, `got ${server.url}`);
        assert.ok(Number.isInteger(server.port) && server.port > 0);
        assert.doesNotMatch(server.url, /undefined/);
      } finally {
        await server.close();
      }
    })();
  });

  /**
   * A stand-in for `app.listen` that emits what we tell it to.
   *
   * A real EventEmitter, not a hand-rolled object with an `on`: `events.once` attaches and
   * then removes its own listeners, so anything less than the real interface fails on
   * `removeListener` and tests the fake instead of the helper.
   */
  const fakeApp = (address, event, arg) => ({
    listen() {
      const srv = new EventEmitter();
      srv.address = () => address;
      srv.close = (cb) => { if (cb) cb(); };
      srv.closeAllConnections = () => {};
      setImmediate(() => srv.emit(event, arg));
      return srv;
    },
  });

  it('reports a refused address instead of returning a broken URL', async () => {
    // The guard, driven. A listen that reports success but yields no usable address must fail
    // here with something that names the condition — not sixty seconds later as "timed out",
    // and never as a fetch error in whichever test drew the short straw.
    await assert.rejects(() => startServer(fakeApp(null, 'listening')), /no usable port/);
    // Port 0 is the other shape of the same thing: a number that cannot be dialled.
    await assert.rejects(() => startServer(fakeApp({ port: 0 }, 'listening')), /no usable port/);
  });

  it('surfaces a listen error rather than hanging until the timeout', async () => {
    // Without the 'error' race the await never settles and the file is reported as a timeout,
    // which says nothing about the port being unavailable.
    const err = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
    await assert.rejects(() => startServer(fakeApp({ port: 1 }, 'error', err)), /EADDRINUSE/);
  });

  it('close resolves, so a file does not linger on an open connection', async () => {
    const app = express();
    app.get('/x', (_req, res) => res.send('x'));
    const server = await startServer(app);
    await fetch(`${server.url}/x`);          // leaves a keep-alive socket behind
    await server.close();                     // must still resolve
    assert.ok(true);
  });
});

describe('the files that were measured flaking no longer open a server per request', () => {
  // Not every one of the thirty-two files is migrated — that would be a large diff for files
  // nothing has been seen to fail in. These four are the ones that actually failed, and a
  // regression here would bring the unattributable red back.
  const MIGRATED = [
    'tests/login-rate-limit.test.js',
    'tests/stage-1b-flip-root-retire-me.test.js',
    'tests/selfcheck-endpoint.test.js',
    'tests/self-check-memory-load.test.js',
  ];

  for (const rel of MIGRATED) {
    it(`${rel} goes through the shared helper`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const code = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      assert.match(code, /startServer\(/, `${rel} no longer uses the helper`);
      assert.doesNotMatch(code, /\.listen\(0/,
        `${rel} is opening its own listener again, which is where the bad port came from`);
    });
  }
});
