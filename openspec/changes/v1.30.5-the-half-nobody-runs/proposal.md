# The half nobody runs

## Why

This project is developed on macOS and used on Windows. On 2026-08-15 the suite was run on
Windows — the machine it ships to — and **15 tests failed there**. None of them fail on macOS,
which is why all of them had survived.

Two are product defects. The rest are tests that cannot be right on Windows and had never been
told so.

### The product defects

**1. Windows never synced the enforcement bundle.** `syncEnforcementBundle` was called from
exactly one place: `conditional-sync-cli.js`'s `main()`, which `ownmind-session-start.sh` runs.
Windows registers `ownmind-session-start.js`, which imports `runConditionalSync` directly and
never touched that CLI. So `~/.ownmind/cache/enforcement.json` was never written, every
standards check on the machine was disabled, and the prompt hook reported it on every single
turn:

> [OwnMind] This machine has never synced its standards, so nothing can be checked against them here.

Accurately. Forever. Measured: the server answers a direct request with 37 selectors, and the
file was still absent after a clean session start into a fresh home.

The comment above the CLI's call says the reasoning out loud:

> the .js hook is Windows-only. A sync written into the .js would never execute on the machine
> it was written for.

Both clauses are true of macOS and neither is true of Windows. A rule about two platforms,
written and checked on one.

**2. `client/src/scripts/translate.mjs` was a silent no-op on Windows.** Its entry-point check
read `import.meta.url === \`file://${process.argv[1]}\``. That is correct on POSIX by accident —
`/repo/x.mjs` supplies the third slash a `file:///` URL needs — and never true on Windows,
where argv[1] is `C:\repo\x.mjs`. The script ran, matched nothing, printed nothing, wrote
nothing, and **exited 0**. A second copy of the same line sits in
`hooks/lib/sync-memory-files.js`, harmless only because nothing on Windows invokes that file as
a CLI.

### The tests that could not pass

- **Ten** in `node-hook-parity.test.js` and `node-hook-reports-init.test.js` spawned the hook
  with `execFile` and never closed its stdin. The hook reads stdin to EOF, as Claude Code
  requires, so it waited for a payload that would never arrive — 25 seconds each, no output, no
  error, and a failure message about locks and init endpoints that pointed nowhere near it.
- **Four** in `real-db-lock.test.js` used a Windows path as an ESM specifier (`C:\…` parses as
  the scheme `c:`), joined PATH with `:`, and stubbed `docker` as an extensionless `#!/bin/sh`
  file. Windows cannot execute any of that.
- **One** in `gate-provisioning.test.js` asserted `gate.key` is mode `0400`. Windows has no
  POSIX mode bits; Node reports `0444` for a read-only file, and no chmod will ever produce
  `0400` there.

## What changes

**The Windows session-start hook syncs the enforcement bundle**, importing
`syncEnforcementBundle` rather than restating it — a second copy is how the platforms drifted.

**Both entry-point checks use `pathToFileURL`.**

**A guard**, `tests/no-file-url-concatenation.test.js`, fails on any `file://` built by
concatenation, and asserts its own premise per platform: that the two forms genuinely differ on
Windows and genuinely agree on POSIX. The second half is what stops a reader on a Mac from
concluding the rule is pedantry.

**The ten stdin tests close stdin**, which is also what Claude Code does — so they now test the
contract rather than an accident of the harness.

**The four docker tests are skipped on Windows with the reason stated**, because the fixture
shells out to `docker`, `ls` and `cat`. A skip that says why is a different fact from a
failure, and the two were being confused for months.

**The gate-key test asserts what Windows can guarantee** — that the file is not writable — and
says in the same place what it cannot: on Windows the key stays readable by other accounts, and
closing that needs an ACL rather than a mode. Stated rather than quietly relaxed.

## The shape, again

Five of the six defects here produce no error. A cache that is never written, a script that
exits 0 having done nothing, a hook that waits forever, a skip that looks like a failure. This
is the sixth week running in which every defect found on this project was silent.

The new thing this time is *where* they were. They were all in the half of the matrix nobody
runs.

## Impact

- `hooks/ownmind-session-start.js`, `hooks/lib/sync-memory-files.js`,
  `client/src/scripts/translate.mjs` — product.
- `tests/windows-session-start-syncs-enforcement.test.js`,
  `tests/no-file-url-concatenation.test.js` — new.
- `tests/node-hook-parity.test.js`, `tests/node-hook-reports-init.test.js`,
  `tests/real-db-lock.test.js`, `tests/gate-provisioning.test.js`,
  `tests/translate-hooks-dir.test.js` — corrected.
