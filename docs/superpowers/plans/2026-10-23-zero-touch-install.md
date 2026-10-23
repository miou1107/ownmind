# Zero-touch Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A colleague with no git, no Node and no admin rights pastes one prompt into the Claude desktop app, clicks "allow" once, and ends up with OwnMind loading memories in a new conversation, with the admin seeing it on the team page.

**Architecture:** The client installer gains an *archive mode* (no git: download a release archive from Vin's server) and a *private Node runtime* (no system Node: download the official Node archive into `~/.ownmind/runtime`). Every entry script prepends that runtime to PATH; config entries that call `node` directly are written with the absolute path only on such machines. The server gains an `/api/install` router that serves the bootstrap scripts, the archive, Node archives and a `first-load` query. The installer prints `FIX:` / `ASK:` / `NEXT:` lines that an AI-facing manual explains; after install the AI opens a verification conversation itself and a detached watcher notifies the user once memories loaded.

**Tech Stack:** bash (macOS), PowerShell 5.1+ (Windows), Node 20+ (CommonJS helpers under `scripts/install-helpers`, ESM under `shared/`), Express server, React console, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-23-zero-touch-install-design.md`

## Global Constraints

- Client `npm install` runs only in `mcp/`; no native dependency may be added to `mcp/` or `hooks/`.
- Node floor stays `20` (`OWNMIND_NODE_FLOOR` in `preflight.sh`, `$script:OwnMindNodeFloor` in `preflight.ps1`); the private runtime downloads the newest even-numbered LTS line, pinned in one place (`shared/node-runtime.js`, `NODE_LTS_MAJOR`).
- Machines with a system Node >= 20 or with git keep today's behaviour and today's generated configuration byte for byte. Tests pin this.
- Archive-mode installs follow the **server's** version. Git installs keep following GitHub's newest release tag.
- `install.sh` / `install.ps1` are served anonymously; `archive`, `node` and `first-load` require the API key.
- New user-facing strings: `hooks/locales/zh.json` first, then `en.json` + `en.override.json`, `ja.json` + `ja.override.json`; the four English fallback files listed in `CLAUDE.md` stay in sync (`tests/hook-english-fallbacks-match-dictionary.test.js`).
- Code, comments, tests and docs in English; the AI-facing manual starts with `audience: agent`.
- No `🤖 Generated with Claude Code` line in commits, PRs or issues.
- Every commit: README (three languages), FILELIST, CHANGELOG updated in the same commit when a user-visible behaviour or a file list changes.
- The console column (Task 15) is shown to Vin as a mockup and approved before its code is written.
- Release at the end (Vin, 2026-10-23: release it when it is done): PR, merge, tag, deploy with `docker compose build --no-cache`.

## Review Focus

1. A machine with a system Node 18 (below the floor) and no git: the installer must take the private-runtime path, not stop with "node too old". Test in Task 5.
2. A second run of the one-liner on a machine whose first run died after unpacking but before `npm install`: must resume cleanly, not report "already installed" or "not a git repo, backing up". Test in Task 4.
3. A home directory containing a space or a non-ASCII name (`/Users/Jörg Müller`, `C:\Users\Jane Doe`): the absolute Node path in every config entry must be quoted and parse back. Test in Task 7.
4. The Claude desktop app's permission prompt denied once by the colleague (the AI tool reports the command was not allowed): the manual must route the AI to the permission guidance, not to a `FIX:` retry loop. Test in Task 12 (manual grammar test asserts the section exists and the runbook names it).
5. The watcher polling `first-load` while the user never opens a conversation: must stop after ten minutes with the "open a new conversation" notification and never a success. Test in Task 14.

---

## Batch 0: evidence before code

### Task 1: A simulated clean Mac, and whether a new conversation picks up a fresh install

Vin cannot provide a second Mac or a scratch account (2026-10-23), so the clean machine is
simulated on this Mac and the simulation is reused by the acceptance task.

**Files:**
- Create: `tests/helpers/clean-mac-sim.mjs` (`makeCleanMac({ keep = ['bash','sh','curl','tar','gzip','sed','awk','grep','mkdir','mv','rm','cp','ln','chmod','cat','date','uname','sleep','head','tail','tr','cut','wc','dirname','basename','env','printf','touch','find','xargs','osascript','mktemp','sw_vers','id','whoami','tee','sort','uniq','readlink','stat','df'] }) -> { home, binDir, env }`: a throwaway HOME, a `bin/` of symlinks to those system tools only (no `git`, no `node`, no `npm`, no `brew`), and an `env` object with `HOME`, `PATH=<binDir>`, `CLAUDECODE` unset; `cleanup()`)
- Create: `docs/superpowers/plans/2026-10-23-zero-touch-install-evidence.md` (the run log; appended by the acceptance task)

**Interfaces:**
- Produces: `makeCleanMac()` used by Task 4/5 e2e tests and by Task 16.

- [ ] **Step 1: Write the helper and a self-test** (`tests/clean-mac-sim.test.js`): inside the env, `command -v git` and `command -v node` fail, `command -v curl` and `tar` succeed, `$HOME` is empty.
- [ ] **Step 2: Does a new `claude` process read a fresh install?** The Claude Code login on
  macOS lives in the keychain under a name derived from the config directory, so a throwaway
  HOME is never logged in and `claude -p` cannot be used (probed 2026-10-23: "Not logged in").
  Use the two things that do not need a login: (a) with today's scripts, install OwnMind by
  hand into the simulated HOME (seed `~/.ownmind` from this tree as
  `tests/install-clean-machine.e2e.mjs` does; a stub server is enough), then run
  `env -u CLAUDECODE HOME=<home> claude mcp list` and record whether `ownmind` is listed and
  connected: that is the real binary reading the fresh `~/.claude.json` exactly as a new
  desktop conversation would (the desktop app spawns this binary per conversation with
  `--setting-sources=user,project,local`); (b) the hook half is already evidenced by
  `~/.ownmind/logs/2026-10-23.jsonl` on Vin's Mac, where the SessionStart hook ran at the
  start second of each of three desktop conversations. Copy both into the evidence file.
- [ ] **Step 3: Write the result into the evidence file.** Loaded: Task 13 builds no restart helper. Not loaded: Task 13 builds the fallback with the yes/no question.
- [ ] **Step 4: Commit** `test: simulated clean Mac helper and new-process evidence`.

## Batch 1: private Node and archive mode (removes the 2026-10-22 failures)

### Task 2: Server serves the bootstrap scripts and the archive

**Files:**
- Create: `src/routes/install.js`
- Create: `src/services/install-archive.js`
- Modify: `src/app.js:85` (mount before `apiLimiter` with its own limiter) and `:236` (mount router)
- Modify: `Dockerfile` (the container must contain `scripts/`, `install.sh`, `install.ps1`, `mcp/`, `hooks/`, `shared/`, `skills/`, `configs/`, `docs/ai-install-runbook.md`; check what `COPY` already includes)
- Test: `tests/install-routes.test.js`

**Interfaces:**
- Produces: `createInstallRouter({ query, auth, logger, repoRoot })` exported from `src/routes/install.js`; routes `GET /install.sh`, `GET /install.ps1`, `GET /install-manual.md` (anonymous, `text/plain; charset=utf-8`), `GET /api/install/archive` (auth; `application/gzip`; header `X-OwnMind-Release: vX.Y.Z`), `GET /api/install/first-load?since=<ISO>` (auth; JSON `{ loaded: boolean, at: ISO|null }`; Task 14 uses it).
- Produces: `buildInstallArchive({ repoRoot, version }) -> Promise<{ path, version, sha256 }>` in `src/services/install-archive.js`: a `.tar.gz` of the server's own checkout minus `node_modules`, `client/node_modules`, `.git`, `tests`, `db`, `src`, `client/src`, built once per process start into `os.tmpdir()/ownmind-install-<version>.tar.gz`, containing a top-level `.release` file with the version and `install.sh` / `install.ps1` at the root.

- [ ] **Step 1: Write failing tests** in `tests/install-routes.test.js`: `GET /install.sh` returns 200, body starts with `#!/usr/bin/env bash`, no auth; `GET /api/install/archive` without key returns 401; with key returns 200, `content-type` gzip, header `X-OwnMind-Release` equals `package.json` version; the archive, when listed with `tar -tzf`, contains `.release` and `install.sh` and not `src/` or `node_modules/`; `first-load` returns `{loaded:false}` when no `init`/`hook` row newer than `since`, `{loaded:true, at}` when one exists (seed `activity_logs` via the test DB helper used by `tests/install-check-alerts.test.js`).
- [ ] **Step 2: Run the tests, confirm they fail** (`node --test tests/install-routes.test.js`).
- [ ] **Step 3: Implement `src/services/install-archive.js` and `src/routes/install.js`.** Scripts are read from `repoRoot` on each request (small files). The archive route streams the file. `first-load` query: `SELECT ts FROM activity_logs WHERE user_id=$1 AND event='init' AND source='hook' AND ts > $2 ORDER BY ts DESC LIMIT 1`.
- [ ] **Step 4: Mount in `src/app.js`**: `app.use(['/install.sh','/install.ps1','/install-manual.md'], installLimiter)` with `rateLimit({ windowMs: 60_000, max: 30 })`; `app.use('/api/install', installLimiter, createInstallRouter(...))` placed **before** `app.use('/api', apiLimiter)` so the archive download is not counted against the 200/min cap. Add `COPY` lines to `Dockerfile` for anything missing.
- [ ] **Step 5: Run the tests, confirm they pass. Run `npm test`.**
- [ ] **Step 6: Commit.**

```bash
git add src/routes/install.js src/services/install-archive.js src/app.js Dockerfile tests/install-routes.test.js FILELIST.md
git commit -m "feat(server): serve install scripts, release archive and first-load query"
```

### Task 3: Server serves Node archives with checksum and cache

**Files:**
- Create: `src/services/node-archive.js`
- Create: `shared/node-runtime.js`
- Modify: `src/routes/install.js` (add `GET /api/install/node`)
- Modify: `docker-compose.yml` (named volume `ownmind_install_cache` mounted at `/var/cache/ownmind-install` on `api`)
- Test: `tests/node-archive.test.js`, `tests/node-runtime-shared.test.js`

**Interfaces:**
- Produces (shared, used by client scripts through `node -e` and by the server): `NODE_LTS_MAJOR = 22`, `nodeArchiveName({ os, arch, version }) -> string` (`node-v22.x.y-darwin-arm64.tar.gz`, `node-v22.x.y-win-x64.zip`), `nodeDistUrl(name) -> string`, `shasumsUrl(version) -> string`, `verifySha256(filePath, expectedHex) -> Promise<boolean>` in `shared/node-runtime.js`.
- Produces: `GET /api/install/node?os=darwin|win32&arch=arm64|x64` (auth) streams the archive; header `X-Node-Version`, `X-Sha256`. The server resolves "latest 22.x" from `https://nodejs.org/dist/index.json` once per 24 h, downloads to the cache dir, verifies against `SHASUMS256.txt`, serves from cache afterwards. On any upstream failure returns 503 with `{ error: 'node_upstream_unavailable' }` so the client falls back to nodejs.org directly.

- [ ] **Step 1: Write failing tests**: `nodeArchiveName` for the four OS/arch pairs; `verifySha256` true/false on a temp file; route returns 400 on unknown os/arch; route returns 503 when the injected fetch rejects; route serves a cached file with the two headers when the injected fetch returns a fixture archive and matching checksum list.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement**, with `fetch` and the cache directory injected (`createNodeArchiveService({ fetch, cacheDir, now })`) so tests use no network.
- [ ] **Step 4: Add the volume to `docker-compose.yml`; add `INSTALL_CACHE_DIR` to `.env.example` with that path.**
- [ ] **Step 5: Run tests, `npm test`. Commit.**

```bash
git commit -am "feat(server): cache and serve Node LTS archives for the private runtime"
```

### Task 4: bootstrap.sh archive mode

**Files:**
- Modify: `scripts/bootstrap.sh` (the whole git-required preflight at lines 38-50 and branches 1 and 2)
- Create: `scripts/install-helpers/fetch-release.sh` (sourced by bootstrap; functions `ownmind_download` with retry and source fallback, `ownmind_unpack_release`)
- Test: `tests/bootstrap-archive-mode.test.js` (static assertions in the style of `tests/bootstrap-script.test.js`) and `tests/bootstrap-archive-mode.e2e.mjs` (runs the script against a local HTTP fixture server with `OWNMIND_DIR` in a temp dir and `PATH` stripped of git)

**Interfaces:**
- Consumes: `GET <API_URL>/api/install/archive` (Task 2), `OWNMIND_SOURCE=server|github` env override.
- Produces: the layout `~/.ownmind/.release` (one line `vX.Y.Z`), `~/.ownmind.partial` as the in-progress dir renamed to `~/.ownmind` only after a full unpack; output lines `INFO:archive_mode:…`, `OK:unpack:…`, `ERROR:download:…` followed by `FIX:use_fallback_source:OWNMIND_SOURCE=github bash <same one-liner>`, `ASK:no_network:<sentence>`.

- [ ] **Step 1: Write the static test**: script has no unconditional `exit 1` on missing git; contains `.release`; contains `.ownmind.partial`; contains each of `FIX:use_fallback_source`, `FIX:clear_partial`, `ASK:no_network`; branch 2 (`exists but is not a git repo`) now checks for `.release` first and treats that as a healthy archive install (delegates to `interactive-upgrade.sh`, Task 9).
- [ ] **Step 2: Write the e2e**: fixture server serving a tiny tar.gz with `.release` + `install.sh` stub; run `bash scripts/bootstrap.sh KEY http://127.0.0.1:PORT` with `PATH=/usr/bin:/bin` minus git (use a temp bin dir); assert `.release` exists and `.partial` does not; second run with the stub `install.sh` made to fail after unpack → third run resumes (Review Focus 2); unreachable server → output has `ASK:no_network`.
- [ ] **Step 3: Run, confirm fail. Implement.** `curl --retry 3 --retry-all-errors -fsSL -H "Authorization: Bearer $KEY"` to the server, then codeload fallback; `tar -xzf` into `.partial`; `mv`.
- [ ] **Step 4: Run tests. Commit.**

```bash
git commit -am "feat(install): bootstrap.sh installs from the release archive when git is absent"
```

### Task 5: Private Node runtime on macOS

**Files:**
- Create: `scripts/install-helpers/ensure-node-runtime.sh` (sourced; `ownmind_ensure_node` sets `OWNMIND_NODE` to a usable node >= 20, downloading the private runtime when needed)
- Modify: `install.sh:104-150` (replace the brew/stop block with `ownmind_ensure_node`; the "Node.js too old" exit at ~146 becomes a runtime download)
- Modify: `scripts/install-helpers/preflight.sh` (missing git is no longer a failure; missing or old node reports `node\tprivate runtime will be installed\t…` and returns 0)
- Modify: `scripts/bootstrap.sh` (call `ownmind_ensure_node` after unpack, before `install.sh`, since `install.sh` runs node helpers)
- Test: `tests/node-runtime-mac.test.js` (static + an e2e that points the download at a fixture tar.gz containing a fake `bin/node` shell script that prints `v22.0.0`)

**Interfaces:**
- Produces: `~/.ownmind/runtime/node-v22.x.y/bin/node`, symlink `~/.ownmind/runtime/current -> node-v22.x.y`, env `OWNMIND_NODE=<abs path>` and `OWNMIND_PRIVATE_NODE=1` exported for the rest of `install.sh`; `~/.ownmind/.node-path` written with that path (the scanner wrappers already read it).
- Consumes: `GET /api/install/node` (Task 3), nodejs.org fallback, `shared/node-runtime.js` names.

- [ ] **Step 1: Failing tests**: system node 18 on PATH (fake) and no git → private runtime installed and used (Review Focus 1); system node 22 on PATH → no download, `OWNMIND_PRIVATE_NODE` unset; `preflight.sh` with no git exits 0.
- [ ] **Step 2: Implement. Step 3: run tests, `npm test`. Step 4: Commit.**

```bash
git commit -am "feat(install): download a private Node runtime on macOS when none is usable"
```

### Task 6: Private Node runtime and archive mode on Windows

**Files:**
- Modify: `scripts/bootstrap.ps1` (mirror of Task 4; `Invoke-WebRequest` + `Expand-Archive` for the OwnMind archive via a server-side `.zip` variant: add `?format=zip` to `/api/install/archive` in `src/services/install-archive.js`)
- Modify: `install.ps1:97-185` (winget block becomes: use system node if >= 20, otherwise private runtime from `/api/install/node?os=win32&arch=x64|arm64`; git no longer installed or required)
- Modify: `scripts/install-helpers/preflight.ps1` (same semantics as Task 5)
- Modify: `mcp/start.cmd` (first lookup: `%USERPROFILE%\.ownmind\runtime\current\node.exe`)
- Test: `tests/bootstrap-archive-mode-ps1.test.js` (static, mirrors Task 4's assertions), `tests/install-ps1-private-node.test.js` (static: no `Install-WithWinget 'Git.Git'`; `runtime\current` referenced; `start.cmd` checks it first). PowerShell behaviour is covered by the Windows CI job that already runs `tests/*.ps1`-driven tests (see `.github/workflows/test.yml`); add a pester-free smoke: run `powershell -File scripts/bootstrap.ps1` against the fixture server only when `$IS_WINDOWS` (skip otherwise, matching `tests/check-sync-ps1-reads-json-as-utf8.test.js`).

- [ ] Steps as Task 4/5: failing tests → implement → tests → commit `feat(install): archive mode and private Node runtime on Windows`.

### Task 7: Make the private runtime reachable from every hook and config entry

**Files:**
- Modify: `hooks/ownmind-session-start.sh` (top, after `OWNMIND_DIR=`: `[ -d "$OWNMIND_DIR/runtime/current/bin" ] && PATH="$OWNMIND_DIR/runtime/current/bin:$PATH"`)
- Modify: `scripts/install-helpers/run-scanner.sh`, `scripts/check-sync.sh`, `scripts/interactive-upgrade.sh`, `scripts/update.sh` (same one line)
- Modify: `scripts/install-helpers/session-hook-command.cjs` (`sessionStartCommand` gains `nodeBin`; Windows command becomes `"<nodeBin>" "<path>"` when `nodeBin` given; `isGeneratedCommand` accepts a quoted absolute node in front)
- Modify: `scripts/install-helpers/ensure-pretooluse-hooks.cjs:77,93`, `add-stop-hook.cjs:41`, `add-post-tool-use-hook.cjs:41` (same: `nodeBin` option; matcher accepts both)
- Modify: `scripts/install-helpers/ensure-session-hook.cjs` and the three callers in `install.sh` (§4c-1, 4c-2, 2.1, 2.2) and `install.ps1` (§2.1, 2.2, 4c): pass `--node-bin "$OWNMIND_NODE"` only when `OWNMIND_PRIVATE_NODE=1`
- Modify: `install.sh:446-452` and the matching `install.ps1:415-449`: `MCP_COMMAND="$OWNMIND_NODE"` when private, else `node` (unchanged)
- Modify: `scripts/install-helpers/install-artifacts.cjs`, `self-check.cjs`: resolve the node to check from the configured command's first token when it is an absolute path
- Test: `tests/private-node-config-shapes.test.js`

**Interfaces:**
- Produces: `sessionStartCommand({ platform, hookDir, ownmindDir, nodeBin })`, `isGeneratedCommand(cmd)` true for `node "<p>"` and `"<abs>/node" "<p>"` and `"<abs>\node.exe" "<p>"`; `buildPreCmd({ ownmindDir, nodeBin })` etc. with the same rule.

- [ ] **Step 1: Failing tests**: with `nodeBin` unset every generator returns exactly today's string (snapshot the current outputs first; this pins goal 6); with `nodeBin='/Users/Jörg Müller/.ownmind/runtime/current/bin/node'` the command is quoted and `JSON.parse(JSON.stringify(settings))` round-trips (Review Focus 3); `needsRewrite` returns false for an existing absolute-form entry when `nodeBin` matches and false for an existing bare entry when `nodeBin` is unset; the MCP entry written by `register-mcp-cli.cjs` with `--command <abs>` is read back by `install-artifacts.cjs` and the node it names is executed.
- [ ] **Step 2: Implement. Step 3: `npm test` (the existing `installer-node-paths.test.js`, `ensure-session-hook.test.js`, `install-mcp-entry-path.test.js` must stay green). Step 4: Commit.**

```bash
git commit -am "feat(install): hooks and MCP use the private Node runtime when the machine has none"
```

### Task 8: Prompt, site and README point at the server and carry the behaviour rules

**Files:**
- Modify: `client/src/utils/install-prompt.js` (`buildInstallPrompt(user, apiUrl)` returns the new structure; Chinese wording drafted through the copy skills and reviewed by `agy_review.py` before commit)
- Modify: `client/src/utils/install-prompt.test.js` (or wherever its tests live: `grep -rl buildInstallPrompt client/src tests`)
- Modify: `docs/site/strings.json` (`box2Prompt`, `box2Or`), `README.md`, `README.zh-TW.md`, `README.ja.md` install sections
- Test: existing prompt tests updated; `tests/readme-install-prompt-consistency.test.js` (new: the three READMEs and the site string contain the same one-liner shape as `install-prompt.js`)

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: run the copy skills + `python3 ~/.claude/hooks/agy_review.py` on the Chinese files. Step 4: `npm test`. Step 5: Commit** `feat(console): install prompt served from the OwnMind server, with the AI behaviour rules`.

### Task 9: Upgrades for archive installs

**Files:**
- Create: `shared/archive-update.js` (`runArchiveUpdate({ ownmindDir, apiUrl, apiKey, execFile, fetch, fileSystem, logEvent, now }) -> { outcome, from, to }`: compare `.release` with the server version from `GET /api/version`-equivalent that the session sync already receives (`shared/auto-update.js` has the server version in its deps? If not, call `GET /api/install/archive` with `HEAD` and read `X-OwnMind-Release`); download to `~/.ownmind.next`, `npm install --ignore-scripts` in `mcp/` with the node beside `process.execPath`, copy `credentials`, `cache/`, `state/`, `logs/`, `runtime/`, swap, write a marker `~/.ownmind/.swap-pending` on EBUSY for the next session start)
- Modify: `shared/auto-update.js:198` (`no_git_dir` → if `.release` exists, delegate to `runArchiveUpdate`)
- Modify: `scripts/interactive-upgrade.sh:120-140, 207-290` and `scripts/interactive-upgrade.ps1:148-330` (archive branch: skip git, call `node shared/archive-update.js --cli`, then continue with step 4 re-run install); sweep at `interactive-upgrade.sh:452` and `.ps1:505` extended to `.ownmind.broken.*` and `.ownmind.prev`
- Modify: `scripts/check-sync.sh:36-70` and `.ps1` L1 (`release=vX.Y.Z` when `.release` exists; `in_sync`/`behind` by comparing with the server version)
- Modify: `scripts/install-helpers/update-to-release.mjs` (`--print` in archive mode prints the `.release` value)
- Modify: `skills/ownmind-upgrade.md` mode A table (`L1_REMOTE:release=…` is healthy)
- Test: `tests/archive-update-shared.test.js` (injected fs/fetch/execFile, mirrors `tests/auto-update-shared.test.js`), `tests/check-sync-archive-mode.test.js`, `tests/upgrade-sweep-covers-broken-and-prev.test.js`

- [ ] **Step 1: Failing tests**: same version → `CLEAN`, no download; newer → `APPLIED`, `.prev` exists, credentials preserved; npm failure → `FAILED`, `~/.ownmind` untouched, `.next` removed; EBUSY on rename → `.swap-pending` written; `check-sync.sh` on an archive dir prints `L1_REMOTE:in_sync release=v1.34.0`; sweep removes a `.broken.*` dir older than 7 days (run the sweep function in a temp HOME).
- [ ] **Step 2: Implement. Step 3: `npm test`. Step 4: Commit** `feat(update): archive installs update from the server release`.

---

## Batch 2: the AI's manual, the verification conversation, the watcher

### Task 10: Output grammar: FIX / ASK / NEXT, localized ASK sentences

**Files:**
- Create: `scripts/install-helpers/install-messages.cjs` (`askLine(code, locale) -> 'ASK:<code>:<sentence>'`, `fixLine(code, cmd)`, `nextLine(kind, detail)`; sentences from `hooks/locales/<lang>.json` keys `install.ask.no_network`, `install.ask.disk_full`, `install.ask.all_sources_blocked`, `install.next.verify_manual_terminal`, `install.next.verify_manual_generic`)
- Modify: `hooks/locales/zh.json`, `en.json`, `en.override.json`, `ja.json`, `ja.override.json`
- Modify: `scripts/bootstrap.sh`, `scripts/bootstrap.ps1`, `install.sh`, `install.ps1`: every existing hard stop that a user cannot fix (network, disk) emits `ASK:`; every retryable stop emits `ERROR:` + `FIX:`; the end of a successful install emits `NEXT:` (Task 13 decides the kind)
- Test: `tests/install-messages.test.js`, `tests/install-output-grammar.test.js` (static: every `exit 1` in the four scripts is preceded within 5 lines by an `ERROR:`+`FIX:` pair or an `ASK:`)

- [ ] **Step 1: Failing tests (grammar test will list today's bare exits). Step 2: Write the zh sentences through the copy skills; translate. Step 3: Implement. Step 4: `npm test` including `hook-english-fallbacks-match-dictionary.test.js`. Step 5: Commit** `feat(install): FIX/ASK/NEXT output grammar with localized ASK sentences`.

### Task 11: The AI-facing manual, served and installed as the skill

**Files:**
- Create: `docs/ai-install-runbook.md` (first line `audience: agent`; five sections per spec §4: what is installed, output grammar with the closed `FIX:` code list, troubleshooting + permissions subsection, definition of done, functional test)
- Modify: `skills/ownmind-upgrade.md` (install section replaced by an include of the runbook content; `install.sh:538-545` and the `.ps1` twin already copy this file)
- Modify: `src/routes/install.js` (`GET /install-manual.md` serves `docs/ai-install-runbook.md`; Dockerfile `COPY docs/ai-install-runbook.md`)
- Test: `tests/ai-install-runbook.test.js`: first line is `audience: agent`; every `FIX:` code emitted by the four scripts (grep) is documented, and no documented code is unused; the permissions subsection names the AI tool's allow prompt, read-only mode, PowerShell policy, macOS folder refusal, non-admin account (Review Focus 4); the runbook never contains `brew install`, `xcode-select`, `winget install`, `nodejs.org/en/download` as instructions to the user.

- [ ] Steps: failing test → write → test → commit `docs: AI-facing install manual with FIX/ASK/NEXT grammar and permission guidance`.

### Task 12: Verification conversation and the terminal sentence

**Files:**
- Modify: `install.sh`, `install.ps1` (final `NEXT:` decision: `CLAUDE_CODE_ENTRYPOINT=claude-desktop` → `NEXT:verify:new-session`; `CLAUDE_CODE_ENTRYPOINT=cli` or unset with a TTY → `NEXT:verify:manual:<terminal sentence>`; else `NEXT:verify:manual:<generic sentence>`)
- Modify: `docs/ai-install-runbook.md` §5 and `skills/ownmind-upgrade.md`: on `verify:new-session`, the AI starts a session with the desktop app's session tool, title from locale key `install.verify.session_title`, brief = run the functional test (context present, `ownmind_search`, status button, save-and-find one memory) and report one line per item
- Test: `tests/install-next-line.test.js` (static: the three branches exist in both scripts; the env var names are exactly `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_DESKTOP_APP_VERSION`)

- [ ] Steps: failing test → implement → test → commit `feat(install): NEXT:verify line; the AI opens the verification conversation on the desktop app`.

### Task 13: Restart fallback (only if Task 1 said a new conversation is not enough)

**Files:**
- Create: `scripts/install-helpers/restart-host.sh`, `.ps1`
- Modify: `install.sh`/`install.ps1` (`NEXT:restart:claude-desktop` instead of `verify:new-session` when `OWNMIND_RESTART_REQUIRED=1`, a constant set by this task from Task 1's evidence)
- Modify: runbook §5: ask the yes/no question first, in the user's language (`install.ask.restart_ok` locale key), run the helper on yes
- Test: `tests/restart-host.test.js` (static: five-second sleep before quit; relaunch uses the captured parent executable path, never a literal `open -a Claude`; log file path)

- [ ] If Task 1 showed memories load in a new conversation: write "not built, see evidence file" in this task and skip. Otherwise steps as above; commit `feat(install): restart helper for hosts that need a full restart, after a yes`.

### Task 14: The watcher: poll first-load, notify

**Files:**
- Create: `scripts/install-helpers/first-load-watch.cjs` (`watchFirstLoad({ apiUrl, apiKey, since, fetch, notify, now, sleep, timeoutMs = 600_000, intervalMs = 15_000 })`; `notify(kind)` kinds `loaded` | `not_loaded`)
- Create: `scripts/install-helpers/notify.sh` (`osascript -e 'display notification …'`), `notify.ps1` (toast via `Windows.UI.Notifications`, falling back to `msg`/balloon on PowerShell 5.1)
- Modify: `install.sh`/`install.ps1`: after the self-check, spawn the watcher detached (`nohup … &` / `Start-Process -WindowStyle Hidden`) with `since=$(date -u +%FT%TZ)` taken at the start of the install
- Modify: locales: `install.notify.loaded`, `install.notify.not_loaded`
- Test: `tests/first-load-watch.test.js` (injected fetch/clock: loaded on the third poll → `notify('loaded')` once and stop; never loaded → `notify('not_loaded')` once at 600 s and stop, never `loaded` (Review Focus 5); fetch throwing → keeps polling)

- [ ] Steps: failing tests → implement → test → commit `feat(install): watcher notifies the user once memories loaded`.

---

## Batch 3: console

### Task 15: Team page column "last memory load"

**Files:**
- Modify: `src/routes/admin.js:89-113` (`GET /users` adds `last_memory_load_at`, `last_machine` via two LEFT JOIN LATERAL subqueries on `activity_logs` (`event='init' AND source='hook'`) and `install_check_logs` (latest `machine`), and `last_install_error_at` from `install_check_logs` where `summary->>'status' = 'error'` or the equivalent field the self-check writes; check `tests/install-check-alerts.test.js` for the field name)
- Modify: `client/src/pages/Admin/TeamPage.jsx:231-240` (new `<th>` `t('team.col.last_load')` between `password_status` and `usage_7d`; cell shows the light + relative time + machine)
- Modify: `client/src/i18n/*.json` (`team.col.last_load`, `team.load.green`, `team.load.yellow`, `team.load.red` tooltips; zh first)
- Test: `tests/admin-users-last-load.test.js` (server: seeded rows → the three fields; a user with no rows → nulls); client test beside the existing TeamPage tests for the light mapping: loaded < 24 h → green, never → yellow, error after last load → red

- [ ] **Step 0: Mockup first.** Build a static HTML mockup of the table with the new column (three example rows: Emily green, Morishita yellow, Frank red), publish as an Artifact, get Vin's OK. Do not start Step 1 before that.
- [ ] Steps: failing tests → implement → `npm test` → commit `feat(console): team page shows each member's last memory load`.

---

## Batch 4: acceptance and release

### Task 16: Acceptance on simulated clean machines

- [ ] **Step 1 (Mac):** with `makeCleanMac()` (Task 1) and the real server running locally (`docker compose up` if Docker is available, else `npm start` against the test database used by the suite), run the exact one-liner from the new prompt inside the simulated env, hands off. Record: every output line, time to `NEXT:`, the files under the fake `~/.ownmind` and `~/.claude`, then run the real `claude` binary once with that HOME and record the verification output (context line, `ownmind_search` named). Append to the evidence file.
- [ ] **Step 2 (Windows):** there is no Windows machine. Add a job to `.github/workflows/test.yml` (`install-windows-clean`) that runs `scripts/bootstrap.ps1` on `windows-latest` with `$env:Path` reduced to `C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0` (no git, no node) against the fixture server from Task 6, and asserts `.release`, `runtime\current\node.exe` and the generated `settings.json` entries. Its green run is the Windows evidence; link the run URL in the evidence file.
- [ ] **Step 3:** Break the server's archive route once (stop the local server) and confirm the GitHub fallback path produces a working install with no `FIX:` line.
- [ ] **Step 4:** On this developer machine (git and Node present), run the upgrade and diff `~/.claude/settings.json` and `~/.claude.json` before/after: no change in any OwnMind entry.
- [ ] **Step 5:** Commit the evidence.

### Task 17: Release

- [ ] **Step 1:** `superpowers:verification-before-completion`: full `npm test`, `npm run build:client`, the e2e tests that exist for install.
- [ ] **Step 2:** README ×3, FILELIST, CHANGELOG (version `v1.34.0`: "Zero-touch install: archive mode, private Node runtime, AI manual, verification conversation, team page last-load column"), `package.json` version bump.
- [ ] **Step 3:** `superpowers:requesting-code-review`; address with `superpowers:receiving-code-review`.
- [ ] **Step 4:** PR against `main` (no generated-with line), merge, tag `v1.34.0`.
- [ ] **Step 5:** Deploy: on the production host `git pull && docker compose build --no-cache && docker compose up -d`; confirm `GET /install.sh` from outside and `GET /api/install/node?os=darwin&arch=arm64` with Vin's key returns 200.
- [ ] **Step 6:** Re-run the Mac acceptance (Task 16 Step 1) against production. Tell Vin: the new prompt is in the console's copy action; Frank, Emily and Morishita can re-run it to move onto the archive/private-runtime layout, or stay as they are.
