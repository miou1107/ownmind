/**
 * The full suite failed a different two or three tests on every run, and none of them was
 * broken. Two releases went at this; only the second one had the cause.
 *
 * Measured on Windows 2026-08-10 across four runs of `npm test`: 3 failures, then 4, then 4,
 * then 2, a different set each time, always
 *
 *     [TypeError: fetch failed] { [cause]: Error: bad port }
 *
 * **v1.26.139 got it wrong.** It read that as a race — `srv.address()` returning nothing usable
 * under parallel load, so `undefined` reached the URL — introduced `startServer` with a wait
 * and an address check, saw three consecutive identical runs, and called it fixed. That was
 * luck. The next run brought it back, inside a file that had already been migrated, at the
 * fetch *after* a validated address.
 *
 * **v1.26.143 has the measured cause.** The failing URLs were `http://127.0.0.1:5060`, `:5061`,
 * `:6000`, `:6566` — valid ports, every one of them on the WHATWG fetch blocked-port list.
 * `fetch` refuses those outright:
 *
 *     await fetch('http://127.0.0.1:5060/')   → bad port
 *     await fetch('http://127.0.0.1:54321/')  → ECONNREFUSED   (allowed, nothing listening)
 *
 * `listen(0)` asks the OS for any free port and occasionally gets one of them. Reproduced with
 * a stress probe: 400 parallel servers → 2 refused, 800 → 2 refused. That is the whole thing —
 * no race, no load-dependent behaviour beyond "more draws, more chances", which is also why a
 * single file passed alone and why three clean runs proved nothing.
 *
 * `startServer` now draws again when it lands on a blocked port. The wait and the address check
 * from v1.26.139 stay: wrong explanation, still correct behaviour.
 *
 * The retry is asserted with a fake rather than by luck. A probe that happens to draw no
 * blocked ports says nothing about the branch that handles them, which is exactly the mistake
 * the previous release made with its three green runs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, FETCH_BLOCKED_PORTS } from './helpers/app-server.js';

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

  /**
   * An app whose successive `listen(0)` calls hand back the given ports in order.
   *
   * The blocked-port branch cannot be reached on demand through a real listener — the OS
   * decides — and a stress probe that happens to draw none proves nothing about it. That was
   * v1.26.139's mistake: three clean runs read as a fix.
   */
  const fakeAppSequence = (ports) => {
    let i = 0;
    return {
      closed: 0,
      listen() {
        const port = ports[Math.min(i, ports.length - 1)];
        i += 1;
        const srv = new EventEmitter();
        srv.address = () => ({ port });
        srv.close = (cb) => { this.closed += 1; if (cb) cb(); };
        srv.closeAllConnections = () => {};
        setImmediate(() => srv.emit('listening'));
        return srv;
      },
    };
  };

  it('draws again when the OS hands back a port fetch refuses', async () => {
    // 5060 is one of the four measured in the wild. The helper must not return it.
    const app = fakeAppSequence([5060, 6000, 54321]);
    const server = await startServer(app);
    assert.equal(server.port, 54321, 'a blocked port was handed back');
    assert.deepEqual(server.rejectedPorts, [5060, 6000], 'the skipped ports must be reported');
    assert.equal(app.closed, 2, 'each rejected listener must be closed, not leaked');
    await server.close();
  });

  it('the port it returns is never on the blocked list', () => {
    // Reverse control on the list itself: if it were empty, or missing the ports that were
    // actually seen, the retry above would be dead code and the defect would be back.
    for (const p of [5060, 5061, 6000, 6566]) {
      assert.ok(FETCH_BLOCKED_PORTS.has(p), `${p} was measured failing and must be on the list`);
    }
    assert.ok(FETCH_BLOCKED_PORTS.size > 50, 'the list looks truncated');
    assert.equal(FETCH_BLOCKED_PORTS.has(54321), false, 'an ordinary port must not be blocked');
  });

  it('gives up loudly when every draw is blocked', async () => {
    // Should never happen — eighty-odd ports out of tens of thousands, twenty times running.
    // If it does, the machine's ephemeral range is the story, and silence would hide it.
    await assert.rejects(
      () => startServer(fakeAppSequence([5060])),
      /could not get a port fetch will dial/,
    );
  });

  it('fetch really does refuse those ports — the premise, not a restatement', async () => {
    // Asserted against undici rather than assumed. If a future runtime stops refusing them,
    // this fails and the retry can be deleted; if it silently started refusing more, the
    // failure would be in whichever test drew one, which is where this started.
    await assert.rejects(() => fetch('http://127.0.0.1:5060/'), (err) => {
      assert.match(String(err.cause?.message ?? err.message), /bad port/);
      return true;
    });
    // Control: an ordinary port fails for a different, honest reason.
    await assert.rejects(() => fetch('http://127.0.0.1:54321/'), (err) => {
      assert.doesNotMatch(String(err.cause?.message ?? err.message), /bad port/);
      return true;
    });
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
