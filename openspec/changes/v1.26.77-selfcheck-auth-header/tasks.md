# v1.26.77 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Found by upgrading a real machine

- [x] Vin's Mac upgraded to v1.26.76. Eight checks passed; the ninth, the one added in
      v1.26.72 to confirm data reaches the server, reported `the server answered 401`.
- [x] `fetchSelfCheck` sends `X-API-Key`; `src/middleware/auth.js` reads
      `req.headers.authorization` with a `Bearer ` prefix and nothing else.
- [x] Broken since v1.26.72. The single production check made when it was written hit a
      v1.26.67 server, which answers 404 from the router before auth runs.

## Phase 1 — RED

- [x] `tests/selfcheck-report.test.js` — the request must carry `Authorization: Bearer`.
      Failed before the fix.
- [x] A second test reads `src/middleware/auth.js` and asserts the header and scheme it
      parses, so the client and the middleware cannot drift apart silently again.

## Phase 2 — GREEN

- [x] `shared/scanners/selfcheck.js` — `Authorization: Bearer ${apiKey}`.

## Phase 3 — Verify against the real server

- [x] Called production directly with both headers: `X-API-Key` → 401,
      `Authorization: Bearer` → 200 with five tool rows. Measured, not reasoned.
- [x] Full suite.

## Phase 4 — Sync

- [x] `package.json` 1.26.77, `README.md` ×3, `CHANGELOG.md`, `FILELIST.md`

## Phase 5 — Deploy and re-run the check that failed

- [x] Production rebuilt on v1.26.77, zero errors since restart.
- [x] Vin's Mac upgraded again. **9 passed, 0 warnings, 0 failed**, with the ninth reading
      `the server has this machine's data for 5 tool(s)`. The check that has never worked
      since it was written now answers the question it was built to answer.
- [x] Server-side confirmation of the whole line of work, from the heartbeat table:
      all five tools at `scanner_version 1.26.77`, and for the first time a **reason** on
      each row — `ok` for claude-code, `no_new_activity` for the other four.
      Two things follow from that, neither of which was visible before today:
      - v1.26.69's reason codes are arriving. The column was NULL under the old scanner.
      - OpenCode reports `no_new_activity`, not `unreadable`. Its database cannot be
        opened `-readonly` on this machine right now; the collector read it anyway through
        the v1.26.71 copy fallback and found nothing new. The fix works on a machine that
        actually exhibits the condition.

## What this and v1.26.76 have in common

Two defects in two hours, both invisible to a passing test suite, both for the same
reason: **the test faked both sides of a contract.**

- v1.26.76 — every test hands the route a fake `query`, so nothing ever parsed the SQL.
  Postgres rejected the statement outright.
- v1.26.77 — the client's tests fake `fetch` and the endpoint's tests fake `auth`, so
  nothing ever compared the header sent against the header read.

Worth recording as a shape to look for, not just two bugs to have fixed: when both ends of
an interface are stubbed, the suite measures the stubs agreeing with themselves.
