/**
 * v1.26.139 — one listening server per test file, with an address that is checked.
 *
 * The pattern this replaces opens a server per request:
 *
 *     const srv = app.listen(0, async () => {
 *       const { port } = srv.address();
 *       const r = await fetch(`http://127.0.0.1:${port}${path}`);
 *       srv.close();
 *     });
 *
 * Thirty-two test files do that, several of them dozens of times each, and `node --test` runs
 * the files in parallel. The result is thousands of concurrent listen/close cycles, and under
 * that load `srv.address()` does not always come back usable. Nothing checks it, so the port
 * goes into a template string and the request is made against `http://127.0.0.1:undefined/…`:
 *
 *     ✖ refuses further attempts once the ceiling is reached
 *       [TypeError: fetch failed] { [cause]: Error: bad port }
 *
 * Measured on Windows 2026-08-10 across four separate full-suite runs. Each run failed a
 * different two or three tests; every one of them passed when its file was run alone, and the
 * four files that failed most often passed 43/43 three times in a row when run together. So it
 * was never those tests: it was the harness, and which test it hit was decided by scheduling.
 *
 * A flake nobody can attribute is worse than a red test, because the habit it teaches is
 * "re-run until green" — and that habit is how a real regression gets shipped.
 *
 * Two changes, both small:
 *   - listen once per file rather than once per request, which removes the churn
 *   - wait for 'listening', then verify the address, and fail with what was actually seen
 *     rather than building a URL out of undefined
 *
 * Migrating a file is mechanical: call `startServer(app)` in `before`, `close()` in `after`,
 * and replace the per-request listen with a fetch against `url`.
 */

import { once } from 'node:events';

/**
 * Start `app` on an ephemeral port and hand back its base URL.
 *
 * @param {{ listen: Function }} app an Express app (or any http.Server factory)
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer(app) {
  const srv = app.listen(0);

  // listen() reports failures on 'error', not by throwing. Without this the await below hangs
  // until the test timeout and reports "the test timed out", which says nothing about the port.
  const failed = once(srv, 'error').then(([err]) => { throw err; });
  await Promise.race([once(srv, 'listening'), failed]);

  const addr = srv.address();
  if (!addr || typeof addr !== 'object' || !Number.isInteger(addr.port) || addr.port <= 0) {
    srv.close();
    throw new Error(
      `listen(0) reported listening but address() gave no usable port: ${JSON.stringify(addr)}`,
    );
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () => new Promise((resolve) => {
      // closeAllConnections, because close() only stops accepting and then waits for live
      // sockets. A keep-alive connection left by fetch keeps the callback from firing and the
      // file is reported as cancelled after its timeout.
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    }),
  };
}
