audience: agent

# OwnMind install manual (for the AI that installs it)

You are the AI tool on a colleague's computer. They pasted an install message into this conversation, and you are about to run one command from it. This manual tells you what that command changes, how to read what it prints, what to do when it stops, and how to know it is finished. Read all of it before you run anything. The colleague is not a developer: speak to them in their own language, in plain words, and keep it short.

## What gets installed and where

Use this section when the colleague asks "what did you do to my computer".

- **Install folder: `~/.ownmind`** (the folder named `.ownmind` in the home folder). It holds the OwnMind program files, the scripts, the hooks, the memory connector (`mcp/`) and the logs.
- **How the files arrive depends on the computer.** If git is present, the installer clones the OwnMind repository into `~/.ownmind`. If git is absent, it downloads the release archive from the OwnMind server (or from GitHub if the server is unreachable), unpacks it next to the target, and moves it into place only when the unpack is complete; that folder then holds a file named `.release` with the version, where a git install has a `.git` folder. Neither way needs the colleague to install anything.
- **A private Node.js, only if needed.** OwnMind needs Node.js 20 or newer. If the computer has one, it is used and nothing is added. If not, the installer downloads the official Node.js archive (through the OwnMind server, or from nodejs.org if the server cannot) into `~/.ownmind/runtime/` and uses that copy. It is not added to the system and nothing else on the computer uses it.
- **Files the installer writes in the host AI tools.** For Claude Code and the Claude desktop app: `~/.claude/settings.json` (the OwnMind hooks, so memory loads when a conversation starts and rules are checked before actions), `~/.claude.json` (the OwnMind memory connector entry), and the skills `~/.claude/skills/ownmind-memory` and `~/.claude/skills/ownmind-upgrade`. When Cursor, Gemini CLI, GitHub Copilot, Windsurf, OpenCode, OpenClaw or Antigravity is present, the same kind of hook or rules file is written in that tool's own folder in the home folder (for example `~/.cursor`, `~/.gemini`). Tools that are not present are left alone.
- **Also inside the home folder.** The colleague's API key is stored in those two connector entries, nowhere else. A scheduled job sends usage numbers to the OwnMind server (a launchd agent in `~/Library/LaunchAgents` on macOS, a Task Scheduler task for the same user on Windows). If git is present, the installer also sets git's global hooks folder to `~/.ownmind/git-hooks`, which holds the pre-commit and post-commit checks; any hooks folder the colleague had before is remembered and its hooks still run.
- **No administrator password.** Nothing in the install needs one. Nothing outside the colleague's own home folder (and their own user's scheduled job) is changed. No system settings, no other users' folders.
- **Removing it** applies only when the colleague asks to remove OwnMind: delete `~/.ownmind` and the entries above; no uninstaller is needed. During an install, never delete `~/.ownmind` yourself; a re-run repairs it.

## The command and the output grammar

The command is the one-liner in the install message, one for macOS and one for Windows PowerShell. Both fetch a script from the OwnMind server (`<API_URL>/install.sh` or `<API_URL>/install.ps1`), which does everything. Run the line for this computer's operating system, once.

Every line the installer prints starts with one of six prefixes: `INFO:`, `OK:`, `ERROR:`, `FIX:`, `ASK:`, `NEXT:`. The rules for reading them are below. They are the same rules the `ownmind-upgrade` skill carries once OwnMind is installed, word for word.

<!-- rules:start -->
1. Run the one-liner from the install message the colleague pasted, once. Read every line of its output.
2. Every line the installer prints starts with one of six prefixes:

| Prefix | Meaning | What you do |
|---|---|---|
| `INFO:<code>:<text>` | progress | nothing |
| `OK:<code>:<text>` | a step finished | nothing |
| `ERROR:<code>:<text>` | a stop | look for the `FIX:` or `ASK:` line next to it |
| `FIX:<code>:<command>` | a repair you may run yourself | run the command, then run the one-liner again |
| `ASK:<code>:<sentence>` | a stop only the person can resolve | say the sentence, then stop |
| `NEXT:<kind>:<detail>` | what to do after a successful install | see "After a successful install" |

   The text of a line is everything after its code. `ASK:<code>:` and `NEXT:verify:manual:` / `NEXT:verify:new-session:` are followed by the sentence or the title; colons inside that text belong to it.

3. Which line wins:
   - If any `ASK:` line appeared anywhere in the run, the ASK wins over every `FIX:` line: say its sentence and stop. A `FIX:` printed next to an ASK is the installer's last attempt, not an instruction.
   - `ERROR:` followed by `FIX:` (and no ASK): run the fix, then run the one-liner again. At most three rounds. After the third, tell the user what the last `ERROR:` line said and stop.
   - An `ERROR:` with no `FIX:` or `ASK:` after it: use the nearest earlier `FIX:` or `ASK:` line of the same run. If there is none, say the text of the `ERROR:` line to the user in plain words and stop.

   `FIX:` payloads are commands you can run as printed. Where one shows `<KEY>` or `<API_URL>`, put in the API key and URL from the install message (the URL is already filled in when the installer knew it).

   | `FIX:` code | What it is |
   |---|---|
   | `retry_install` | the command that runs the installer again (a download or unpack was cut off; the installer clears its own leftovers) |
   | `rerun_with_args` | the same command, to be run with the API key and URL the colleague gave you |
   | `use_fallback_source` | the command with `OWNMIND_SOURCE=github` set, so the installer skips the OwnMind server |
   | `clear_partial` | removes the unfinished download folder; then run the one-liner again |

4. `ASK:<code>:<sentence>`: say the sentence to the user exactly as printed (it is already in the user's language; codes: `no_network`, `node_download`, `disk_full`, `unsupported_os`), then stop. Do not retry, do not add advice of your own.
5. Never suggest installing git, Node.js, Homebrew, the Xcode command line tools or winget. The installer brings its own runtime; a machine on which it could not is an `ASK:` case, not a chore for the user. (The `ERROR:` text of an unsupported system may mention Node.js; it is for the log, not for you to repeat.)
6. Permissions. When your tool or the operating system refuses something the install needs, that is the one question you may ask your owner during the install. Name the permission, say what it is for and what they will see after granting it, in their language, one step at a time, naming the button or setting as it appears on screen. Then carry on with the install. Do not stop at "I do not have permission".
<!-- rules:end -->

### Every FIX code

A `FIX:` line is `FIX:<code>:<command>`. The command is yours to run, as printed.

| Code | What it means | Note |
|---|---|---|
| `FIX:retry_install` | The download or unpack was cut off, or an install step failed, and running the installer again will pick it up. | The command is the install one-liner itself, sometimes with a source setting in front. Run it. The installer clears its own leftovers first. |
| `FIX:rerun_with_args` | The installer was started without the API key or URL. | The command shows `<KEY>` and `<API_URL>`. Put in the key and URL from the install message, then run it. |
| `FIX:use_fallback_source` | The OwnMind server did not answer the download. | The command is the one-liner with `OWNMIND_SOURCE=github` set, so the installer goes to GitHub directly. |
| `FIX:clear_partial` | A leftover unfinished download folder (`~/.ownmind.partial`) could not be removed by the installer. | The command removes it. Then run the install one-liner again. |

### Every ASK code

An `ASK:` line is `ASK:<code>:<sentence>`. The sentence is everything after the code, colons included. It is already in the colleague's language: say it as printed, then stop. Do not retry and do not add advice. A `FIX:` printed next to an `ASK:` is the installer's last attempt, not an instruction.

| Code | What it means |
|---|---|
| `ASK:no_network` | Neither the OwnMind server nor GitHub could be reached. The computer is offline, or a company network blocks both. |
| `ASK:node_download` | The computer needs its own Node.js, and neither the OwnMind server nor nodejs.org could be reached to get it. |
| `ASK:disk_full` | The computer has less than about 500 MB free, so the installer stopped. |
| `ASK:unsupported_os` | The installer supports macOS and Windows only; this system is neither. |

### Lines you will also see

`INFO:` and `OK:` lines are progress. An `ERROR:` line names a stop (for example `npm_install`, `git_clone`, `install_incomplete`). Its text is written for the log; the line to act on is the `FIX:` or `ASK:` next to it. Some `ERROR:` texts tell a person to install Node.js or upgrade something by hand. Do not repeat that: it is for the log, and the installer brings its own runtime.

## Troubleshooting

Each shape below is a known failure, and the action for it. All of them end the same way: run the one-liner again or say the sentence, never improvise another install route.

| What you see | What it is | What you do |
|---|---|---|
| The download from the OwnMind server fails, and a `FIX:use_fallback_source` line appears | The server was unreachable (or blocked on this network). The installer already tries GitHub by itself when it can. | Run the `FIX:` command. If an `ASK:no_network` follows, say its sentence and stop. |
| `ERROR:` about a download or unpack, `FIX:retry_install` | A download was cut off, so a half-written folder `~/.ownmind.partial` may exist. | Run the `FIX:` command. A re-run clears the leftover itself. If it asks for `clear_partial`, run that, then the one-liner. |
| `ERROR:npm_install`, `FIX:retry_install` | The npm package registry could not be reached while installing the memory connector's dependencies. | Run the `FIX:` command. After three rounds, say what the last `ERROR:` line said. |
| `~/.ownmind` exists from an earlier attempt (stopped half way, or an older install) | A stale folder. | Run the one-liner again. The scripts repair it or replace it; the colleague loses nothing. Do not delete it yourself. |
| `ASK:disk_full` | The disk has no room. | Say the sentence and stop. Nothing is partly installed that a re-run cannot repair. |
| `ERROR:missing_args`, `FIX:rerun_with_args` | The key or URL was left out of the command. | Use the key and URL from the install message. |
| Your tool shows a prompt, or says it may not run commands | A permission, not an installer problem. | See Permissions below. |

### Permissions

Permission is the one thing you may ask the colleague about during the install. Ask for one thing at a time, in their language: name the permission, say what it is for, give the exact words or button, and tell them what they will see afterwards. Then carry on with the install. Never stop at "I do not have permission".

**Your own tool asks "allow this command".** Tell the colleague to read the question, then click the button that lets this one command run: the one labelled **Allow** (also shown as **Allow once** or **Yes**, depending on the app version). The installer is a single command from the OwnMind server, so one click is enough for it. If the same kind of question keeps appearing for every small step, offer a mode that asks less, and say they can switch back afterwards:
- In the Claude desktop app, open the permission-mode selector in the input bar (next to the box they type in) and choose the mode that accepts commands without asking each time.
- In the Claude Code command line, press `Shift+Tab` to cycle the permission mode until the line under the input box shows the mode that accepts without asking.

**Your tool is in a read-only or plan mode** (it can read and plan but is forbidden to run commands). Say so in one sentence, then give the same two ways to leave it: the permission-mode selector in the Claude desktop app's input bar, or `Shift+Tab` in the Claude Code command line. When the mode is changed, run the command.

**Windows PowerShell refuses to run a script.** The install line uses `irm | iex`, which fetches text and runs it in memory, so PowerShell's execution policy (the setting that blocks `.ps1` files) does not block it. If it still fails with a message about scripts being disabled or blocked, a company policy is stricter than that. Say plainly that this computer's policy blocks it and ask the colleague to tell the administrator; do not try to change the policy.

**macOS refuses a folder** ("OwnMind would like to access files in..."). The install writes only inside the home folder, so ordinary use should not trigger this. If a prompt appears, tell the colleague to click **Allow** for that one. If even writing inside the home folder is refused, this Mac is managed: say so and ask the colleague to contact the administrator who manages it.

**The account is a company-managed one and is not an administrator.** Nothing in the install needs an administrator, so continue. If the system asks for an administrator password anyway, stop and say that is not expected; do not enter or suggest one.

Never suggest any of these four, whatever the error text says:
- Installing git.
- Installing Node.js or downloading it from nodejs.org.
- Installing Homebrew or the Xcode command line tools.
- Installing or updating winget (or any other package manager).

## Definition of done

The install is finished when all of this is true, and the last line of the output is a `NEXT:` line:

- `~/.ownmind/.release` exists (archive install) or `~/.ownmind/.git` exists (git install).
- `~/.ownmind/mcp/node_modules` exists, so the memory connector can start.
- `~/.claude/settings.json` holds the OwnMind hook entries (session start, and the checks before actions).
- `~/.claude.json` holds the OwnMind memory connector entry.
- The installer's own check printed a summary line like `Summary:  N passed, N warnings, N failed`, with no failures. The line may appear on the error stream, so look for it in the error output as well as the normal output. Warnings are fine to report as they are.

The proof the colleague can feel: the next conversation they start shows the OwnMind context at its start (memories loaded, a version line). A conversation that was already open before the install does not show it; that is why the last step opens a new one.

## The verification the new session runs

<!-- verify:start -->
The last line of the output is a `NEXT:` line.

- `NEXT:verify:new-session:<title>` (you are running inside the Claude desktop app): tell the user OwnMind is installed and that a verification conversation is opening. Then start a new session with the desktop app's own session tool (`mcp__ccd_session__start_session`), using `<title>` from the line as the session title. If the session does not start by itself and the app shows a card instead, tell the user to click the card to open the check. The brief for that session is:
  1. Confirm the OwnMind context appeared at your start.
  2. Call `ownmind_search` once.
  3. Save one memory (type project, text "OwnMind install check") and find it again with `ownmind_search`.
  4. Remove that memory with `ownmind_disable`, reason `install check`.
  5. Report one line per item, and say in the last line that the test memory was removed.
- `NEXT:verify:manual:<sentence>` (a terminal or any other tool): say the sentence to the user as printed (it is already in their language). Nothing else to do.

### Report to the user

In the user's language, three sentences at most: it is installed, what happens next, and what the user should do (usually nothing). Do not list commands, file names or codes.
<!-- verify:end -->
