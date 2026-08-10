Personalized persistent memory for AI

[English](README.md) | [繁體中文](docs/README.zh-TW.md) | [日本語](docs/README.ja.md)

**Current version: v1.26.129** · see [CHANGELOG](CHANGELOG.md) for details

# OwnMind — Cross-platform AI Memory & Iron-Rule Enforcement System

Stop letting AI forget your preferences and repeat the same dumb mistakes. Whether you use Claude Code (Claude's CLI), Codex (OpenAI's CLI), Cursor (AI editor), Gemini CLI (Google's CLI), or any online AI, OwnMind locks in your development preferences, project context, and unbreakable "iron rules" across every tool, machine, and AI model.

---

## Who Is OwnMind For?

### 👤 Solo Developer — Set preferences once, they follow you everywhere

The "commit messages must be in Traditional Chinese" rule you set on your work laptop? It still applies when you open a new conversation on your home machine, on a borrowed laptop on a business trip, anywhere. **Your dev persona doesn't reset when your environment changes.**

### 🔁 Multi-Tool User — Same rules across Claude / Cursor / Codex / Copilot

Backend in Claude Code in the morning, frontend in Cursor in the afternoon, scripts in Codex CLI at night. Every tool auto-loads the same personal preferences and iron rules — **no need to re-teach each one**. Add a new editor next month (OpenCode, Windsurf, whatever) and it inherits everything as soon as it connects to OwnMind.

### 👥 Team Lead — Push standards once, dashboard shows real compliance

Publish a team rule in the admin console (e.g., "PRs must include tests") and every team member's AI auto-loads it. Local pre-commit hooks (small programs that intercept `git commit` to inspect changes) block non-compliant code before it can be committed. The admin dashboard (data dashboard: web page showing data as charts) shows real per-rule, per-member compliance rates, the team's most-hit pitfalls, and who uses `OWNMIND_BYPASS` (rule-bypass env var) the most — **manage your team with data, not gut feel.**

### 🛡️ Security-Conscious Engineer — Sensitive data never leaks through AI

- Trying to commit passwords/API keys (credentials for calling online services) → pre-commit hook blocks via pattern match (new in v1.19.7)
- AI tries to write a password into memory → memory API rejects with HTTP 400 and routes to the encrypted vault
- AI reply accidentally includes the user's national ID / email / mobile → reply-lint (reply quality linter: auto-scans AI responses for rule violations) emits a `privacy_check` event; whether to block is decided by each user's own iron rule (new detector in v1.19.7, neutralized in v1.19.10)

Especially useful in finance, healthcare, legal, and other sensitive industries.

---

## Before vs After Installing OwnMind

AI is powerful but **has no long-term memory by design**, and different models (e.g., Anthropic's Claude vs Google's Gemini) interpret rules differently. Add multiple machines into the mix and the friction multiplies. Here are five typical pain points before and after:

### Pain Point 1: Re-explaining preferences in every new conversation

- **The block was right and the name on it was wrong, so the user was sent after a key they never had** — Anthropic and OpenAI both prefix API keys with `sk-`, and one regex named `openai_api_key` owned the whole family. Seen in the wild while committing v1.26.124, when that release's own new baseline scan blocked the release: `value 符合 openai_api_key 格式 (detected_by=regex:openai_api_key) matched="sk-ant-a…AAAA"` — the masked fragment says `sk-ant-` and the rule name says OpenAI, in one sentence. Stopping the commit is half the job; the half the user acts on is the name, and this is the same failure v1.26.28 fixed by adding `matched_text` after a hidden match got bug id=6 misdiagnosed. Anthropic keys now match their own rule, listed before OpenAI's because the loop returns on first match — and the OpenAI pattern independently refuses `ant-`, so neither a reorder nor an edit to one pattern can quietly hand them back to the wrong vendor. The exclusion is the four characters `ant-` rather than the letters `ant`, so `sk-antelope…` is still OpenAI; a `(?!ant)` there would misfile it in the direction nobody notices, because a user with no Anthropic key has nothing to fail to find. Every existing assertion on `regex:openai_api_key` was checked first and uses `sk-proj-…`, which is genuinely OpenAI, so the rename splits the family without moving anyone's ground. The new fixtures are assembled at runtime and carry a comment saying not to tidy them into single literals — a literal key makes its own test file un-committable by the scanner it tests, which is precisely what happened to `pre-commit-secret-baseline.test.js` one release earlier `v1.26.125`
- **Two of the four defence lines had never blocked anything, for one shared reason** — verifying install, config, telemetry, iron-rule triggering and updating on a real Windows machine, by running them rather than reading their tests. A scratch repository staging a well-formed AWS key and an Anthropic key committed cleanly: no output, exit 0. A chained probe hook proved the wrapper and the hook both ran, so nothing was misconfigured — the secret scan simply sat inside the per-rule loop, behind `isSecretGuardRule`, below two exits that fire whenever the user owns no machine-verifiable commit rule. All three of this account's iron rules are reminder-only, which is the **default state of a new account**, so both exits fired and the advertised commit hard-block was inert for everyone who had never hand-authored a verification block. The scan now runs before every rule exit, because a leaked credential is not a preference; the rule-driven path is unchanged and stands the baseline down so one leak is never printed twice, and `OWNMIND_BYPASS=all` still releases it with an audit row — the one check nothing can turn off forces `--no-verify`, which disables everything at once and records nothing. The same root cause disabled the reply lint: `iron_rules.json` was built as "the verifiable rules" and v1.21.0 pointed a second consumer at it looking for `lint_validator`, without widening the filter, so a rule carrying only a validator was fetched and dropped on the way to disk. Measured: a two-byte cache, zero validators resolved, and "no violations" reported for a reply the engine scores at 79.3% mixed language — indistinguishable from a clean one. The predicate now lives in `shared/cacheable-rules.js` and both writers of that file share it; the global default that a user who configured nothing is linted on nothing is **deliberately left alone**, because v1.26.13 set it for a reason. Three more, from the same session: the Node hooks computed "today" in UTC while both shell hooks and the MCP used the local date, so on a UTC+8 machine the two registered SessionStart hooks spent every midnight-to-08:00 window overturning each other's update marker and splitting the day's log across two files — reproducible only where local ≠ UTC, which is never CI; `install.sh` had no `msys*` branch at all, so every Windows install through `bootstrap.sh` scheduled no usage scanner and printed one warning line, the exact death its own neighbouring comment describes; and the self-check credited that missing schedule as `[ OK ]` because `Get-ScheduledTask` is machine-global and it found the task belonging to a different installation — meaning any machine that ever ran OwnMind would pass that check forever `v1.26.124`
- **On a half-installed machine the iron-rule check was not running at all, and said nothing** — the shell hook reads the API key out of `~/.claude/settings.json` by splicing the path into `node -e` source. That is safe only while `to_win_path` returns `cygpath -m` output with forward slashes — and it silently is not whenever `path-helpers.sh` is missing, because the fallback hands back whatever `$HOME` held. On Windows that is a backslash path, so `C:\Users\...` reached the JS parser as escape sequences, the read threw, the catch printed an empty key, and the hook exited 0 without a word. Same class as v1.26.94 and v1.26.112, and the `2>/dev/null` wrapped around it is the red flag the user's own iron rule names: it turns a failure into silence. The path is now passed as **argv**, which is immune to backslashes, spaces and apostrophes alike — the shape `path-helpers.sh`'s own header recommended and nothing here had adopted — and the credential read no longer discards its stderr. **The change that mattered most was to the test**: it threw the hook's stderr away and its failure message was a guess ("the command was not extracted"), which is exactly what a reader then spends an afternoon disproving. A boolean `reached: false` looks identical for a payload that would not parse, a guard higher up that exited first, and a crash — and all three write different stderr. With exit code, stdout and stderr attached, the real cause took two minutes. Two more rulers went with it: `chmod 0o500` cannot make a directory unwritable on NTFS, so the "degradation is announced" test never produced the degradation it was checking for (a regular file standing where the directory belongs fails on every platform, and now does), and a bare `rmSync` in a `finally` threw EPERM on a temp directory the hook's own update child still held open — failing the test **after its assertions had passed**, under a name that had nothing to do with it `v1.26.120`
- **Chasing red Windows tests turned up a real one: memory files had never been written there** — the ticket was a list of assertions that only fail on Windows, all of them assumed to be broken rulers. One was not. `projectSlugFromPath` replaced the slashes in a project path and nothing else, and a Windows project path begins `C:\` — a colon cannot appear in a directory name there at all, because NTFS reads it as the alternate-data-stream separator. So `mkdir` failed — measured on the machine as ENOENT, Windows collapsing yet another shape into that one errno — the write was swallowed, and the SessionStart hook **never wrote a single memory file on Windows**. The caller's own comment, added in v1.26.83, says it exists to stop precisely that ("without it the AI reads whatever snapshot was last written, which on Windows was never") — that release fixed every part of the path except the one line that builds the directory name. The slug now drops the colon too, producing `C--Users-Vin-X`, which is also the spelling Claude Code uses for its own project directories, so the files land where the AI already looks. The rest of the batch really were rulers: repo-relative paths compared against POSIX literals (`src\app.js` vs `src/app.js` — the right file found, the wrong separator compared), a fake home spelled `/abs/path` that `path.join` turns into backslashes while the property under test, an absolute path rather than a bare filename, held all along, and a comment claiming a regular-file-as-directory gives ENOTDIR "on every platform, including Windows" — measured there, it gives ENOENT, as do illegal characters, reserved device names and over-long paths, so the operating system's own answer is "absent" and the product was right. That last rule — only ENOENT means not installed — is now assertable with an injected error instead of a conjured OS one, so it holds on every platform rather than only where the errno can be produced `v1.26.119`
- **An assertion that cannot pass on Windows, about two files that are fine** — `chmod` is a no-op on NTFS: measured on the machine this was fixed on, a file set to 755 reads back as 666. So `statSync(f).mode & 0o100` reported `scripts/bootstrap.sh` and `scripts/run-migrations.sh` broken there regardless of their real state — the ruler was wrong, not the product. Skipping the assertion on Windows would have been the worse repair, leaving that platform with no answer at all, which is the shape of every defect in this list that survived for months. It now asks the **git index** instead — `100755` — which is the better question on every platform anyway: the local bit says what one machine happens to have right now, while the index mode decides what everybody who clones will get, and a script committed as `100644` is unrunnable for all of them whatever the author's working copy says. The POSIX bit is still asserted where it means something. One case has no index to ask — a fresh copy in a temp directory, made by the installer's hook-copying function — so on Windows it asserts the half that is answerable there, that the function asks for the bit, and keeps the real observation where it can be made. The new helper carries its own reverse control: a file committed as `100644` must fail it, or "passes on Windows" and "passes on anything" are the same test `v1.26.118`
- **The self-check confirmed the MCP server was registered, never that it starts** — `mcp_registered` (v1.26.112) reads `~/.claude.json` and confirms an `mcpServers.ownmind` entry is there, which is exactly what that release needed: on the machine that prompted it, the key was absent entirely. What it cannot see is the entry that is present and does not start — and this repository has broken that stretch four separate times, each leaving a registration that reads perfectly: a `cygpath -w` path interpolated into `node -e` source, where the JS parser ate the backslashes `v1.26.94`; PowerShell 5.1 stripping the double quotes off that same source, while its own parser pronounced the result flawless `v1.26.112`; Git Bash rewriting cmd.exe's `/c` into `C:/` and that rewritten form reaching the launch command `v1.26.112`; and `start.cmd`'s node-not-found ladder, whose failure is a file in the error spool rather than a wrong entry in the config `v1.17.77/79`. A new `mcp_launches` check does what Claude Code does at the start of a session: takes the `command`, `args` and `env` **exactly as written in that file**, spawns it, completes the JSON-RPC handshake and counts the `ownmind_*` tools — 693ms warm on the machine it was built on. Reconstructing the command from what the installer intended would test the intention; the line on disk is the thing that has been wrong four times. **It fails open on purpose**: a timeout means *cannot tell*, never *broken*, because a cold or loaded machine can exceed any budget while being healthy and self-check runs at the end of an install, the busiest moment there is — v1.26.106 already uploaded one fabricated FAIL from a check that read slow as broken. That is the opposite of `lock_age_seconds` (v1.26.113), and the difference is what the answer is for: that one gates an *action*, where a bad reading corrupts something, while this one is a *diagnosis*, where a bad reading accuses a machine that is fine. Splitting them keeps the cheap certainty — `mcp_registered` stays a pure file read that always has an answer. One consequence had to be closed off as well: the server sends a heartbeat when it starts, and `collector-silence` reads that heartbeat to decide a machine has gone quiet, so a check that starts a server daily and unattended would keep vouching for a machine nobody is using — a check that quietly vouches for the thing it is checking is worse than no check. The diagnostic start is now marked, and the heartbeat skipped. Every test runs on any platform against a fake server in a temp directory, which is the point: all four defects above survived because every test that could reach them needed a working Windows machine `v1.26.117`
- **A test run that hangs says nothing about what it is stuck on** — the day after CI landed, the macOS leg on `main` printed its last line 20 seconds into the suite and then went silent for twenty minutes, until the job's own limit ended it. GitHub records that as `cancelled`, which reads like somebody pressed a button. A re-run of the same commit passed in 74 seconds, so nothing was left to look at; the same thing had happened earlier that day on another commit and was never even noticed, because a newer push cut it short. `node --test` has no deadline of its own, and it reports files in dispatch order, so one file that never finishes silences every file behind it too. The runner now carries `--test-timeout=300000`: five minutes against a suite that takes 30s on ubuntu and 47s on macOS, so nothing legitimate is near it, and anything that exceeds it is named in the report and turns the job red in minutes instead of quiet for twenty. **This does not fix the hang** — it did not reproduce in five full-suite runs locally or in 120 runs of the file the stall points at, and the one occurrence with a full log passed on re-run. It makes the next occurrence produce a name. The net also has a hole, measured rather than assumed: on node 20 a test that never settles fails on its own and a file that leaks a handle is caught, while on node 24 it is the other way round and the leaked handle stays unbounded `v1.26.114`
- **A stub `stat` cannot ask this machine whether the helper works here** — v1.26.111 pinned the dialect handling with a stubbed `stat` on `PATH`, which is the important property and the reason those tests exist. Four things stayed out of their reach, and each was a way the defect hid or could return. A stub only ever answers the dialect the test chose, so nothing asked *this* machine — which is exactly the question answered "no" on Linux for nine releases while every suite was green on macOS. The stub tests also call the helper directly, so nothing covered the consequence that actually bit users: `acquire_update_lock` reading an empty age as "cannot tell" and skipping its entire staleness branch, meaning a lock left by a killed run was never reclaimed. A future change could break the age again with no caller exercised. Third, the helper returned non-zero **silently** when neither form worked — and silence is precisely how this survived nine releases, with two `2>/dev/null` covering the complaint and nothing at any layer saying a word; it now names the file and both attempted forms on stderr, with callers still failing closed and the dialect logic untouched. And fourth, the routine case — the file simply not being there, which is every session, since `acquire_update_lock` asks for the age of an absent `.reclaim` marker each time — must stay silent, or that diagnostic becomes startup noise for everybody. Reverting the helper turns three of the four red; the fourth is green either way by design, because it guards against over-correcting `v1.26.113`
- **The MCP server was never registered in the file Claude Code reads** — Claude Code launches MCP servers from `~/.claude.json`; every installer wrote `~/.claude/settings.json` and nothing else. So the `ownmind_*` tools did not exist in anybody's session — not broken, not degraded, never registered. It hid because **the visible half worked**: the SessionStart hook is configured in `settings.json`, which Claude Code does read for hooks, and it makes its own HTTP call, so memory appeared in context and nobody asked where the other half was. Measured 2026-08-09: a complete, correct `mcpServers.ownmind` block in `settings.json`, no `mcpServers` key at all in `.claude.json`, no `ownmind_*` tool in the session — while `node ~/.ownmind/mcp/index.js` answered `initialize` perfectly by hand. The repository half-knew: `resolve-credentials.cjs` searches both files and the v1.26.93/94 notes call `~/.claude.json` "the file nothing writes", but nobody finished the sentence — nothing writes it, so nothing is registered. **The updaters were the harder half**: nobody re-runs an installer, the auto-update path is `git pull` → `npm install` → `update.sh`, so an install-only fix would have let this release claim the repair while every existing machine stayed exactly as broken — the same trap v1.26.104 fell into with the git-hook wrappers. Implementing it reproduced the bug twice more in miniature, both caught by the same question the original defect never asked, *which file?*: the helper defaulted to `os.homedir()` (Windows `USERPROFILE`) while the installer used bash `$HOME`, and an updater read credentials from one home while writing another. Both wrote correctly, read back correctly, and reported success — somewhere nobody was looking. The home directory is now an explicit argument that rejects a non-absolute or POSIX-on-Windows path, and a new `mcp_registered` self-check asks the file itself, because `mcp_files` and `mcp_node_modules` were both green on a machine where the tools did not exist `v1.26.112`
- **`stat -f` is a format string on BSD and `--file-system` on GNU, so the update lock could not tell how old it was on Linux** — CI's first day found it. The session hook computed a file's age with `stat -f %m … || stat -c %Y …`, assuming the first form would fail quietly. On Linux it prints a five-line filesystem report to **stdout** and only then exits non-zero, so the `||` appends the correct epoch underneath it and the arithmetic on the next line dies. The comment on the line above already named the difference between the two platforms; the code below it assumed one of them would be silent, and `2>/dev/null` only ever covered stderr. Each form is tried separately now and the result checked for digits. Tested with a stub `stat` on PATH so it runs on macOS too — the point being that this is a defect a macOS developer cannot otherwise see; confirmed in an alpine container, and the whole suite passes on Linux node 20 and node 24. **The mirror image of the Windows releases above**: developed on a Mac, broken somewhere else. Fixing it also made the stale-lock takeover reachable on Linux for the first time, which exposed a race that had been sitting in it: clearing a marker left behind by a killed reclaimer moved it aside without checking that what moved was the stale marker it had measured, so a fresh one created in between could be taken instead and two processes ended up updating at once. Closed in both implementations, with the reverse check on each. **One window remains and is written down rather than papered over** — with eight hooks contending, one test still fails once or twice in sixty runs on a single CPU; tracing it shows four processes becoming reclaimer in turn, each of them by the rules, which is the protocol's shape rather than that window, and the protocol already says delete-and-recreate cannot be made atomic `v1.26.111`
- **This repository now has CI, and on its first day it found three tests that had never run anywhere** — before this, `.github/` held a `CODEOWNERS` file and nothing else, so tests ran only where somebody ran them, which in practice was one macOS machine. **On a Mac, a test that only breaks on Windows is not a failing test — it is an invisible one**, and that is how the whole previous release's worth of defects survived. The workflow gates on ubuntu × node 20, ubuntu × node 24 and macOS × node 20; Windows runs and reports but does not block, because users pull updates straight from `main` and merging is shipping — 109 pre-existing Windows failures cannot hold a release hostage. It is a separate job rather than a `continue-on-error` matrix leg: such a leg still reports `failure` in `needs.<job>.result`, so a gate reading that value cannot tell "only Windows is red" from "everything is red". What it caught immediately: `install-failed-beacon-ps1` **had never passed anywhere** — its harness extracted `function Fail` alone while `Fail` interpolates a helper defined further down the file, so PowerShell threw while building the arguments, before reaching the call being tested, and `Fail`'s own `catch { }` swallowed it; and it only looked for `pwsh`, which macOS lacks and Windows calls `powershell`, so it was skipped on both — **and a skip looks exactly like a pass in the summary**. Two `scanner-schedule-repair` cases called `plutil`, which is macOS-only, so "macOS: …" meant "nowhere". Both now assert the generated XML directly and use the platform tool as cross-checking when it exists.`v1.26.107`
- **Four defects that only break on Windows, and that a Mac cannot see** — this repository has no CI: `.github/` holds a `CODEOWNERS` file and nothing else, so tests run only where somebody runs them, and a Windows-only path is either skipped on a Mac or never reached. A test that is green on macOS is not a passing test to the person on macOS — it is an invisible one. **(1)** The diagnostic log uploaded to the server was mojibake carrying 148 NUL bytes: `install.ps1` wrote it through `Tee-Object -FilePath`, and Windows PowerShell 5.1's `Tee-Object` has no `-Encoding` parameter at all — it was added in PS 6 — so it always writes UTF-16LE, while `self-check.cjs` read it as UTF-8. Every `register-task-*.log` on the affected machine began `fffe`, the oldest dated 2026-05-09. This is the raw material of the v1.17.83 incident: one NUL makes Postgres reject the whole JSONB document, the INSERT fails, and the client's retry spool resends the same row forever. That was fixed on the server by stripping before INSERT; this is the other half. The file now decodes **by BOM rather than by assumption**, and the first fix for it was itself wrong in a way a test caught — `JSON.stringify` turns a NUL into an escape sequence, so searching the serialized text for a raw NUL found nothing and reported success, while what Postgres objects to is precisely that escape sequence. **(2)** The scheduler check uploaded a fabricated FAIL: `Get-ScheduledTask` is a CIM cmdlet that must autoload its module and open a CIM session, measured at ~1.5s on an idle Windows 10 against a 5s budget — three times the headroom, except self-check runs at the one moment the machine is busiest, right after an install or upgrade. Reproduced verbatim by lowering the timeout to 600ms. `launchctl list` takes about 20ms, so the same constant was 250× headroom on macOS; it was never sized for this call. Underneath it, `safeSpawn` returned `killed`/`signal` and the caller kept only `error`, so a timeout was reported to the user as "Requires Windows + PowerShell" — on a machine that visibly has both. **(3)** Four test files were not testing anything on Windows: `new URL(...).pathname` yields `/C:/Users/...` there, which node joins onto the current drive root, so `install-artifacts.test.js` died with `MODULE_NOT_FOUND: C:\C:\Users\...` **before its first assertion** and three others raised ENOENT. On macOS that same pathname happens to be a valid path, so all four were green. **(4)** The one test that actually executes the Git Bash detector could not pass on any platform — it spawned PowerShell without `-ExecutionPolicy Bypass`, and a Windows client that has never set a policy defaults to Restricted, which blocks dot-sourcing a `.ps1`; macOS has no PowerShell, so the whole block was skipped. Every shipping caller passes that flag; only the test did not. Fixing it exposed a second layer: the `.cmd` stub did not escape cmd.exe metacharacters, and a real `bash --version` ends its third line with `<http://gnu.org/licenses/gpl.html>`, which cmd reads as input redirection — so both Git Bash cases were rejected and the test accused a detector that was fine. **Both new test files run anywhere**, which is the point: these survived because every test that could reach them needed a working Windows machine. Review then found the guard had the same blind spot it was written to remove — it scanned `tests/` only, while the same bare `.pathname` was live in a shipping hook, the commit-message hook added one release earlier; on Windows its own imports could not resolve, and that hook exits 0 on any error by design, so **every commit-message rule was silently unenforced there**. It now scans `hooks/`, `mcp/`, `scripts/`, `shared/` and `src/` too, and picks its PowerShell subjects case-insensitively — the old pattern needed a quoted lowercase `powershell` and so skipped a file that was breaking the very rule it enforces. One more: the NUL stripper removed the escape sequence wherever it appeared, including where the leading backslash was itself escaped, which turns a payload whose text legitimately contains those six characters into a document that no longer parses — rejected by the server, retried by the spool, the same loop it exists to prevent `v1.26.106`
- **One iron-rule hook was running and the other had been dead for months, in the same settings file** — on a Windows machine upgraded to v1.26.102, `~/.claude/settings.json` held two PreToolUse entries for the same hook. The `Edit|Write|MultiEdit|NotebookEdit` one exited 0. The `Bash` one exited 1 with `ERR_MODULE_NOT_FOUND` on every single Bash call. **The two files were byte-identical** — only the directory differed: the copy under `~/.claude/hooks` imports `../shared/helpers.js`, and `~/.claude/shared/` is a directory no installer has ever created, so node exited before reading the first byte of the payload. Hooks are supposed to be silent, which is why nobody noticed the iron-rule check dying under every command. v1.26.92 already knew that path was broken and pointed new installs at the checkout, but its test was "does any command under this matcher mention `ownmind-iron-rule-check`" — and the broken one **did**. The broken command satisfied its own repair condition, so it was never going to be rewritten; v1.26.92 only ever reached fresh installs, and upgrades are the entire population. Four copies of that same logic sat in install.ps1, install.sh, update.ps1 and update.sh, and only the bash one was reachable from CI — the half that rotted was the half no test could touch. It is now one shared helper all four call, it **rewrites a command that differs** rather than treating presence as correctness, and the install self-check reads the registered command instead of asking whether a copy exists somewhere. Reading the command is still not enough on this machine, which is the sharper version of the same lesson: the two copies are byte-identical, so the registered file **is** there — what is missing is the module it imports on its first line, and an import that cannot resolve kills node before the payload runs. **Existing is not starting**, so both are now checked, which is how a machine reporting 6/6 with a dead hook stops being possible. One more, found in review: `install.sh` invoked the helper as a bare `VAR=$(...)`, and under `set -eE` that carries the helper's exit status — one unreadable settings file would have aborted the installer at that line, silently, with everything below it including the self-check never running. And the updaters now take that health report **after** their repairs rather than before: run first, it uploads a failure the same run then fixes, which is one alert per machine about a machine that is healthy by the time anybody reads it. Separately, `.gitignore` now names the six runtime files the installers write into the checkout — that list stopped at `.update-lock*`, so every upgrade on a real machine judged the tree dirty and took the `git reset --hard` branch, and the warning became noise on every run, which is where an edit somebody actually made scrolls past `v1.26.105`
- **The commit-message check was reading the previous commit's message** — git writes `.git/COMMIT_EDITMSG` *after* pre-commit has run, so a pre-commit hook reading that file sees whatever the last commit, or the last abandoned attempt, left behind. Measured with a hook printing each stage: pre-commit saw `FIRST MESSAGE` while commit-msg saw `SECOND MESSAGE`. Found the hard way — a commit rejected for a forbidden trailer, the trailer removed, and the retry rejected again quoting text the message no longer contained. **The quiet direction is the worse one**: a clean first attempt leaves clean text behind, so a violation introduced on the second attempt is waved through, and nobody would ever notice. It survived because the fallback to a `GIT_COMMIT_MSG` env var fired only when the file read threw — which is exactly what happens in a fresh test repo, so the tests only ever exercised the path production never takes. Message rules now live in the commit-msg hook, which git hands the real message; pre-commit **excludes** them rather than letting them evaluate to "pass", because counting an unexamined rule in `all N rules passed ✓` is a stronger claim than saying nothing. Selection is by condition type, never by rule code, so it works whatever numbering someone uses. The hardcoded `Co-Authored-By:` guard deliberately **stays** — removing it was the first attempt and it opened a hole, since the rule engine's substring match is case-sensitive and would miss `Co-authored-by:`, git's own spelling; the pre-existing tests caught that, unchanged. Review then caught what would have made this release a net *loss* of protection: `~/.ownmind` is the git checkout, so a pull swaps the hook logic instantly, but the installed wrappers are copies that the auto-update path never refreshed — so a user would have received the new pre-commit, which no longer checks messages, alongside an old commit-msg that never calls the new script, with the one still-working rule masking the silence. Both updaters now recopy the wrappers they find installed, and never create ones they don't. Three false blocks went with it: `git commit --verbose` puts the staged diff below the scissors line **uncommented**, so a diff adding the forbidden trailer blocked the commit over text the message never contained; `set -e` plus a `git rev-parse` command substitution killed the hook at exit 128 with nothing printed outside a repo; and the comment character is configurable rather than always `#` `v1.26.104`
- **Moving a file no longer counts as writing it** — `git mv` of 22 archived folders, not one byte edited, was blocked by the pre-commit secret scan for containing suspected credentials. Both named files were byte-identical to their committed versions and git itself reported `R100`; the same content had been committed for versions without ever being flagged. The scan was not misreading anything — it asks git for the diff of a **single path**, and scoped to one path git has no deleted counterpart to pair the addition with, so rename detection cannot run and it hands back the entire file as newly added. Comparing blob hashes, the obvious fix, would have hidden the identical case and left the worse one untouched: **move a file and edit one line of it**, and the other 400 lines are still presented as new, with a hash that genuinely changed. So both paths are handed to git instead, and `-M` is passed explicitly on both calls — with `diff.renames=false` in someone's config a move arrives as an unrelated delete plus add and the bug returns, and whether a commit is blocked must not depend on that preference. Review then caught the one way this could scan *less* than before: git hands those paths back and reads them again as **pathspecs**, and `--` does not disable that, so a file legally named `:!victim.txt` is also an exclude pattern that cancels its own destination out of the diff — measured, the scanner passed a freshly added `sk-proj-…` line. Fixed with `--literal-pathspecs` and pinned by a test, which also repairs the mirror-image false block. **No new exemption was added**: a blob-SHA skip was written and then removed, because with the pairing in place no test could tell whether it was there, and in a blocking security check an untested branch that skips scanning is an extra hole rather than extra safety. This matters past the one commit — the documented way past a false block is a bypass, and a bypass switches off every other rule at the same time `v1.26.103`
- **A collector that stopped is now announced, to the person and to the admin** — usage collection depends on a scheduled scanner, and when its schedule dies the person's MCP keeps heartbeating daily while nothing is uploaded, so the dashboard reads exactly like "this person did no work". Two releases already fixed mechanisms that caused it (v1.26.65, v1.26.79) and a machine measured on 2026-08-07 was still eleven days silent, on a client too old to have received either repair. A "nobody has reported for N days" rule cannot see this at all — the tell is that **one machine disagrees with itself**: its `claude-code` row was 0.2 days old while its other three were 11.2, and on the same snapshot all ten healthy machines had every tool row written within the same second. So that is the rule, with a deliberate gap between the two thresholds so an ambiguous machine produces no message rather than a maybe. The person is told what stopped, since when, that their usage was not uploaded, and how to repair it; the admin gets a separate list with no repair line, because they cannot run it on somebody else's computer. Repairing it ends the notice early rather than leaving it to expire. Nothing is announced the first time a machine is seen broken: a computer switched on after a fortnight away shows exactly this shape until the scanner's next run — two hours on Windows, longer on battery — so a finding must survive six hours before anybody is told, and a machine still broken a fortnight later is raised again, because the notice itself only lives 48 hours. **A machine that went entirely quiet is deliberately not reported** — in this data that is indistinguishable from a switched-off computer, a person on leave, or a laptop that was replaced `v1.26.102`
- **Half the index budget was being spent saying something the session already had** — v1.26.100 gave the index a line budget and split it by entry count, which is neutral, and neutral is wrong here: the two things in the index do not cost the same to leave out. Every iron rule is injected into the session in full by the SessionStart hook, so an index line for one adds only the link to its local file. A project that is not listed is not in the session at all. Splitting by count spent half the budget re-listing rules — 63 rules against 63 projects, with 67 projects left off. Iron rules now take a fixed 20 lines and the rest goes to the types with no second route in. Same data: **106 projects listed, up from 47 before any of this**. A capped type still reports the real number it left out, so there is one honest count rather than two `v1.26.101`
- **Half the memory index had stopped reaching the session, and nothing said so** — the index file grows one line per memory and the thing that reads it stops at 200 lines, asking for under 140. Measured on a real install: 284 lines, 143 iron rules plus 130 projects. Iron rules are listed first and run out by line 151, so **everything that never arrived was projects** — 47 of 130 made it, the other 83 had not reached a session in some time. Nothing marked the file and neither side warned at load time, so it went on reading as a complete index. What pushed it over was listing every iron rule, which the SessionStart hook already injects into the session in full, so those lines bought nothing. The index now has a line budget it cannot cross: entries are chosen most-recently-updated first, a type needing fewer lines than its share releases the rest, entry lines are capped at 200 characters with a visible `…`, titles are flattened so a newline cannot turn one entry into three lines, and **each section states how many it left out and where to find them**. Same data: 139 lines, 126 of 273 memories listed, the other 147 named out loud. Projects go from 47 to 63; iron rules drop from 143 to 63, which costs only the link to the local file since the hook injects the rules themselves either way. No memory file is deleted and nothing becomes unreachable `v1.26.100`
- **The "most common project" column was blank because nothing sent a project** — the team page reads a field only `ownmind_log_session` writes, and when the AI does not call it the server rebuilds the session from the activity log, where no event carried one. Measured over one week: four members had every session rebuilt that way and a fifth had 76 of 95, so the column was empty for four people entirely and four fifths of the fifth. This was first written off as unrecoverable, which was wrong — the value has been derived from `CLAUDE_PROJECT_DIR` since v1.17.37 and simply never travelled with anything else. The fix is to send it, not to recover it: one shared `resolveProjectName()`, every activity event from the MCP and both SessionStart hooks carries it, and the recovery takes the most common one it sees rather than the first. **The directory name only, never the path** — the name is work context, the path is where somebody keeps their files `v1.26.98`
- **The secret scanner was reporting one token in three as a credential** — the last-resort heuristic fired on "20+ characters from the key character set", which does not distinguish a key from an identifier. It blocked two commits in one day over a filename and a variable name, each time telling the user their code looked like an API key. Measured against every 20-character-or-longer token in this repository's own tracked files: **3438 of 10486 were false positives**. Three exemptions had already been added, one per incident, and a fourth would have been more of the same — the rule was measuring length when the distinguishing property is word structure. It now takes the longest run of key-shaped characters (`- _ .` break a run, the base64 symbols do not) and measures how much of it is covered by word-shaped segments. False positives fell to 333 on the same sample — 279 of which are npm integrity hashes, which are random by construction — and to 51 of 9082 (0.6%) across code and docs alone. All thirteen real key formats are still caught, and a genuine hole closed on the way: any value with three or more slash-separated chunks used to be waved through as a file path, which is a shape a base64 secret can take. Two of the three old exemptions were deleted as redundant, and the guarantee is now expressed as a measured rate rather than a list of allowed strings `v1.26.98`
- **An upgrade failure recorded a guess, not a reason** — every error report the upgrade scripts raised passed a hand-written sentence as its `detail`, and `detail` is what reaches the server, the admin console and the health broadcast. `"git pull --ff-only failed (network or non-ff merge)"` reads identically whether the remote was unreachable, the branch had diverged, or a file was locked. One machine failed a pull, restored its backup and self-checked clean seven seconds later, and there was no way to say why. The `context` field that should carry the log tail arrived empty; where it is lost is not established, and a cause that cannot be demonstrated is not written down as one. So the real tail of the failing command's log now goes into `detail` as well — one line, control characters stripped, capped identically on both platforms. The list of call sites is derived at test time rather than written down, which immediately turned up one the edits had missed `v1.26.98`
- **The update lock did not lock** — three programs share `~/.ownmind/.update-lock` so that only one of them runs the daily `git pull` in `~/.ownmind`; only the MCP ever took it. The shell hook tested for the file's absence ten lines above a `touch`, which both leaves a gap and succeeds on a file that already exists, so four concurrent hooks all "acquired"; the Node hook checked the lock and then created nothing at all. Found while reading one account's activity log, where four hooks started in the same second every morning, three recorded `update_failed` and one recorded success — the upgrade worked every time, and the eighteen "failures" over six days were the losing side of a race. Acquiring is now an exclusive create on all three sides, reclaiming a dead run's lock is serialised behind its own file and re-checked so it cannot delete a lock taken while it waited its turn, and losing the race records `update_skipped` with reason `lock_held` rather than a failure `v1.26.98`
- **The submit-confirmation gate was never a gate** — `ownmind_report_bug` told the AI it must not fill `confirm_string` itself because "the backend rejects auto-filled submissions with HTTP 400". It does not: the field is a string, and the server sees only that a string with the expected value arrived. Demonstrated by filing two bug reports that way. A server-issued one-time phrase does not close it either, because the AI is the caller that fetches the phrase; nor does approving in the console, since `POST /me/login` returns the same api_key the AI already holds. While both authenticate as the same principal, no server-side check can separate them. So the claim is gone and the distinction is recorded instead: `confirmation_declared` is `user_typed` / `ai_filled` / `unknown`, named for what it is, with anything absent or unrecognised becoming `unknown` rather than the stronger value `v1.26.97`
- **A hand-written list does not report the file it is missing** — `.gitattributes` pinned the git hooks to LF one line per file, and `hooks/ownmind-git-commit-msg` was added after that list was written. On a Windows clone it was the one hook of three that arrived CRLF. Scanning the whole repository found 32 tracked files carrying a shebang with no `eol=lf` rule. Impact today is zero — Git for Windows executes a CRLF shebang either way, verified with `GIT_TRACE=1` — but it becomes a fault the moment the shell provider changes. The rules are globs now, a test derives the list from `git ls-files` and fails on anything uncovered, and `install.sh` strips CR when copying the hooks into place, because `.gitattributes` governs checkout only: a machine already holding CRLF is never rewritten by git, since normalised comparison hides it from `status` and `pull` alike `v1.26.96`
- **Before**: You open a new conversation, ask AI to write some code, and it produces outdated syntax or ignores your style preferences. You re-type the same explanation again: "Remember, our project uses this pattern..."
- **After**: The moment the conversation opens, OwnMind has already injected your preferences, style, and iron rules into the AI. You state the requirement; AI produces compliant code the first try.

### Pain Point 2: IQ reset across machines and models

- **Before**: Morning on the work desktop with Claude Code, afternoon at home on a laptop with Cursor + Gemini. Crossing **different machines** + **different AI models** wipes your memory context — re-copy code, re-tune for each model's quirks, painful.
- **After**: Whichever machine you switch to, whichever model you pick, OwnMind silently unifies the memory core in the background. **Open a conversation anywhere; the experience is continuous and consistent.**

### Pain Point 3: AI repeats the same dumb mistakes

- **Before**: Last week production DB crashed because a deploy missed an env var. You stayed up all night fixing it. Today you ask AI to deploy a new feature and it produces the same instruction missing the same env var, nearly repeating the disaster.
- **After**: When the mistake happened, you said "remember this lesson" to AI. That iron rule got uploaded to OwnMind. Today when AI tries to deploy, the system intercepts at the kernel level, forces AI to self-check, and prevents the disaster from repeating.

### Pain Point 4: Team works in silos with no unified standards

- **Before**: As the team grows, everyone uses AI differently. Someone lets AI write code without tests; someone accidentally commits a password. The dev standards doc nobody reads. Code quality spirals.
- **After**: Lead publishes a team rule once in the admin console; every member's AI auto-loads and enforces it. Non-compliant code? The local pre-commit hook hard-blocks it, forcing dev + AI to fix before commit. Fully automated team standardization and quality gates.

### Pain Point 5: No central management, no visibility into team AI usage

- **Before**: The lead has zero visibility into how the team uses AI. Who uses what tools? Which technical frictions hit most often? What's the actual rule-compliance rate? Manage blind without data, can't evaluate real productivity or risk.
- **After**: A dedicated **central admin console + data dashboard**. Team-wide AI usage, per-member per-rule compliance rates, the team's most-hit pitfalls — all key metrics at a glance. Compliance analytics and audit logs (audit log: tamper-proof record of every action) are aggregated automatically.

---

## Pitfall Evolution: From Mistake to Iron Rule

OwnMind's core value is turning "pitfalls you stumbled into" into "AI's genetic rules" — guaranteeing the same mistake never happens twice on your team:

```mermaid
graph LR
    A["You hit a pitfall (e.g., commit without tests)"] --> B["Tell AI: remember this lesson"]
    B --> C["AI extracts and creates iron rule"]
    C --> D["Central server distributes"]
    D --> E["All team members & tools auto-load"]
    E --> F["AI tries to violate next time → tool + git commit hard-block"]
```

1. **Capture**: After hitting a deploy or dev pitfall, just say "remember this lesson: always verify DB connection before deploy"
2. **Extract**: AI integrates current context, distills a machine-verifiable iron rule (e.g., `IR-038`), uploads to OwnMind
3. **Continuous gating**: The rule syncs immediately to all your dev tools. Next time, wherever you work, the moment AI tries to "deploy without checking connection", the system intercepts at the kernel level

---

## Team Enforcement Defense Lines

When projects scale, team management is where disasters start — dev standards docs no one reads, juniors writing buggy code. OwnMind ships a hardcore enforcement system for teams:

### 1. Three-tier role hierarchy

Built-in **Super Admin** > **Admin** > **User** roles. The first two have absolute control over team iron rules — preventing regular users or AI from silently editing or disabling core safety rules in conversation.

### 2. One-click team standard broadcast

Lead publishes a team rule once (e.g., "every response must include a request ID") via the admin console. The system slices it semantically via RAG (Retrieval-Augmented Generation: fetches external knowledge before AI answers). When any team member opens a new conversation, AI hard-loads the rule summary and enforces it, pulling the sliced detail on demand. Zero manual training, zero standard-sync cost.

### 3. Local Git pre-commit hard gate

The strongest physical defense for team management. OwnMind installs a pre-commit hook on every member's machine. If a member's AI writes code that violates team rules (e.g., secret in source, or missing doc sync), `git commit` is hard-rejected — forcing dev + AI to fix before submission.

### 4. Compliance dashboard + audit log

The admin console auto-tracks per-member, per-AI-model execution metrics (compliance count, trigger count, violation count) for each rule and plots them as compliance-rate trend charts. Every AI action, every violation, every bypass — all recorded in tamper-proof audit logs for solid data-driven quality management.

---

## Three Defense Lines: Rule Enforcement Without Begging the AI

Prompting the AI to behave doesn't work. OwnMind builds three physical defense lines at the OS and tool level that AI can't bypass without leaving a trace:

1. **Defense 1: Spec unification** — When a conversation opens, the system calls the API to inject base prompts. Semantic line of defense.
2. **Defense 2: Execution-side control** — Before AI actually modifies code or runs commands, **PreToolUse intercept** (PreToolUse: pre-tool-call safety gate). If it tries to edit code without reading it first, the system rejects and rolls back, preventing **blind edit** (modifying files without reading them).
3. **Defense 3: Output-side review** — When AI finishes a response, the Stop hook (Stop hook: post-output review program triggered when AI completes a turn) auto-runs reply-lint. If it detects Chinese-English mixing, unexplained jargon, or accidental leak of user national ID / email / mobile (privacy_check detector, new in v1.19.7), the system commands AI to **rewrite** in the background until compliant. **After 3 consecutive blocks, the system auto-downgrades to a warning** to prevent infinite rewrite loops.

---

## Why not `.cursorrules` or `CLAUDE.md`?

"I'll just use project-level static rule files (`.cursorrules`, `CLAUDE.md`). Why OwnMind?"

Because static rule files are fragile — AI hallucinations bypass them silently. OwnMind is a stateful enforcement system:

| Aspect | Project-level static rules | OwnMind stateful enforcement |
|:---|:---|:---|
| **Maintenance** | Files scattered across projects, hard to sync | Edit once on central server; all machines and tools sync immediately |
| **Enforcement** | Relies on AI self-discipline; hallucinations bypass | Critical-tier rules: programmatic hard-stop. Local pre-commit hook blocks `git commit` itself |
| **Learning from errors** | Every conversation starts blank; same pitfalls repeat | Auto-record violations; adaptive reinforcement (the system dynamically strengthens prompts based on AI's violation history) |
| **Security** | Easy to accidentally commit credentials | Auto-filter sensitive strings and hard-block; route to secure vault |
| **Team rollout** | Manual file copy; missed copies = no enforcement | Lead pushes once; new hires auto-align from day one |

> **Honest disclosure**: The `OWNMIND_BYPASS` env var (rule-bypass switch) allows you to skip a single iron rule in emergencies — but every bypass is logged in the audit trail. AI cannot bypass without leaving a trace.

---

## Core Features

### Memory & Protection

- **Memory / secret routing** — Three data classes: profile / memory / secret (encrypted vault). AI tries to write a password to plain memory → blocked with HTTP 400 and redirected to the vault `v1.19.1`
- **Privacy detector (optional)** — Each AI reply can be scanned for Taiwan national ID (with official checksum validation), email, Taiwan mobile patterns. Strings the user themselves prompted are exempted (treated as the user actively sharing). Matches emit a `privacy_check` event; whether to block is decided by each user's own iron rule `v1.19.7`
- **Pre-commit secret content scan** — On top of the existing filename-pattern block, scans staged diff added lines for OpenAI / GitHub PAT (Personal Access Token) / JWT (JSON Web Token) / AWS key patterns as IR-002 violations `v1.19.7`

### Collaboration & Sync

- **Cross-tool handoff** — Before logging off, say "wrap up and prepare handoff" to AI; it packages incomplete tasks and design context, uploads. Tomorrow, on a different editor with a different AI, it resumes seamlessly `v1.13.0`
- **Multi-client conflict lock** — When multiple editors write memory simultaneously, sync tokens (tags identifying write order) block stale versions and force AI to refetch latest. Your hard-won dev rules aren't overwritten
- **Cross-machine auto-sync** — Switch laptops, travel, new hire's day one — login pulls memory and rules immediately, zero wait

### Observability & Analytics

- **Every field the shell hooks logged was discarded on arrival** — `log_event` wrote its key/value pairs flat, beside `ts` and `event`, and posted that same object to the batch endpoint, which reads `e.details` and nothing else. `details` was never present, so every row stored `{}`. The upgrade hook distinguishes six failure steps — lock / cd / fetch / pull / npm / update_sh — and none of them ever left the user's own machine: measured on 2026-08-07, one user had 18 failed upgrades and another 9, with no recorded reason for any of them. The same silence covered which trigger fired and the `edit_reminder_failed` channel added one release earlier, which was therefore born broken. The pairs now go inside `details`; the server needed no change, it had always read the right key `v1.26.95`
- **The Windows MCP path is no longer destroyed on the way into settings.json** — `cygpath -w` returns backslashes, and install.sh interpolated that path into the source text of `node -e`. What the parser received was `const p = 'C:\Users\Vin\.ownmind\mcp\start.cmd'.replace(/\\/g, '\\\\')`, and `\U`, `\V`, `\.`, `\m`, `\s` are not escape sequences: JavaScript dropped each backslash and kept the letter, so `p` was already `C:UsersVin.ownmindmcpstart.cmd` before the `.replace` that existed to double the backslashes ever ran. Every `bootstrap.sh` upgrade wrote that unusable command into `~/.claude/settings.json`. It stayed invisible because Claude Code launches the MCP server from `~/.claude.json`, which no installer writes — the broken value sat in the file nothing reads, and the next install.ps1 run quietly repaired it. Escaping cannot fix this: the string is destroyed by the JS parser, not by the shell. Both branches now hand the path to Node as an argv element `v1.26.94`
- **Re-running the installer with a new key now changes the key** — Both installers skipped the Claude Code MCP block whenever the settings file already contained the string `"ownmind"`. That block is where the API key lives, so every re-run meant to change it — switching accounts, rotating a credential, fixing one typed wrong — did nothing and then printed an installation summary. The check asked whether OwnMind was configured; the question that mattered was whether it was configured with *this* key. Cursor's MCP block carried the same guard and the same key. Both now always write, merging so an existing entry keeps fields the installer does not manage, and each run reports which of written / updated / unchanged happened. The remaining `already configured` skips append rule text and hold no credential, so they stay `v1.26.93`
- **Two config files holding two different keys is now visible** — The installers write `~/.claude/settings.json` and nothing else, while Claude Code keeps its MCP config in `~/.claude.json`. `resolveCredentials` returns the first key it finds, so after an account switch the two files could disagree while every check passed and the process launched from the other file acted as the other account — nothing compared the values. `resolveCredentials` now returns `conflicts`, and a new `credential_agreement` self-check warns and names the disagreeing file. Files only: the environment is searched last and can never be the losing side, and counting it would warn everyone whose shell still holds the key they installed with. Locations, never values — this is uploaded with the report `v1.26.93`

- **Three-tier rule classification** — Every rule labeled `critical` (red, hard-block) / `default` (yellow, depends on settings) / `advisory` (gray, log-only). SessionStart digests group by tier `v1.19.0`
- **Compliance dashboard** — Tracks per-member, per-AI-model compliance / trigger / violation counts per rule; plots trend charts
- **Reply quality lint** — Stop hook scans for Chinese-English mixing (IR-037), unexplained jargon (IR-036), privacy patterns (`privacy_check` event; user's own iron rule decides whether to block). 4th violation per session → `process.exit(2)` with directive-style rewrite prompt on stderr. After 3 consecutive hard blocks, auto-downgrades to warning to prevent rewrite deadlock `v1.19.7`
- **Forced version check** — Each new conversation calls API to verify client / server version. Prevents using outdated versions with already-fixed bugs `v1.19.4`
- **Install-check failure rendering** — Pure function renders grouped install-check failures into a readable message. Multiple machines with the same problem collapse into one row. Written to fit what the reader is actually shown — both delivery paths keep only the first 5 lines and 400 characters — so one failure is one line, the omitted-count footer is the last line, and a shortened entry always carries a visible cut marker `v1.26.87`
- **Install-check alert job** — `runInstallCheckAlerts` reads each machine's newest self-check report (ordered by server-assigned id, never the client-supplied timestamp), records new/resolved failures, and drafts a 48-hour broadcast for the oldest super admin. Each new failure is claimed before the broadcast is written, and every claim plus the broadcast insert run inside one transaction: if anything between them fails, the whole thing rolls back and the error is rethrown. So two overlapping sweeps announce once between them, and no partial write — not even a claim that commits while its response is lost — ever leaves a failure marked announced with no broadcast to show for it. Runs after every stored report (`POST /api/debug/install-check`, failures logged not thrown) and once per server boot to sweep pre-existing reports `v1.26.87`

### Iron Rule Enforcement Engine

- **The most-tagged rules were the ones that never fired** — the hook was registered for `Bash` only, so a rule could fire only while a shell command ran. Editing a file is not a shell command, so nothing tagged `trigger:edit` had ever been surfaced while the AI was changing code. On one real account that was 56 rules, the most-used tag on it, and 68 counting aliases and the untagged rules that match everything — against 0 shown. It now also runs on the file-editing tools, throttled to one full listing per hour: every edit after that in the same hour gets a single line, `AI 改檔案要遵守的鐵律 68 條 · 本小時第 4 次`. The line names the AI because a bare "68 rules in effect" reads as an instruction to whoever is watching, and it says the rules apply rather than that they were obeyed — the hook can see the first and not the second. Reminder only: the edit trigger never reaches the verification engine, which is the only path here that can block, and the throttled line makes no network request `v1.26.92`
- **A rule is matched by what it means, not by three exact words** — `detectCommandTrigger` answers only `commit` / `deploy` / `delete`, and the hooks kept a rule only when one of its tags was literally `trigger:<that word>`. Nothing states that those three words are the entire vocabulary and `ownmind_save` accepts any tag, so rules get filed under the words their author thinks in — `trigger:回滾`, `trigger:cleanup`, `trigger:升級` — and are then dropped at the filter with a silent exit that never says why. One real account had three iron rules and no trigger could reach any of them. Each trigger now accepts a set of equivalent tags (`delete` also takes 刪除/cleanup/清理/rollback/回滾/還原/restore, and so on), compared case-insensitively. This widens which stored rules a trigger matches; it does not widen when the hooks run, which is still `detectCommandTrigger` unchanged — so no new noise and no new blocking. Tags outside a risky operation, like `trigger:install`, still do not fire, because `npm install` is not an operation the hook runs on `v1.26.91`
- **The pre-action iron rule reminder now actually fires** — The PreToolUse hook read the command from a top-level `.command`, but Claude Code sends `{ tool_name, tool_input: { command } }`. The extraction returned `''` on every platform and the hook exited at its empty-command guard — a silent, successful exit, so nobody saw a reminder anywhere. On Windows it failed one step earlier still: `readFileSync('/dev/stdin')` resolves to `C:\dev\stdin` and throws outside the `try`, with the error discarded by `2>/dev/null`. Both hook copies now read fd 0 and prefer `tool_input.command`, falling back to the bare shape for manual invocation `v1.26.90`
- **A matched verification template is a suggestion, never an action** — Saving an iron rule used to have the server attach `metadata.verification` to it silently, and every template in the set carries `block_on_fail: true`. You wrote a reminder and got back a rule that would stop your work, announced only by a bare id buried in the response. One incidental keyword in a long rule was enough: a rule about preserving logs during rollback, tagged `trigger:deploy` and containing 測試 once, was given "run tests before deploying", whose block message says something the author never wrote. The match is still computed and returned as `template_suggestion` — name, `applied: false`, whether it blocks work, and a sentence the caller can relay — but nothing is written until somebody asks for it `v1.26.89`

- **Shared rule-enforcer core** — Pure function `enforceRule(ruleCode, context, options)` returns `allow` / `block` / `warn` / `log_only` / `bypass` by tier. **Status:** v1.19.7 wires `bypass-handler.js` into git pre-commit + reply-lint (so `OWNMIND_BYPASS` works); full `enforceRule` integration replacing direct `evaluateConditions` loops is deferred to v1.19.8 `v1.19.6`
- **Adaptive reinforcement** — System dynamically strengthens prompts based on AI's violation history (3+ violations of the same rule per session → that rule's prompt auto-upgrades to a strong warning)

### Infrastructure

- **Secret management** — Securely store API keys and passwords with double encryption (master key + per-row salt)
- **Keyword search** — Multi-keyword AND search across title, content, tags, and code fields (a pgvector column is provisioned for a future semantic-similarity upgrade, not yet in use)
- **Tiered compression** — Short-term memory auto-compresses, long-term memory persists forever
- **Native Windows support** — `install.ps1` and `start.cmd` included, no WSL (Windows Subsystem for Linux) needed
- **Source-file hygiene guard** — Test suite fails if any file under `src/`, `scripts/install-helpers/` or `hooks/` contains a raw control byte (e.g. NUL) or a literal invisible character that would make `grep`/`file` treat it as binary and skip it silently `v1.26.87`
- **Windows-native paths in inline Node** — Under Git Bash a POSIX path (`/c/Users/...`) interpolated into `node -e` source reaches `node.exe` unconverted and resolves against the drive root, so the installer died mid-file with no output at all. Every such path now goes through the shared `to_win_path` (`cygpath -m`, identity off Windows), and a guard test derives the offender list from the scripts themselves — failing closed on any block it cannot parse `v1.26.88`
- **Installers never discard a Node error stream** — `2>/dev/null` on a `set -e` script turns a fatal error into a script that merely stops. Installer stderr goes to a log, an ERR trap names the line that aborted, and the upgrade log lives outside the directory rollback replaces — so "see the log" stops naming a file the rollback just deleted `v1.26.88`
- **Install-completeness assertion** — The version number is not evidence that installation completed: a machine can report the current version because something else moved its working tree forward while the installer aborted before producing anything. One shared artifact list (SessionStart hook, iron-rule hook, `hooks/lib`, git hooks, skill file, MCP entry point) is asserted at the end of every install and reported as the `install_complete` self-check item, so a truncated install announces itself instead of waiting to be noticed `v1.26.88`

---

## System Requirements

- **Client**: Node.js 20+, Git 2.30+
- **Server**: Self-host (Docker Compose one-click deploy provided) or use a licensed hosted service
- **Platforms**: macOS / Linux / Windows (Windows users need full Git for Windows installer for sh.exe used by Git hooks)
- **Supported AI tools**: Claude Code, Codex CLI, Cursor, Copilot, OpenCode, Windsurf, Gemini CLI, or any client that reads MCP (Model Context Protocol: standard for AI ↔ external tool integration) or hooks

---

## Quick Start

### 1. Get API key and URL

After installing OwnMind, log in to the admin console as admin to obtain your access key (API key) and server path (API URL).

### 2. Pick an install path (choose one)

#### Option A: Let AI install (easiest)

In your AI editor (e.g., Cursor or Claude Code) chat, type:

- **Fresh install**: `Install OwnMind (my key is YOUR_API_KEY, URL is YOUR_API_URL)`
- **Auto upgrade**: `Upgrade OwnMind`

AI auto-detects your OS and runs the installer.

#### Option B: One-line shell install

macOS or Linux:

```bash
# Fresh install
curl -fsSL https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.sh | bash -s -- YOUR_API_KEY YOUR_API_URL

# Upgrade
curl -fsSL https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.sh | bash
```

Windows PowerShell:

```powershell
# Fresh install
$env:OWNMIND_API_KEY='YOUR_API_KEY'; $env:OWNMIND_API_URL='YOUR_API_URL'; iwr -useb https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.ps1 | iex

# Upgrade
iwr -useb https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.ps1 | iex
```

> **Windows note**: OwnMind depends on the Bash shell (sh.exe) bundled with Git for Windows to run Git hooks. Install the full Git for Windows installer (not Lite or Portable), or commits will error out.

### 3. Verify installation

After installing, open a new conversation and ask AI:

> "Which OwnMind iron rules are currently loaded? Show me the first 5."

If AI lists them (with codes like IR-002, IR-008), hooks are correctly injecting memory.

If not, check:

```bash
cat ~/.ownmind/credentials   # confirm key exists
cat ~/.ownmind/cache/iron_rules.json | head -3   # confirm rule cache
```

---

## Emergency Bypass: What if I'm stuck?

OwnMind provides env-var escape hatches. **Every bypass writes an audit log** that your team lead (or future self) can review.

### Pre-commit blocked, need to commit anyway

```bash
# Bypass a single rule
OWNMIND_BYPASS=IR-002 git commit -m "hotfix: emergency"

# Bypass everything (extreme cases)
OWNMIND_BYPASS=all git commit -m "hotfix: emergency"
```

### Reply-lint too aggressive

```bash
# Warn only, don't block AI replies
export OWNMIND_REPLY_LINT_MODE=warn

# Or fully skip
export OWNMIND_REPLY_LINT_DISABLE=1
```

### Disable OwnMind entirely

```bash
export OWNMIND_DISABLED=1
```

> **Key point**: These are escape hatches, not long-term settings. If you find yourself bypassing a rule constantly, that rule is probably mis-designed — fix it in the admin console rather than disabling OwnMind.

---

## Useful Chat Commands

Talk to your AI in plain English:

- **"Remember this lesson: [content]"** — Auto-generate an iron rule, sync to every tool
- **"What's left to do on this project?"** — AI pulls cross-session TODO list from OwnMind
- **"Wrap up today's work and prepare handoff"** — Auto-package progress; tomorrow on a different machine or tool, resume at full speed
- **"Am I on the latest version?"** — Force a fresh online version check
- **"Show me the first 10 iron rules"** — Verify local rule cache state

---

## FAQ

### Installation

#### Q: Fresh server deployment — how do I get into the admin console the first time?

**v1.19.8+ recommended flow (zero friction)**:
1. `docker compose up -d` to start the server
2. Open browser to `https://your-server/admin` — system detects an empty `users` table and auto-redirects to `/setup`
3. Fill in email + password to create the first super_admin
4. Page then displays your api_key (one-click copy) + a client install template (auto-filled with current server URL)
5. Click "Go to login" to enter the admin console; create other members and manage iron rules from there

Total: about 2 minutes. The wizard auto-closes permanently after the first admin is created.

**Advanced / rescue path (legacy v1.19.7 and earlier)**:

If your deployment hits one of these scenarios, the wizard won't apply:

| Scenario | Path to take |
|:---|:---|
| Restore from backup; `users` table has a super_admin but `password_hash IS NULL` | Set env `SETUP_TOKEN`, then sign in at the console — it offers the password-setup form (`POST /api/admin/setup`) |
| Admin forgot password, wants to reset | SSH into DB, `UPDATE users SET password_hash = NULL WHERE id = ...`, then use setup token path |
| Migrating server, importing old DB | pg_dump / pg_restore + either rescue path above |

Normal first-time install **does not need** `SETUP_TOKEN` — the wizard handles it.

#### Q: Admin forgot their password — what now? (v1.19.9+ three-tier recovery)

The right path depends on "are there other admins":

**Scenario A: Team has other admins (most common)**
- Any other super_admin logs in, goes to "User Management", finds the locked-out admin, clicks "Reset Password"
- System generates a 12-char random temporary password (avoiding confusable chars 0/O/I/l/1), copy it to the affected user
- They log in with the temp password and are forced to set a new one

**Scenario B: Sole admin forgot password (you are the only one)**
- SSH into the server host and run the rescue script:
  ```bash
  node scripts/reset-admin-password.js
  ```
- Script interactively: lists all super_admins, asks which one to reset, requires typing `yes` to confirm
- Auto-generates a `SETUP_TOKEN`, prints it to your terminal
- Then `export SETUP_TOKEN=<token>`, restart the server, open the console login page and enter that account's email with any password. The console detects the account has none and shows the setup form. (Before v1.26.59 this step said `/admin/setup`; the legacy console was retired in that release.)

**Scenario C: No SSH access at all (cloud SaaS mode)**
- Currently no built-in path — contact the service operator
- v1.20+ plans to add email-based reset (depends on SMTP integration)

**Prevention beats cure**: v1.19.9+ shows an orange warning banner in the admin console when there's only one admin, strongly suggesting you create a second one for mutual rescue.

#### Q: Can it coexist with `.cursorrules` or `CLAUDE.md`?

Yes. OwnMind is central, `.cursorrules` is project-local. Recommended: cross-project personal preferences and iron rules → OwnMind; single-project-specific rules → `.cursorrules`. No conflict.

#### Q: Why does AI sometimes seem to say the same thing twice?

That's not a bug — it's a visible side-effect of the reply quality check. The flow:

1. AI's first response gets emitted; the lint hook detects a violation (Chinese-English mixing, unexplained jargon, or PII leak)
2. After 4 consecutive violations in the session, the hook blocks and tells AI to rewrite
3. AI emits a compliant rewrite — you see two similar paragraphs

v1.19.11 added three mitigations:

- **AI self-annotation** (85% reliability): rewrite begins with a quote block "⚠️ Previous version violated IR-XXX, re-adjusting" + separator
- **Tiered display**: first block shows full message; 2nd-3rd show short "↻ previous version violated IR-XXX, rewritten"
- **Permanent log**: every block event is appended to `~/.ownmind/logs/reply-lint-events.jsonl`; query anytime "how many times was I blocked this week, which rule most often"

If AI skips annotation (15% case), check the log to know what happened:

```bash
tail -5 ~/.ownmind/logs/reply-lint-events.jsonl
```

### Privacy & Security

#### Q: Where does my conversation data go? Does OwnMind itself collect PII?

OwnMind's design principle is "don't collect user privacy unless directly work-related". Specifically:

**Uploaded to server**:
- Iron rules, memory entries, and profile preferences you actively create
- Compliance events (which rule triggered when, result: comply / violate / bypass) — for compliance analytics

**Never uploaded**:
- Full AI conversation contents (your prompts + AI responses)
- Your source code / file contents
- System paths, filenames (except those you actively store as memory)
- Keystrokes, mouse trails, or any behavioral telemetry (user-action monitoring data)

**Self-hosted = 100% on your own server**; even the "uploaded" data only goes to your database.

#### Q: How are API keys and passwords stored? Is transport secure?

- **Storage**: API keys and `/api/secret` entries use double encryption (master key + per-row salt — a primary key plus a unique salt per record). Even a full DB dump can't be decrypted directly
- **Transport**: HTTPS enforced (HTTP auto-redirected; you can put nginx/caddy in front for SSL termination)
- **Local**: client `~/.ownmind/credentials` is mode 0600 (only current user can read)
- **Audit**: every API action writes an audit log with timestamp + actor user ID, tamper-resistant

#### Q: Does OwnMind see my source code?

No. OwnMind hooks only intercept **rule-violation events** (e.g., staged file contains a credential pattern; AI response Chinese-English mixing over threshold) and send violation metadata (data describing the event itself, not the code) back to the server. Original source code and AI conversation contents **never leave your machine**.

Exception: if you explicitly tell AI "store this code snippet as memory", that snippet is uploaded.

### Cost & Performance

#### Q: Will using OwnMind increase my AI token bill?

Yes, slightly. OwnMind itself **does not call any LLM** (no GPT/Claude API calls), so there's no extra LLM API cost. But because each new conversation injects the iron-rule list (30-50 rules, ~2-5 KB of text) into the AI's system prompt, your AI's input tokens per new conversation go up by 1500-3000 tokens (depending on rule count).

At Claude Sonnet pricing (input $3 / 1M tokens): about $0.005-0.01 extra per new conversation. Twenty new conversations a day → $0.10-0.20/day extra. Compared to the time saved from not re-explaining preferences, ROI (return on investment) is strongly positive.

> To optimize: in the admin console, mark non-current-work rules as `disabled` or set them to `advisory` tier (log-only, not auto-injected). Reduces token overhead.

#### Q: Will the hooks slow down my dev workflow?

Measured latencies (M1 MacBook, with local cache warm):

| Hook | Latency | Triggered by |
|---|---|---|
| pre-commit | < 50 ms | Every `git commit` |
| reply-lint | < 30 ms | Every AI reply turn |
| session-start | 200-500 ms | Opening a new AI conversation (includes rule loading) |
| version-check | < 100 ms | Opening a new conversation (parallel API call, non-blocking) |

The only one you might perceive is session-start at 200-500 ms; the rest are below the perception threshold (humans don't notice < 100 ms). Network sync runs asynchronously in the background and never blocks a commit.

#### Q: What if the server goes down? Will my work get stuck?

No. Fail-open by design — when the server doesn't respond, hooks skip the check and don't block commits or AI replies. Local rule cache covers offline operation for 24h. After 24h, hooks try to re-sync; if sync fails, still fail-open.

### Other

#### Q: Does it work offline?

Yes. All iron rules cache to `~/.ownmind/cache/iron_rules.json`; offline operation within 24 hours is normal.

#### Q: Can iron rules be imported/exported? Shared across teams?

Yes. Each rule has a unique UUID; the admin console supports JSON export. Move rules between OwnMind instances, or open-source them on GitHub for other teams.

#### Q: Why "OwnMind"?

"Own your mind" — your memory belongs to you, not some AI vendor. Re-teaching your style to every new tool effectively rents your mental model (how you think about things) to the vendor. OwnMind hands ownership back to you.

---

## API Reference

### Authentication

All API requests require `Authorization: Bearer YOUR_API_KEY` header.

### Main Endpoints

```
GET    /api/memory               # List memories
POST   /api/memory               # Create memory
PUT    /api/memory/:id           # Update memory
DELETE /api/memory/:id           # Delete memory
GET    /api/memory/type/:type    # Fetch by type (e.g., iron_rule)

POST   /api/secret               # Create encrypted secret
GET    /api/secret/:key          # Retrieve decrypted secret
DELETE /api/secret/:key          # Delete secret

POST   /api/activity/batch       # Batch report compliance events
GET    /api/compliance/stats     # Query compliance stats
```

Full API docs in [OpenAPI spec](openapi.yaml) (if available).

### Memory Types

- `profile` — Personal preferences (nickname, preferred tools, writing style)
- `iron_rule` — Iron rules (with verification conditions, tier, block_on_fail flag)
- `project` — Project context (architecture, stack, TODOs)
- `principle` — Working principles (non-machine-verifiable, AI reference only)
- `learning` — Pitfall records (drafts before being distilled into iron rules)

---

## Tech Stack

- Backend: Node.js 20+ / Express
- Database: PostgreSQL 16 + pgvector
- Deployment: Docker Compose
- Client hooks: Node.js (macOS / Linux / Windows)
- Sync protocol: HTTPS REST + MCP (Model Context Protocol)

---

## Contributors

- Vin (miou1107)

Issues, PRs, and usage feedback welcome.
Repo: [github.com/miou1107/OwnMind](https://github.com/miou1107/OwnMind) (if public)

---

## License

MIT
