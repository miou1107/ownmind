# Zero-touch install: evidence log

Appended to by later tasks (the acceptance run adds its own section at the bottom).

## Task 1: does a new `claude` process read a fresh OwnMind install?

Date: 2026-10-23

Machine:

| | |
|---|---|
| `sw_vers` | macOS 26.6.2 (build 25G83) |
| `uname -m` | arm64 |
| `claude --version` | 2.1.309 (Claude Code), `/opt/homebrew/bin/claude` |

### Why this question

A clean colleague's Mac cannot be borrowed, so it is simulated with `makeCleanMac()`
(`tests/helpers/clean-mac-sim.mjs`): a throwaway HOME and a PATH of system tools only. The
Claude Code login on macOS lives in the keychain under a name derived from the config
directory, so a throwaway HOME is never logged in and `claude -p` answers "Not logged in".
`claude mcp list` needs no login. It starts a new process, reads the HOME's `~/.claude.json`,
spawns every configured server and reports its health, which is what a new desktop
conversation does at start (the desktop app spawns this same binary per conversation).

### Step 2 (a): MCP half, run on this Mac

Setup, in a script that is not committed (`.superpowers/sdd/.../task-1-evidence-run.mjs`):

1. `makeCleanMac()` gives a fresh HOME. For this run only, the PATH also holds
   `/opt/homebrew/bin`, because today's `install.sh` needs git and node. The question here is
   whether a new process reads the fresh config, not whether the no-git install works.
2. `~/.ownmind` is seeded from this working tree the way `tests/install-clean-machine.e2e.mjs`
   does it, with `.no-usage-scanner` set so no launchd agent is registered.
3. Today's `install.sh <test key> <stub server url>` runs, with the stub server answering
   asynchronously. Exit status 0; the installer's own self-check ended with
   `12 passed, 2 warnings, 1 failed`. The one failure is `scheduler: launchctl failed: spawn
   launchctl ENOENT`, because `launchctl` is not in the simulated PATH (see the note at the
   end). The two warnings are about the stub server, not about Claude.
4. `~/.claude.json` then holds `mcpServers.ownmind` with `command: node` and
   `args: [<HOME>/.ownmind/mcp/index.js]`.

Command (HOME is the throwaway home created in step 1; the shell form of what the script ran,
with the working directory set to that home so no project `.mcp.json` is picked up):

```
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT HOME=<simulated home> \
    XDG_CONFIG_HOME=<simulated home>/.config GIT_CONFIG_GLOBAL=<simulated home>/.gitconfig \
    /opt/homebrew/bin/claude mcp list
```

Output, verbatim (exit status 0, 1.4 s):

```
Checking MCP server health…

ownmind: node /private/var/folders/mz/7v6cjc253073zf4xdw94wg7m0000gn/T/clean-mac-home-EXEa44/.ownmind/mcp/index.js - ✔ Connected
```

stderr was empty. `ownmind` is listed and connected.

For completeness the script also ran the registered command by hand in that HOME and sent an MCP
`initialize` request on stdin. The server answered with `serverInfo: ownmind-mcp 1.33.1` and
wrote nothing to stderr (the script's own `ETIMEDOUT` is only the 20 s wait for the server,
which stays alive while stdin is open).

An earlier run from the repository directory also listed two servers from the developer's
own project settings (`claude-usage`, `chrome-devtools`, both "Pending approval"). Those came
from the working directory, not from the fresh HOME, and are not part of this evidence.

### Step 2 (b): hook half, already on Vin's Mac

`~/.ownmind/logs/2026-10-23.jsonl` records the OwnMind SessionStart hook running when a
desktop conversation starts. The `init` events with `source: hook` and
`start_source: startup` on 2026-10-23:

```
13:46:22  init  hook  session 7b8dbca5-cd18-4ffa-ab59-84d009f8ecc4  startup  project multi-claude-switcher
14:51:05  init  hook  session 474455b8-2b42-4977-86a1-ca29653565c0  startup  project VinPlayground
16:14:01  init  hook  session 011f66ce-ecef-46e2-8651-d84ddb3b9398  startup  project vinstory
16:51:12  init  hook  session a896c13d-86ee-4ebd-b4ec-0dcbb91e4803  startup  project OwnMind
17:22:13  init  hook  session 369ecaa4-85ca-425a-8022-b446222cda4c  startup  project vinstory
17:25:26  init  hook  session 5ef9bfd9-5ead-4846-bb59-173e9868a59e  startup  project vinstory
```

(All six lines read `status: ok`. One more line, 16:52:36, has `start_source: compact` and is
not a new conversation.) The brief for this task says the hook ran in the start second of three
desktop conversations; the log shows six startup runs on that day. The correlation with the
exact second each conversation began is not something the log alone can prove, and it was not
re-checked here.

### Conclusion

Loaded: a brand-new `claude` process started after the install found `mcpServers.ownmind` in
the fresh `~/.claude.json` and connected to it, so Task 13 builds no restart helper.

### Notes for later tasks

- `makeCleanMac()` has no `launchctl`, so today's installer reports `scheduler ... ENOENT` in
  its self-check even with `.no-usage-scanner` set. A later e2e that asserts "no failures" in
  that summary will need `launchctl` added to `keep`, or that line excluded.
- A server in the same process as a blocking `spawnSync` cannot answer the child that is
  calling it. `tests/install-clean-machine.e2e.mjs` has this shape (its first run shows
  `This operation was aborted` in the self-check). Later e2e tests that need the stub to answer
  should spawn asynchronously.

## Task 16: acceptance on a simulated clean Mac, against the real server

Date: 2026-10-23 (final run 15:34 UTC)

Machine: macOS 26.6.2 (build 25G83), arm64. Claude Code 2.1.309, `/opt/homebrew/bin/claude`.

Conclusion: on a simulated clean Mac (git stub only, no node), the install prompt's one-liner
against the real server installed OwnMind in 42 seconds with no question to the person, a new
`claude` process connected to it, and the next conversation received the memory; this took two
fixes to the product, both found by this run (below).

### How it was run

`tests/zero-touch-acceptance.e2e.mjs`, first test. The server is the real `src/app.js` (every
route, middleware and rate limit) on a real Postgres in Docker with this repository's
migrations, one seeded user, `INSTALL_CACHE_DIR` a fresh temporary folder, so the private Node
came from nodejs.org through `/api/install/node` on this run. The machine is
`makeCleanMac({ xcodeStub: true })`: an empty HOME, a PATH of system tools only, `git` the
stub that opens the developer-tools dialog (it leaves a marker file if it is ever run), no node.

The one deviation from a real clean Mac: the usage scanner is opted out with
`~/.ownmind/.no-usage-scanner`, because its `launchctl load -w` talks to the live login session
and would replace the developer's own `com.ownmind.usage-scanner` agent. The file cannot exist
before the run (bootstrap moves an `~/.ownmind` without `.release` aside as broken), so the test
writes it the moment the release is unpacked and asserts the installer printed its opt-out line.
As a second guard, `launchctl` on the simulated PATH answers `list` (with the developer's own
`com.ownmind.*` lines removed) and refuses everything else; the run made one call, `list`, from
the self-check. Notifications were dry-run, and the detached watcher was stopped at the end.

Command, exactly as the AI runs it (port chosen at random, key elided):

```
curl -fsSL http://127.0.0.1:56270/install.sh | bash -s -- <KEY> http://127.0.0.1:56270
```

### Two defects found, fixed in d8bd345b

First run (before any fix) ended with exit status 1, after the release was unpacked and the
private Node installed:

```
[ OK ] Installed git post-merge hook
xcode-select: note: No developer tools were found, requesting install.
xcode-select: note: No developer tools were found, requesting install.
[FAIL] install.sh aborted at line 917
ERROR:install_aborted:install.sh aborted at line 917
FIX:retry_install:curl -fsSL http://127.0.0.1:55881/install.sh | bash -s -- <KEY> http://127.0.0.1:55881
ERROR:install:install.sh failed (missing API_KEY/URL or other error)
```

`install.sh` decided whether to set the global git hooks path with `command -v git`, which finds
the stub. On a real Mac the colleague would have seen the developer-tools dialog twice, and the
install stopped. It now uses `ownmind_git_usable` from `preflight.sh`, the check `bootstrap.sh`
already used (regression test: `tests/install-git-stub-hooks-path.test.js`).

Second run: the install passed and the server answered `loaded: true`, but the SessionStart
hook printed nothing. Stock macOS has no `timeout` command (a developer's Mac has it from
Homebrew); `hooks/ownmind-session-start.sh` ran `timeout 5 node session-start-output.js`, which
became "command not found" with its error discarded. The hook had already reported a successful
load to the server, so the watcher would have told the colleague "OwnMind is running" while the
conversation held no memory. The hook now defines a stand-in `timeout` when the machine has none
(regression test: `tests/session-hook-without-timeout.test.js`).

### Final run, full output (exit status 0)

Time from the start of the command to the `NEXT:` line: 42 s (the whole run, including the
nodejs.org download through the server and `npm install`).

```
INFO:detect:Checking OwnMind installation (/private/var/folders/mz/7v6cjc253073zf4xdw94wg7m0000gn/T/clean-mac-home-67l0ZL/.ownmind)
INFO:archive_mode:git is not installed; installing from the release archive
INFO:download:Downloading the release archive from http://127.0.0.1:56270
OK:unpack:release v1.33.1 unpacked
INFO:node_download:trying the OwnMind server, then nodejs.org (this can take a few minutes when offline)
INFO:node:Downloading Node.js from http://127.0.0.1:56270
OK:node:private Node v22.23.4 installed
INFO:install:Running install.sh (forwarding API_KEY + API_URL)
OwnMind installer
─────────────────────────────────────────────
INFO:node:using private Node v22.23.4
[INFO] Archive install v1.33.1; updates come from the OwnMind server
[INFO] Installing dependencies
[INFO] Creating Claude Code MCP config
       MCP registered in ~/.claude.json (verified by reading it back)
   PostToolUse banner hook：[add-post-tool-use-hook] added (backup: ~/.claude/settings.json.bak.2026-10-23T15-35-44-824Z)
   Stop reply-lint hook：[add-stop-hook] added (backup: ~/.claude/settings.json.bak.2026-10-23T15-35-44-857Z)
[ OK ] CLAUDE.md carries the OwnMind rules block
[INFO] Installed ownmind-memory + ownmind-upgrade skills (Claude Code)
[INFO] Upgrade rules synced: 0 installed, 6 skipped
[INFO] Installed hook scripts (session-start + iron-rule-check) + hooks/lib + hooks/locales
[ OK ] PreToolUse iron-rule hook: [ensure-pretooluse-hooks] added: Bash
[ensure-pretooluse-hooks] added: Edit|Write|MultiEdit|NotebookEdit
[ensure-pretooluse-hooks] added: UserPromptSubmit
[ OK ] SessionStart hook: OK:hook:installed
[ OK ] OwnMind mods: OK:mods:ownmind-monitor=installed,wrapup-check=installed
[ OK ] Background credentials: OK:keyfile:already_safe the API key is in .claude/settings.json, which a scheduled run can read
[INFO] Installing Git hooks (Iron Rule Verification Engine)
[ OK ] Installed git pre-commit hook
[ OK ] Installed git post-commit hook
[ OK ] Installed git commit-msg hook
[ OK ] Installed git pre-merge-commit hook
[ OK ] Installed git pre-push hook
[ OK ] Installed git post-checkout hook
[ OK ] Installed git post-merge hook
[WARN] git not found, skipping global hooks path
[INFO] Skipping usage scanner install (.no-usage-scanner opt-out)
[ OK ] Key files: owner-only (~/.claude/settings.json 644->600, ~/.claude/settings.json.bak.2026-10-23T15-35-44-857Z 644->600, ~/.claude/settings.json.bak.2026-10-23T15-35-45-019Z 644->600)
[ OK ] install complete: 9/9 artifacts present
Checking:  usage data reaches the server (running one scan)

OwnMind self-check
--------------------------------------------------
[ OK ]  mcp_files            ~/.ownmind/mcp/index.js
[ OK ]  mcp_registered       ~/.claude.json
[ OK ]  mcp_launches         handshake ok, 36/36 tools are ownmind_* (ownmind-mcp v1.33.1)
[ OK ]  package_version      v1.33.1
[ OK ]  mcp_node_modules     93 modules
[ OK ]  server_health        http://127.0.0.1:56270/health -> 200
[ OK ]  api_key_format       valid (len=42)
[ OK ]  credential_agreement all config locations agree
[ OK ]  background_credentials the API key is in .claude/settings.json, which a scheduled run can read
[ OK ]  api_credentials      authenticated
[ OK ]  git_hooks            3 hooks installed
[ OK ]  install_complete     9/9 artifacts present
[FAIL]  scheduler            launchd agent not found
        Fix: Re-run install.sh or: launchctl load ~/Library/LaunchAgents/com.ownmind.usage-scanner.plist
[FAIL]  memory_load          memories have never loaded automatically on this account
        Fix: Re-run the installer, then fully restart your AI tool and open a new conversation
[ OK ]  usage_roundtrip      the server has this machine's data for 0 tool(s)

Summary:  13 passed, 0 warnings, 2 failed
Log:      ~/.ownmind/logs/self-check-20261023T153546.log
Upload:   succeeded
--------------------------------------------------


─────────────────────────────────────────────
OwnMind installation complete
─────────────────────────────────────────────
  MCP Server: ~/.ownmind/mcp/index.js
  API URL:    http://127.0.0.1:56270
  API Key:    zero****cdef

Auto-load configured for detected platforms:
  [ OK ] Claude Code        SessionStart hook
  [ OK ] Git hooks          pre-commit + post-commit (Iron Rule Verification)

NEXT:verify:manual:OwnMind is installed. Start a new conversation and your memory will load.
OK:done:Fresh install complete (release archive)
NEXT:verify:manual:OwnMind is installed. Start a new conversation and your memory will load.
```

(`~` stands for the simulated home in the backup and summary lines; nothing else was cut.)

The two self-check failures: `scheduler` is the deviation above (no agent was loaded, on
purpose). `memory_load` is true at that moment on every fresh install, since nothing has loaded
yet; see the note at the end.

### File checks

| Check | Result |
|---|---|
| `~/.ownmind/.release` | `v1.33.1` |
| `~/.ownmind/runtime/current/bin/node --version` | `v22.23.4` |
| `~/.ownmind/.git` | absent (archive install) |
| `~/.claude.json` `mcpServers.ownmind` | command `~/.ownmind/runtime/current/bin/node`, args `~/.ownmind/mcp/index.js` |
| `~/.claude/settings.json` OwnMind hooks | SessionStart (startup, resume, clear, compact: `bash ~/.claude/hooks/ownmind-session-start.sh`), PreToolUse (Bash; Edit/Write/MultiEdit/NotebookEdit), UserPromptSubmit, Stop, PostToolUse (`mcp__ownmind__.*`); every node hook runs `"~/.ownmind/runtime/current/bin/node"` by full path |
| git stub marker | never created: not by the install, the MCP server, the hook or the watcher |
| `launchctl` calls | one: `list` |

### The next conversation

`claude mcp list`, real binary, the simulated HOME and clean PATH, working directory the home:

```
ownmind: ~/.ownmind/runtime/current/bin/node ~/.ownmind/mcp/index.js - ✔ Connected
```

The SessionStart hook for a new conversation (matcher `startup`), run exactly as settings.json
has it, with the clean PATH (no system node, no `timeout`): exit status 0, and the first line of
the context it hands the conversation:

```
[OwnMind v1.33.1] Memory loaded: your personal memories are now active
```

`GET /api/install/first-load?since=2026-10-23T15:35:03.588Z` with the key:
`200 {"loaded":true,"at":"2026-10-23T15:35:47.000Z"}`.

The watcher the installer started, last line of `~/.ownmind/logs/first-load-watch.log`:

```
ts=2026-10-23T15:36:01.200Z outcome=loaded since=2026-10-23T15:35:39Z locale=en
```

### Step 3: GitHub fallback

Not re-run against real GitHub: its newest tag is the previous release, so the run would test
old code. `tests/bootstrap-archive-mode.e2e.mjs`, case "server failing without a forced source
falls back to GitHub, newest tag, folder stripped", covers it against a local fixture: the
server answers 500, bootstrap prints `INFO:fallback_source:`, takes the newest tag (sorted
numerically), strips the top folder, unpacks `v1.10.0`, exits 0, and never sends the key to the
GitHub side. That file runs in the CI `install` job (it skips itself on the Windows leg, where bootstrap.ps1 has the twin case in `tests/bootstrap-archive-mode-ps1.e2e.mjs`).

### Step 4: a machine that already runs OwnMind

Second test of the same file. A second throwaway home holds copies of this developer's own
`~/.claude/settings.json` and `~/.claude.json` (read only, never printed, the real home's path
rewritten to the throwaway one), a git install of this branch's HEAD (d8bd345b) in
`~/.ownmind`, `.no-usage-scanner` set, the normal PATH (git and node present). `bash install.sh
<KEY> <URL>` against the same local server, exit status 0.

| | Before | After |
|---|---|---|
| OwnMind hook entries | 9 | 9 |
| Hook commands removed / added | | none / none |
| `mcpServers.ownmind` command, args | `node`, `~/.ownmind/mcp/index.js` | `node`, `~/.ownmind/mcp/index.js` |

Byte-identical; with a system node the MCP command stays the bare `node`. Where a machine has no
`~/.claude/settings.json` (CI), the test starts from
`tests/fixtures/zero-touch-v1.33-install-entries.json`, which is what `install.sh` at origin/main
(0dc8d4d0) writes; that branch also passed here (`OWNMIND_ACCEPTANCE_SYNTHETIC=1`). The
comparison was checked to go red: with the Stop hook removed from the starting file, the test
fails with "OwnMind hook commands changed".

### Step 2: Windows

The existing Windows e2e (`tests/bootstrap-archive-mode-ps1.e2e.mjs`, Windows leg of the CI
`install` job) already ran bootstrap.ps1 with PATH reduced to System32 and the PowerShell folder,
no git and no node, and asserted `.release` and `runtime\current\node.exe`, but with a stub
install.ps1, so nothing checked the generated settings.json. A new case in that file closes the
gap: the real install.ps1, on the zip the server's own archive builder makes from the checkout,
with nodejs.org's own Node through the server's own node-archive service, and it asserts
`.release`, `runtime\current\node.exe`, and a SessionStart hook that runs that node.exe by full
path. It was written on a Mac; its first run is the Windows CI leg after the PR is opened (run
link to be added by the controller).

### Notes for later work

- The acceptance test needs Docker. The GitHub macOS runner has none, so in CI the file is wired
  in but skips loudly; the run above, on a developer's Mac, is the evidence.
- Every fresh install's self-check prints `[FAIL] memory_load ... Fix: Re-run the installer, then
  fully restart your AI tool`, because no conversation has started yet. An AI reading the output
  could take that sentence as an instruction to re-run the installer.
