# A fix applied to some of the files

## Why

v1.26.143 measured a red that had been drifting around the suite for two releases. `listen(0)`
asks the OS for any free port, and roughly one draw in a few hundred comes back on the WHATWG
**blocked port list** — 5060, 6000, 6566 and the rest — which `fetch` refuses outright, whether
or not anything is listening. It wrote `tests/helpers/app-server.js` to draw again, and its own
header says migrating a file is mechanical.

**Twelve files were never migrated.** On 2026-08-12, during a requested end-to-end check of the
product, one of them went red in a full run:

```
✖ still decides who appears from the session logs
  [TypeError: fetch failed] { [cause]: Error: bad port }
```

Nothing was wrong with the code under test. Nothing was wrong with the assertion. The port
number was on a list.

This is the same shape as everything else found that day — a leaked temp directory, a standard
that never fired, a search returning zero, a tag nobody validated. **A guard exists, it covers
some of the cases, and there is nothing that says which ones it does not cover.**

## What changes

**All twelve files go through `startServer`.** The shapes differed — per-request `listen`, a
`before` hook, a promise wrapper, a `listen` callback that did the whole request inside it —
so each was converted individually rather than by pattern.

**A guard test.** `tests/no-raw-listen-with-fetch.test.js` fails when any test file both calls
`.listen(0)` and uses `fetch(` without importing the helper. It does not check that a file is
correct; it checks that a file cannot quietly opt out of the only thing that makes its ports
dialable.

That guard is the actual deliverable. Migrating twelve files fixes twelve files; the guard is
what stops the thirteenth from being written next week with nothing to notice it — which is
exactly how these twelve came to exist after the problem had already been solved.

**The guard names its own premise.** It asserts that `fetch` really does refuse port 6000. If a
future runtime stops doing that, the failure says so, and both the helper and this guard can be
deleted — rather than the premise expiring quietly and leaving the redraw as unexplained
ceremony.

## What is not covered, on purpose

`bare-mount-trailing-slash.test.js` keeps one raw `listen(0)` in `rawRequestLocation`, which
writes a hand-built request line to a socket. Raw sockets have no blocked-port list; the
restriction is a `fetch` rule. The guard passes that file because it imports the helper, which
is the right granularity: the rule is "this file cannot dial an unchecked port with `fetch`",
not "this file may never call listen".

## Impact

- Twelve files under `tests/`, converted.
- `tests/no-raw-listen-with-fetch.test.js` — new.
- No product code. Nothing outside `tests/`.
