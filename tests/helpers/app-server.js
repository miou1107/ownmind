/**
 * A listening server for a test file, on a port `fetch` will actually dial.
 *
 * v1.26.139 introduced this helper and named the wrong cause. v1.26.143 has the measured one.
 *
 * The symptom: four consecutive full-suite runs failed 3, then 4, then 4, then 2 tests, a
 * different set each time, always as
 *
 *     [TypeError: fetch failed] { [cause]: Error: bad port }
 *
 * v1.26.139 read that as a race — `srv.address()` returning nothing usable under parallel load,
 * so `undefined` reached the URL — and added the wait and the address check below. Three runs
 * then failed identically and it was called fixed. That was luck. The fourth run brought it
 * back, in a file that had already been migrated, at the fetch *after* a validated address.
 *
 * The real cause, measured 2026-08-11: the failing URLs were `http://127.0.0.1:5060`, `:5061`,
 * `:6000`, `:6566` — all perfectly valid ports, and all on the WHATWG fetch **blocked port
 * list**. `fetch` refuses them outright, whether or not anything is listening:
 *
 *     await fetch('http://127.0.0.1:5060/')   → bad port
 *     await fetch('http://127.0.0.1:54321/')  → ECONNREFUSED   (allowed, nothing there)
 *
 * `listen(0)` asks the OS for any free port. Occasionally it hands back one of those, and the
 * request fails for a reason that has nothing to do with the test. Reproduced deterministically:
 * 400 parallel servers → 2 refused; 800 → 2 refused. That is why it drifted between runs, why
 * a single file passed alone, and why it never named a real defect.
 *
 * The fix is to stop returning a port `fetch` will not dial: check it, and draw again.
 *
 * The wait-for-'listening' and address check from v1.26.139 stay. They were the wrong
 * explanation but they are still correct behaviour — reading `address()` on the line after
 * `listen(0)` really can return null, and a failure that says so beats one that says
 * "timed out".
 *
 * Migrating a file is mechanical: call `startServer(app)` in `before`, `close()` in `after`,
 * and replace the per-request listen with a fetch against `url`.
 */

import { once } from 'node:events';

/**
 * Ports `fetch` refuses, from the WHATWG bad-port list.
 *
 * Hard-coded because there is no way to ask undici for it. Kept whole rather than trimmed to
 * the ones seen in the wild: the point is that the OS may hand back any of them, and a list
 * that is nearly complete would leave exactly the same defect happening less often — which is
 * the state this helper was already in for one release.
 */
export const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** How many times to draw another ephemeral port before giving up. */
const MAX_PORT_ATTEMPTS = 20;

/**
 * Start `app` on an ephemeral port and hand back its base URL.
 *
 * @param {{ listen: Function }} app an Express app (or any http.Server factory)
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer(app) {
  const rejected = [];

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
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

    // The port is valid and bound, and `fetch` may still refuse to dial it. Draw again rather
    // than hand back a URL whose only defect is the number in it — that is the whole v1.26.143
    // finding. Closing first keeps the next draw from colliding with this one.
    if (FETCH_BLOCKED_PORTS.has(addr.port)) {
      rejected.push(addr.port);
      await new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      });
      continue;
    }

    return {
      url: `http://127.0.0.1:${addr.port}`,
      port: addr.port,
      /** Ports skipped for being on the blocked list. Empty on almost every call. */
      rejectedPorts: rejected,
      close: () => new Promise((resolve) => {
        // closeAllConnections, because close() only stops accepting and then waits for live
        // sockets. A keep-alive connection left by fetch keeps the callback from firing and the
        // file is reported as cancelled after its timeout.
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      }),
    };
  }

  // Eighty-odd blocked ports out of tens of thousands, twenty times in a row: this should not
  // happen, and if it does the machine's ephemeral range is the story. Said out loud rather
  // than retried forever.
  throw new Error(
    `could not get a port fetch will dial after ${MAX_PORT_ATTEMPTS} attempts; `
    + `all were on the blocked list: ${rejected.join(', ')}`,
  );
}
