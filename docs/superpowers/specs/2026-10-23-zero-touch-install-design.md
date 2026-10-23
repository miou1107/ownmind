# Zero-touch install: paste one prompt, the AI does the rest

**Date**: 2026-10-23
**Status**: Approved by Vin 2026-10-23 (chat: "OK" after the manual and permission additions)
**Origin**: On 2026-10-22 Vin installed OwnMind for three colleagues (Frank, Emily, Morishita).
None of the three machines had git, Node.js or the Xcode command line tools. Vin had to sit at
each machine, run the missing installers by hand, re-run OwnMind's installer, and then explain
that Claude has to be fully restarted before OwnMind works. Vin's requirement on 2026-10-23,
paraphrased from his messages: the colleague pastes the install prompt and the key, and their
AI completes the whole chain by itself, installing and checking every dependency, restarting
when done, and running the verification; if something goes wrong the AI fixes it; most
colleagues who will install OwnMind have never heard of git or Node.js.

## Intent

A colleague who has never heard of git or Node.js pastes one message into their AI tool
(Claude desktop app's Code tab, or Claude Code in a terminal). From that moment until OwnMind
is loading their memories in a fresh conversation, nobody touches the machine beyond one
"allow" click: not the colleague, not Vin. The AI installs whatever is missing, repairs
whatever breaks, opens the fresh conversation itself where it can, confirms that memories
actually loaded, and the admin can see from the console that the machine is live.

## Who this is for

- **The colleague**: a non-developer. Has an AI tool installed and an OwnMind key from Vin.
  Does not have, and will never need, a package manager, a compiler or an admin password
  during this flow. Mac and Windows. May read Chinese, Japanese or English.
- **Vin (admin)**: hands out the prompt, then wants to know from his own seat whether each
  machine came up, without walking over.
- **The AI on the colleague's machine**: the only operator. Everything it needs to know must
  arrive through the prompt or through the installer's own output.

## Goals

1. One paste, on a Mac or Windows machine that has nothing but the OS and the AI tool. No
   Xcode command line tools, no Homebrew, no winget, no git, no system Node.
2. No password prompt and no GUI dialog anywhere in the flow. The only click is the AI
   tool's own "allow this command" confirmation, and the flow is shaped so it appears once.
3. When a step fails, the installer or the AI fixes it and continues. The colleague is asked
   to do something only when the machine genuinely cannot proceed (no network at all, a
   company proxy that blocks every download source) or when a permission can only be granted
   by the person at the keyboard; in the first case with one plain sentence, in the second
   with step-by-step guidance from the AI. The point of the whole design, in Vin's words: the
   colleague's AI should bother its owner as little as possible.
4. The hooks and the MCP server are live in the next conversation without anyone
   remembering to quit and reopen anything; where the AI can open that conversation itself,
   it does.
5. Something verifies that memories actually loaded in that new conversation, and both the
   colleague and the admin see the result.
6. Machines that already have git and Node keep working exactly as today. Nothing in this
   change touches the upgrade path or the generated configuration of an existing git-based
   install.

## Non-goals

- Supporting Linux desktops in the zero-touch path. Linux keeps the current behaviour
  (print the apt/dnf remedy and stop). Nobody on the team installs on Linux desktops.
- Installing git for the colleague. Non-developers do not commit code; the commit-time
  checks are simply absent on a machine without git and nobody notices.
- Replacing the git-based checkout on developer machines with the archive layout.
- A graphical installer. The entry point stays a pasted prompt.
- Codex CLI as an entry point: its default sandbox has no network, so the one-liner cannot
  run there. Codex users install from a terminal with the same one-liner. Cursor is
  supported on a best-effort basis (same scripts; no verification conversation).

## Anti-goals (what would make this a failure even if it technically works)

- The AI improvising. If the installer stops with a vague error, the AI will start
  suggesting `brew install`, `xcode-select --install` or "download Node from nodejs.org",
  which is exactly the state Vin had to rescue on 2026-10-22. Every stop must carry a
  machine-readable instruction for the AI, and the set of instructions must be closed.
- A second, third and fourth "allow" click. Every retry, fallback and fix that can live
  inside the one command lives there; the AI runs a second command only in the rare cases
  the `FIX:` grammar names.
- "Install complete" printed while memories never load. The 2026-10-22 broadcast already
  showed Emily's and Morishita's machines in that state. The success claim must come from a
  real session load, not from the installer's last line.
- Closing the colleague's application without asking. The user's own rule (an iron rule:
  before closing an application the user is working in, ask a yes/no question first) stands.
  The design therefore avoids restarting the app at all (step 5) and asks first in the one
  fallback where a restart is unavoidable.

## Facts this design rests on (checked 2026-10-23)

- The client-side `npm install` happens only in `mcp/` and its single dependency
  (`@modelcontextprotocol/sdk`) is pure JavaScript. No native build step exists on the
  client, so no compiler is needed. Adding a native dependency to `mcp/` or `hooks/` breaks
  this design.
- In the Claude desktop app every conversation in the Code tab is a separate `claude`
  process started by the app at that moment (process list on Vin's Mac, 2026-10-23: new
  processes at 13:45:15, 13:46:17, 14:51:02, 16:51:07, each with its own MCP child), and the
  OwnMind SessionStart hook ran at exactly those times (`~/.ownmind/logs/2026-10-23.jsonl`:
  `update_check` / `init` events at 13:45:15, 13:46:18, 14:51:03). Claude Code reads
  `~/.claude/settings.json` (hooks) and `~/.claude.json` (MCP) when the process starts. So a
  **new conversation** picks up a fresh install; a full application restart should not be
  required. The first acceptance run (Testing, below) confirms this on a machine that has
  never had OwnMind; until then the restart fallback in step 5 stays in the design.
- Today none of the generated host configuration uses an absolute Node path. The macOS
  SessionStart command is `bash ~/.claude/hooks/ownmind-session-start.sh`, which calls bare
  `node` about fifteen times; PreToolUse / Stop / PostToolUse and the Windows SessionStart are
  `node "<script>"`; the MCP entry is `command: "node"` on macOS and `cmd.exe /c
  mcp\start.cmd` on Windows, and `start.cmd` looks only on PATH and in winget's folder. The
  `.node-path` file is read only by the scheduled scanner wrappers. The "absolute Node"
  change in step 2 is therefore not a few lines in `install.sh`; it is listed in full there.
- `/api/version` returns the server's own `package.json` version, behind auth, and nothing
  in `src/` asks GitHub for tags; "newest release" is computed on the client with git
  (`shared/release-target.js`). `src/routes/release.js` is the task-card release check, not
  version information. The server endpoints in step 2 are new code.
- The prompt exists in three shapes today: the console copies `curl .../main/install.sh |
  bash -s -- KEY URL` (not bootstrap); the public site shows the sentence "Install OwnMind
  (my key is ..., URL is ...)"; the README shows the bootstrap one-liner. The console's copy
  is the one colleagues receive and is the canonical one; site and README follow it.
- `install.ps1` installs both git and Node through winget, but `bootstrap.ps1` stops before
  that when git is missing, so on a fresh Windows machine the winget path was never reached.
- `interactive-upgrade.sh` sweeps `~/.ownmind.bak.*` after seven days; `~/.ownmind.broken.*`
  is never swept today although bootstrap's message says it is. Step 3 fixes that message
  and the sweep together.
- `shared/auto-update.js` skips a checkout without `.git` (`no_git_dir`): an archive install
  is not damaged by it, but it is not updated by it either, so step 3 is required.
- Locale detection for the installer already exists (`hooks/lib/locale-provision.js` reads
  `LANG` / `LC_ALL` into `~/.ownmind/state/locale.json`); the `ASK:` sentences reuse it.
- The hook's memory-load record is `activity_logs` rows with `event='init'` and
  `source='hook'`, keyed by `user_id` only. The machine name arrives only with self-check
  uploads. Step 6 is designed around the account, not the machine.
- On Vin's own Mac the Code tab's `claude` runs from the Multi-Claude Switcher profile
  (`~/Library/Application Support/Claude_Profile2/...`); `open -a Claude` would open the
  default profile. Acceptance tests of the restart fallback run on a scratch account, not on
  Vin's machine.

## Constraints

- The server is Vin's own (`API_URL` in the prompt). It can serve files to the client. The
  api container has no volume in `docker-compose.yml`; a cache of Node archives needs a named
  volume, and whether the container can reach nodejs.org from the production host is
  confirmed on the host before the server work starts.
- The AI's shell on macOS is `zsh` or `bash` with `curl` and `tar`; on Windows it is
  PowerShell 5.1 or 7 with `Invoke-WebRequest` and `Expand-Archive`. Nothing else is assumed.
- Repository rules: new user-facing strings go through `hooks/locales/zh.json` first, then
  en/ja; code, comments and this document are in English. A document written for the AI to
  read starts with the line `audience: agent`. An interface change is shown as a mockup
  before it is coded.

## The flow, end to end

### 1. The prompt Vin hands out

Produced by the console's "copy install prompt" action (`client/src/utils/install-prompt.js`,
the canonical copy; `docs/site/strings.json` and the README are changed to match). New
structure (the Chinese wording is drafted later through the copy skills; the structure is
what this design fixes):

```
<one sentence: install OwnMind for me; read <API_URL>/install-manual.md first and follow it>
<one sentence: run the line below exactly once, then follow the NEXT line it prints;
 if it prints FIX, run that and run the line again; never ask me to install anything>

macOS:    curl -fsSL <API_URL>/install.sh | bash -s -- <KEY> <API_URL>
Windows:  irm <API_URL>/install.ps1 | iex   (key and URL in $env: as today)
```

Changes from today's prompt: the script comes from Vin's own server rather than
raw.githubusercontent.com (GitHub is blocked or slow on some company networks, and the
server is the thing that knows which release it is running), and the prompt tells the AI how
to behave. The server serves `install.sh` / `install.ps1` anonymously; they are the
bootstrap scripts of the release the server itself is running, which is public content and
carries no version number. `raw.githubusercontent.com` stays as the fallback inside the
script.

Decision (mine): the script endpoint is a cached copy served by the server, not a redirect
to GitHub, so a GitHub-blocked network still works.

### 2. The bootstrap decides how to install, and installs the runtime itself

`scripts/bootstrap.sh` / `.ps1` today refuse to run without git. New behaviour:

| Found on the machine | What bootstrap does |
|---|---|
| git present | Unchanged: clone, step back to the newest release tag (today this step is in `install.sh`; it stays there) |
| git absent | **Archive mode**: download the release archive, unpack into `~/.ownmind`, write `~/.ownmind/.release` containing the version |
| node >= 20 present | Use it, as today; generated configuration unchanged |
| node absent or < 20 | **Private runtime**: download the official Node LTS archive for this OS and CPU into `~/.ownmind/runtime/node-vXX.Y.Z/`, point `~/.ownmind/runtime/current` at it, and use it for everything that follows |

Download sources, tried in order, each with a retry:

1. Vin's own server, with the API key the one-liner already carries:
   `GET <API_URL>/api/install/archive` (the server's own checkout, packed once per server
   start, version = the server's version; the pack keeps `src/utils/`, which the MCP server
   and the hooks import, and drops the rest of `src/`) and `GET <API_URL>/api/install/node?os=...&arch=...`
   (fetched once from nodejs.org, checksum verified against `SHASUMS256.txt`, cached in a
   named volume). These need the key because the archive reveals the server's version, which
   `/api/version` deliberately hides from anonymous scanners. They get their own rate limit
   and are exempt from `apiLimiter`'s per-minute cap. The reverse proxy's body-size and
   timeout limits are checked on the host for the 40 to 50 MB Node archive.
2. GitHub `codeload` for the OwnMind archive (newest tag) and `nodejs.org/dist` for Node,
   with the checksum check. This is also the path if the production container turns out to
   have no outbound access.

Decision (mine): archive machines follow the **server's** version, not GitHub's newest tag.
Git machines keep following GitHub's newest tag as today. The two can differ only between a
tag and the matching server deploy, the same window in which today's git machines already
show "client ahead of server".

Both scripts stay runnable with nothing but the OS shell. The Node download on macOS is a
`.tar.gz` (`tar` is built in); on Windows it is the `.zip` (`Expand-Archive`). Private Node
is a plain directory under the user's home: no admin rights, no PATH edits, no dialogs.

**Making the private runtime reachable** (only on machines that got one; machines with a
system Node are untouched, which keeps goal 6 and leaves nvm users alone):

- `hooks/ownmind-session-start.sh`, `mcp/start.cmd` and every other shell or cmd entry point
  gain one line at the top: if `~/.ownmind/runtime/current` exists, prepend its `bin` to
  PATH. The fifteen bare `node` calls inside need no change.
- Configuration entries that invoke `node "<script>"` directly (PreToolUse, Stop,
  PostToolUse, Windows SessionStart, the macOS MCP entry) are written with the absolute path
  of the private Node. `session-hook-command.cjs`, `ensure-pretooluse-hooks.cjs`,
  `add-stop-hook.cjs`, `add-post-tool-use-hook.cjs` and their "is this command ours"
  matchers (`isGeneratedCommand` / `needsRewrite`) accept both the bare and the absolute
  form, so an upgrade does not rewrite a working entry into the other shape.
- `install-artifacts.cjs` and `self-check.cjs` run the Node named in the configuration, not
  the one on PATH, when checking.

### 3. Upgrades for archive installs

A machine without git must still receive every automatic update. The existing update paths
(`shared/auto-update.js` at session start, `scripts/interactive-upgrade.sh/.ps1`,
`scripts/install-helpers/update-to-release.mjs`, `scripts/check-sync.sh/.ps1`) branch on
`~/.ownmind/.git` versus `~/.ownmind/.release`:

- **Is there a newer release?** Archive mode compares `.release` with the release the server
  ships (`HEAD /api/install/archive`, header `X-OwnMind-Release`).
- **Apply it, code only**: the release is staged in `~/.ownmind/.next/` (unpacked, `npm install`
  in its `mcp/`, the root dependencies), then each top-level entry of `.next/` is swapped in
  with a journal: the live entry moves to `~/.ownmind/.prev/`, the staged one takes its place,
  `.release` last. `runtime/` and every other piece of runtime state (`credentials`, `cache/`,
  `state/`, `logs/`, markers) are never renamed, copied or deleted, so a Windows machine running
  its private `node.exe` from `runtime/` can still update; a release that would collide with
  one of them is refused before any rename. A swap stopped by a held file is resumed from the
  journal by the next run, never rolled back; `.prev/` is the previous code for a person to fall
  back on. The seven-day sweep covers `.bak.*`, `.broken.*` and `.prev`, which also makes
  bootstrap's existing message true.
- `check-sync`'s `L1_REMOTE` line reports `release=vX.Y.Z` instead of `not_git` on these
  machines, so the upgrade skill and the console do not flag a healthy archive install as
  broken.

Decided 2026-10-23: the swap renames code entries one at a time. On Windows a running MCP
server can still hold a file in `mcp/`; that entry's rename fails, the journal stays, and the
next update continues from it.

### 4. Every stop is an instruction for the AI, not a question for the human

The installer's output already uses `INFO:` / `OK:` / `ERROR:` prefixes. Everything that can
be retried or re-routed (second download source, partial-download cleanup, npm registry
retry) happens inside the one command, so the common case is exactly one "allow" click. Two
additions for what remains:

- `FIX:<code>:<command>` after an `ERROR:` line: a command the AI may run itself and then
  re-run the installer. The set of codes is finite and listed in the AI-facing runbook
  (`docs/ai-install-runbook.md`, English, first line `audience: agent`; its content is also
  the install section of the `ownmind-upgrade` skill). Examples: `FIX:clear_partial:rm -rf
  ~/.ownmind.partial`, `FIX:use_fallback_source:OWNMIND_SOURCE=github bash ...`.
- `ASK:<code>:<sentence for the user>` only for the cases the machine cannot solve: no
  network at all, every download source blocked, disk full. The sentence is already in the
  user's language (zh/ja/en from the OS locale, falling back to en), so the AI relays it.

**The manual the AI reads first** (Vin's suggestion, 2026-10-23: give the colleague's AI a
manual covering what gets installed, how to fix problems, what "installed" means and how to
test the whole thing). The prompt's first line points the AI at
`<API_URL>/install-manual.md` (served by Vin's server, anonymous, English, first line
`audience: agent`; the same file is `docs/ai-install-runbook.md` in the repository and the
install section of the `ownmind-upgrade` skill). The installer also prints the manual's
essential lines (`FIX:`, `ASK:`, `NEXT:`) itself, because an AI that skipped the reading
must still end up in the right place. The manual has five sections:

1. What will be installed and where (`~/.ownmind`, private Node, which host config files
   are written), so the AI can answer the colleague's "what did you just do to my computer".
2. The one-liner and the output grammar (`INFO:` / `OK:` / `ERROR:` / `FIX:` / `ASK:` /
   `NEXT:`), with the closed list of `FIX:` codes and what each one does.
3. Troubleshooting: the known failure shapes (download blocked, partial download, npm
   registry unreachable, a stale `~/.ownmind` from an earlier attempt) and the exact action
   for each; the four things the AI must never suggest.
   A separate subsection covers **permissions**, because several of the 2026-10-22 installs
   stalled there (Vin, 2026-10-23: some people hit permission problems; when the AI needs
   more permission it must walk its owner through granting it). The manual lists each
   permission the flow can run into and the exact words and clicks the AI gives the owner,
   in the owner's language, one step at a time with the button names as they appear on
   screen: the AI tool's own "allow this command" prompt (which button, and how to switch
   the conversation to a mode that stops asking if it keeps asking); the AI tool being in a
   read-only or plan mode that forbids running commands; Windows PowerShell refusing scripts
   (the one-liner already passes the bypass flag, the manual says what to do when a company
   policy overrides it); macOS refusing a folder (the install uses only the home folder, so
   the manual says what it means when even that is refused); a company-managed machine
   whose user is not an administrator (nothing in the flow needs one, so the AI says so and
   continues). Asking for a permission is the one kind of question the AI is allowed to put
   to its owner during the install, and each time it says what the permission is for and what
   the owner will see after granting it.
4. Definition of done: the files that must exist, the self-check result line, and the
   activity row the server must have received.
5. The functional test the verification session runs: the OwnMind context appeared at
   session start; `ownmind_search` answers; the status button in the input bar is green;
   one memory saved and found again. It reports pass or fail per item in one line each.

The runbook rules for the AI:

1. Read the manual, then run the one-liner. Read every line of output.
2. On `ERROR:` followed by `FIX:`, run the fix, re-run the one-liner. Up to three rounds.
3. On `ASK:`, say the sentence to the user and stop.
4. Never suggest installing git, Node, Homebrew, Xcode tools or winget. The installer
   handles the runtime; a machine on which it could not is an `ASK:` case, not a chore for
   the user.
4a. When the AI tool or the operating system refuses something the install needs, follow the
   permissions subsection of the manual: tell the owner which permission, why, which button
   or setting, in their language, one step at a time, then continue. Do not stop at "I do not
   have permission".
5. On `NEXT:verify:<how>`: do what step 5 says for this environment.
6. Report in the user's language, three sentences at most: it is installed, what happens
   next, what the user should do (usually nothing).
7. In the verification session, run the functional test from section 5 of the manual and
   report pass or fail per item.

### 5. The next conversation, opened by the AI where it can

No application is closed. The installer looks at its own environment and prints one
`NEXT:` line:

| Environment | `NEXT:` line | What the AI does |
|---|---|---|
| Claude desktop app, Code tab (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_CODE_DESKTOP_APP_VERSION` set) | `verify:new-session` | Tells the user OwnMind is installed and that a verification conversation is about to open. Then starts a new session through the desktop app's own session tool, titled for the verification, whose brief is: confirm the OwnMind context appeared at your start and say so to the user in one sentence. That session is a new `claude` process, so it runs with the new hooks and MCP. |
| Claude Code in a terminal | `verify:manual:<sentence>` | Says the one sentence: type `/exit`, run `claude` again, and OwnMind loads in that session. |
| Anything else | `verify:manual:<sentence>` | Generic sentence: open a new conversation in this tool. |

**Fallback, only if the acceptance run proves a new conversation is not enough on the
desktop app**: `NEXT:restart:claude-desktop`. The AI asks one yes/no question ("installed;
may I restart this app now?"), and on yes runs a detached helper
(`scripts/install-helpers/restart-host.sh` / `.ps1`) that waits five seconds, quits the app
(macOS `osascript -e 'quit app "Claude"'`; Windows `CloseMainWindow` then `Stop-Process`
after 20 s), waits for the process to exit and relaunches the same executable the installer's
parent process was running (not a fixed `open -a Claude`, because of profile-switched
machines). The helper logs to `~/.ownmind/logs/restart-<timestamp>.log`.

### 6. Verification, visible to both sides

The installer also starts a small detached watcher (same helper family, no restart) that
polls the server for up to ten minutes: `GET /api/install/first-load?since=<install
timestamp>` answers whether **this account** has an `event='init', source='hook'` activity
row newer than the install. Then:

- **Loaded**: a native notification (macOS `osascript display notification`, Windows toast
  via PowerShell) in the user's language: OwnMind is working, memories loaded. Exit.
- **Not loaded after ten minutes**: a notification saying to open a new conversation, and if
  it still does not load, to paste the repair phrase to the AI. The self-check on the server
  already raises the "memories have never loaded automatically" notice for the admin.

Decision (mine): per account, not per machine. Each colleague has one machine; the install
timestamp disambiguates. The machine name shown in the console comes from that account's
latest self-check upload, best effort.

Console: the team page (`client/src/pages/Admin/TeamPage.jsx`) gets one column, "last memory
load" (locale key; Chinese label through the copy skills), showing the time of the member's
last `init` activity row and the machine name from the latest self-check, with the console's
green / yellow / red lights (green: loaded within the last day; yellow: installed but never
loaded; red: install reported an error and nothing loaded since). Shown to Vin as a mockup
before it is coded.

### 7. What the colleague experiences

Emily opens the Claude desktop app, pastes Vin's message, presses Enter, clicks "allow" once
when the app asks whether the command may run. The AI narrates a few steps for about two
minutes. The AI says OwnMind is installed and a verification conversation is opening. A new
session appears in the sidebar; its first lines show her memories loading and it says so. A
desktop notification says OwnMind is working. Vin, at his desk, sees Emily's row on the team
page turn green.

If her company network blocks GitHub, she sees nothing different: the download came from
Vin's server. If her network blocks everything, the AI says one sentence: the installer could
not reach Vin's server, please tell Vin. That is the only sentence in the flow that asks her
to do anything.

## What exists today and changes

| Piece | Today | After |
|---|---|---|
| `client/src/utils/install-prompt.js` (canonical), `docs/site/strings.json`, README | Three different shapes; points at raw.githubusercontent.com; nothing about the AI's behaviour | One shape, points at the server, carries the behaviour rules |
| `scripts/bootstrap.sh/.ps1` | Exit if no git | Archive mode; private Node; `NEXT:` line; starts the watcher |
| `install.sh/.ps1` | Node: brew or stop (mac), winget for git and Node (win, unreachable without git) | Private Node when none present; configuration written with the absolute Node path only in that case |
| `hooks/ownmind-session-start.sh`, `mcp/start.cmd`, other shell entry points | bare `node` | PATH prepend when `runtime/current` exists |
| `session-hook-command.cjs`, `ensure-pretooluse-hooks.cjs`, `add-stop-hook.cjs`, `add-post-tool-use-hook.cjs` | one command shape | accept bare and absolute Node |
| `scripts/install-helpers/preflight.sh/.ps1` | Fail on missing git/node | Missing git is not a failure; missing node means "install private runtime" |
| `update-to-release.mjs`, `interactive-upgrade.*`, `check-sync.*`, `shared/auto-update.js` | git only | Archive branch; sweep covers `.broken.*` and `.prev` |
| New `src/routes/install.js` | none | `install.sh` / `install.ps1` (anonymous), `archive`, `node`, `first-load` (key); own rate limit; Node cache volume in `docker-compose.yml` |
| New `restart-host.sh/.ps1` (fallback) and the watcher | none | Notify; restart only after a yes |
| `self-check.cjs`, `install-artifacts.cjs` | Assume node on PATH | Check the configured Node |
| `skills/ownmind-upgrade.md`, new `docs/ai-install-runbook.md` (served as `/install-manual.md`) | Bootstrap instructions | The five-section manual: what is installed, output grammar, troubleshooting, definition of done, functional test |
| TeamPage | No per-member load status | One column with the light (mockup first) |
| `hooks/locales/*.json` | none | ASK sentences, the verification sentence, the two notifications |

## Testing the design, not just the code

- **First task of the plan, before any code**: on a scratch macOS account that has never had
  OwnMind, install with today's scripts by hand, then open a new conversation in the Claude
  desktop app without restarting it. If memories load, step 5 stands as written and the
  restart fallback is not built. If they do not, the fallback is built and the yes/no
  question is part of the flow.
- A fresh macOS account with the Xcode tools absent and a Windows 11 VM with no winget
  access: paste the prompt into the Claude desktop app, click "allow" once, and do not touch
  the keyboard until the notification arrives. Run by Vin or by me on a scratch account, not
  by a colleague.
- The existing test suite covers the git path; the archive path gets its own tests for:
  release detection without git, the directory swap with files held open, the Node path in
  every generated host config (parsed back with a real JSON parser) for both the bare and the
  absolute shape, the matchers accepting both shapes, and the `FIX:`/`ASK:`/`NEXT:` grammar.
- Deliberately break the first download source once and confirm the second source is used
  and no `FIX:` line is needed (a check is trusted only after it has been seen to fail).

## Left to the builder

- Exact file layout under `~/.ownmind/runtime/` and how `current` is switched on a Node
  upgrade.
- Which Node LTS line to pin (the newest even-numbered LTS at build time) and how the server
  learns the current one.
- Whether the archive the server serves is packed at server start or on first request.
- The order of the plan after the first task: private Node and archive mode (they remove the
  2026-10-22 failures), then the verification conversation and watcher, then the console
  column.
