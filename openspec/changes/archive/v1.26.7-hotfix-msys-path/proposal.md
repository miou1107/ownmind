# v1.26.7 — Hotfix: MSYS Path Handling in Shell-to-Node Calls

## One-Line Summary

Fix `verify_local` upgrade failure for Windows + Git Bash users: every shell
script that interpolates `$OWNMIND_DIR` / `$CLAUDE_DIR` into `node -p ... require(...)`
or `node -e ... readFileSync(...)` calls now normalizes the path through `cygpath -m`
before handing it to native Node.exe (which does not understand `/c/...` MSYS paths).
Existing `scripts/install-helpers/path-to-win32.cjs` was already designed for this
case but never wired in — v1.17.66 added the helper, but the shell scripts kept
inlining `${OWNMIND_DIR}` directly into `require(...)`, so the bug shipped to prod.

## The Bug (Vin reported 2026-05-26)

After upgrade, `scripts/verify-upgrade.sh --local` fails with `version_unreadable`,
triggering the auto-rollback path. Root cause at `verify-upgrade.sh:49`:

```bash
VERSION=$(node -p "require('${OWNMIND_DIR}/package.json').version" 2>/dev/null || echo "")
```

- Under Git Bash on Windows, `${OWNMIND_DIR}` expands to `/c/Users/Vin/.ownmind`
  (MSYS-style POSIX path).
- Node.exe on Windows does not recognize `/c/...` as a drive path — its module
  resolver expects `C:/Users/Vin/.ownmind` (or `C:\Users\Vin\.ownmind`).
- `require()` returns `MODULE_NOT_FOUND` → `$VERSION` is empty → `FAIL "version_unreadable"`
  → auto-rollback to the previous version → upgrade canceled.

Live evidence Vin captured:

| Probe | Result |
|---|---|
| `node -p "require('/c/Users/Vin/.ownmind/package.json').version"` | `Cannot find module` |
| `node -p "require('C:/Users/Vin/.ownmind/package.json').version"` | `1.20.4` ✅ |

## Impact

Every Windows + Git Bash user upgrading OwnMind hits this. Mac / Linux are fine
(path format already matches). Windows + PowerShell is also fine (PowerShell variables
expand to Windows paths). Only Windows + Git Bash → `bootstrap.sh` is broken.

## In Scope (7 call sites)

| File | Line | Call shape |
|---|---|---|
| `hooks/ownmind-session-start.sh` | 179 | `node -p "require('$OWNMIND_DIR/package.json').version"` |
| `scripts/interactive-upgrade.sh` | 133 | `node -e "...readFileSync('${CLAUDE_SETTINGS}', ...)"` |
| `scripts/interactive-upgrade.sh` | 213 | `node -p "require('${OWNMIND_DIR}/package.json').version"` |
| `scripts/verify-upgrade.sh` | 34 | `node -e "...readFileSync('${settings}', ...)"` |
| `scripts/verify-upgrade.sh` | 49 | `node -p "require('${OWNMIND_DIR}/package.json').version"` (the one Vin reported) |
| `scripts/check-sync.sh` | 53 | `node -e "...require('${OWNMIND_DIR}/package.json').version"` |
| `scripts/check-sync.sh` | 71 | `node -e "...readFileSync('${CLAUDE_DIR}/settings.json', ...)"` |

## Fix Strategy

Add a shared bash helper `scripts/install-helpers/path-helpers.sh` exposing
`to_win_path()`:

```bash
to_win_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}
```

- `cygpath -m` outputs mixed style (`C:/Users/Vin/.ownmind`) — Node accepts it.
  Avoid `cygpath -w` (would produce backslashes that need bash-escaping).
- Git Bash always ships `cygpath`; Mac / Linux don't, so fallback returns the
  path unchanged — cross-platform safe.

Every affected shell script is updated to:
1. `source` the helper at the top.
2. Cache the normalized path once (e.g. `OWNMIND_DIR_WIN="$(to_win_path "${OWNMIND_DIR}")"`).
3. Use the `_WIN` variant inside `node -p ... require()` / `node -e ... readFileSync()` calls.

`scripts/install-helpers/path-to-win32.cjs` is left untouched — the helper's
existing `toWin32Path` / `toMsysPath` functions remain available for any Node
caller, but the shell call sites now use the bash helper because dispatching
through Node would itself need a working `require()` resolver (chicken-and-egg).

## Out of Scope

- The `path-to-win32.cjs` Node helper itself is not modified (already correct).
- Other path interpolations into shell commands (curl, cp, etc.) are unaffected
  because MSYS path handling there is fine.
- `hooks/ownmind-tty-echo.cjs` etc. that already run under Node and don't shell
  out to native binaries with path args.

## Acceptance Criteria

- New unit test `tests/path-to-win32.test.js` covers `toWin32Path` /
  `toMsysPath` round-trip behavior (mocks `process.platform` so it runs on Mac CI too).
- New bash integration test `tests/path-helpers-bash.test.js` spawns `bash` to
  source `path-helpers.sh` and verify `to_win_path` output under simulated
  cygpath-present / cygpath-absent environments.
- `npm test` passes (baseline 1956 + new tests).
- `package.json` bumped to 1.26.7.
- CHANGELOG.md / FILELIST.md / trilingual READMEs updated.

## Risk

- **Low** — only adds a normalization step before existing native-Node calls.
  Mac / Linux pass through unchanged. Windows + PowerShell unchanged (does not
  source these `.sh` files). The only platform whose behavior changes is
  Windows + Git Bash, which is currently 100% broken.

## History Note

`path-to-win32.cjs` was added in v1.17.66 (commit a2f701c) explicitly to handle
this scenario; its header comment cites `verify-upgrade.sh:49` as the example
case. But the shell scripts were never updated to use it — the helper has sat
unused for ~2 months while the bug shipped in every release. This hotfix closes
the loop.
