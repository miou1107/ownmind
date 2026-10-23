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
