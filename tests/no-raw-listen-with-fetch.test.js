import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FETCH_BLOCKED_PORTS } from './helpers/app-server.js';

/**
 * v1.26.158 — the fix existed and was applied to some of the files.
 *
 * v1.26.143 measured the cause of a red that had been drifting around the suite for two
 * releases: `listen(0)` asks the OS for any free port, and about one draw in a few hundred
 * comes back on the WHATWG **blocked port list** — 5060, 6000, 6566 and the rest — which
 * `fetch` refuses outright, whether or not anything is listening. It wrote
 * `tests/helpers/app-server.js` to draw again, and its own header says migrating a file is
 * mechanical.
 *
 * Twelve files were never migrated. On 2026-08-12 one of them went red in a full run:
 *
 *     ✖ still decides who appears from the session logs
 *       [TypeError: fetch failed] { [cause]: Error: bad port }
 *
 * That is the same shape as everything else found that day — a guard that exists in one place
 * and not in the others, with nothing to say so. This test is the "nothing to say so" part.
 *
 * It does not check that a file is *correct*. It checks that a file cannot quietly opt out of
 * the only thing that makes its ports dialable.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = __dirname;

/** The helper itself, and the tests that exist to exercise it directly. */
const EXEMPT = new Set([
  'test-server-helper.test.js',
  'no-raw-listen-with-fetch.test.js',
]);

function testFiles() {
  return fs.readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !EXEMPT.has(f));
}

describe('v1.26.158 — no test dials a port it drew without checking', () => {
  it('every file that both listens and fetches goes through the helper', () => {
    const offenders = testFiles().filter((f) => {
      const src = fs.readFileSync(path.join(testsDir, f), 'utf8');
      if (!/\.listen\(\s*0\b/.test(src)) return false;
      if (!/\bfetch\(/.test(src)) return false;
      return !/from '\.\/helpers\/app-server\.js'/.test(src);
    });

    assert.deepEqual(offenders, [],
      'these start a server on an ephemeral port and then fetch it, without the helper that '
      + 'redraws when the OS hands back a port fetch refuses. Import startServer from '
      + './helpers/app-server.js — see the header there for the measurement.');
  });

  it('and the twelve migrated in this release are among them', () => {
    // Named, so that deleting the import from one of them fails here with the file name
    // rather than as a red that drifts to a different file on every run.
    const migrated = [
      'bare-mount-trailing-slash', 'bootstrap-routes', 'changelog-feed',
      'dashboard-version-source', 'debug-route-beacon-version', 'heartbeat-per-machine',
      'install-check-null-byte-sanitize', 'install-started-beacon', 'legacy-console-manifest',
      'spa-deep-link-base', 'team-overview-last-active', 'upgrade-complete-beacon',
    ];
    for (const name of migrated) {
      const file = path.join(testsDir, `${name}.test.js`);
      assert.ok(fs.existsSync(file), `${name}.test.js is gone — update this list`);
      assert.match(fs.readFileSync(file, 'utf8'), /from '\.\/helpers\/app-server\.js'/,
        `${name}.test.js stopped importing the helper`);
    }
  });
});

describe('v1.26.158 — the premise this guard rests on', () => {
  it('fetch really does refuse the blocked ports', async () => {
    // v1.26.143 added a test like this so that if a runtime ever stops refusing them, the
    // failure names the premise rather than leaving the redraw as unexplained ceremony.
    // Repeated here because this file's whole argument is "the helper is load-bearing".
    await assert.rejects(
      () => fetch('http://127.0.0.1:6000/'),
      (err) => /bad port/i.test(String(err?.cause?.message || err?.message)),
      'if this stops throwing, the helper and this guard can both be deleted',
    );
  });

  it('and allows an ordinary high port, so the check above is about the port list', () => {
    // A refusal for any reason would satisfy the assertion above. This separates
    // "refused because of the number" from "refused because nothing is listening".
    assert.equal(FETCH_BLOCKED_PORTS.has(54321), false);
    assert.equal(FETCH_BLOCKED_PORTS.has(6000), true);
  });
});
