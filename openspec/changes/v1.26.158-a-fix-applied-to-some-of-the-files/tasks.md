# Tasks

## 1. Name the cause before touching anything

- [x] Read the failure: `bad port`, not an assertion
- [x] Find that this project already diagnosed it — v1.26.143, with the measurement
      (400 parallel servers → 2 refused; 800 → 2)
- [x] Find the fix already written: `tests/helpers/app-server.js`
- [x] Measure how much of the suite it covers: **12 files never migrated**

The finding is not the bug. The finding is that the fix was applied to some of the files and
nothing said which ones it missed.

## 2. Migrate the twelve

- [x] `team-overview-last-active` — the one that actually went red
- [x] `changelog-feed`, `dashboard-version-source` — promise-wrapped listen
- [x] `debug-route-beacon-version`, `upgrade-complete-beacon` — port stashed on `app._server`
- [x] `bootstrap-routes`, `spa-deep-link-base` — `createServer` + a `listenApp` helper
- [x] `heartbeat-per-machine`, `install-started-beacon`, `install-check-null-byte-sanitize`
- [x] `bare-mount-trailing-slash`, `legacy-console-manifest` — request performed inside the
      listen callback

Each shape differed, so each was converted individually rather than by pattern.

## 3. The guard, which is the actual deliverable

- [x] `tests/no-raw-listen-with-fetch.test.js`: `.listen(0)` + `fetch(` without the helper fails
- [x] Names the twelve explicitly, so removing an import fails with a file name rather than as
      a red that drifts
- [x] Asserts its own premise: `fetch` really does refuse port 6000, and an ordinary high port
      is not on the list

## 4. Verify

- [x] Each file individually as it was converted
- [x] Guard passes, and the twelve are all found compliant
- [x] Full suite: 4838 tests, 4819 pass, 2 fail — both the pre-existing
      `bare-mount-trailing-slash` cases needing the gitignored `src/public/dashboard/` build

## 5. Release

- [x] CHANGELOG / FILELIST / three READMEs / package.json
- [x] Commit, push, tag `v1.26.158`

## Two things worth saying plainly

**Migrating twelve files fixes twelve files.** The guard is what stops the thirteenth. These
twelve were written *after* the problem was solved, which is only possible because nothing
checked.

**One raw `listen(0)` stays**, in `bare-mount-trailing-slash`'s `rawRequestLocation`. It writes
a hand-built request line to a socket, and blocked ports are a `fetch` rule. The guard is
satisfied because the file imports the helper — the right granularity.
