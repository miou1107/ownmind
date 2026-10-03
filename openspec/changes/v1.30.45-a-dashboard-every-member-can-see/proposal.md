# A dashboard every member can see

## Why

Vin built a Claude Code mod, `ownmind-monitor`, on his own machine: a footer button
(🟢 OwnMind / 🔴 OwnMind) that opens a pane showing whether OwnMind's memory reached this
conversation, how often the AI consulted it, what the rule hooks triggered and blocked, and
seven days of history from `~/.ownmind/logs`. It is red only when the memory never loaded in
this conversation or the last call to the OwnMind server failed.

It exists only in `~/.claude/mods/ownmind-monitor` on one Mac. Vin decided (2026-10-03) that
every OwnMind user gets it, enabled by default, so the whole team runs it and reports what is
wrong with it — and that his later changes to the mod must reach everyone through the normal
OwnMind auto-update, with nobody doing anything by hand.

## What changes

1. **The mod moves into this repository** at `mods/ownmind-monitor/`. Every machine's
   `~/.ownmind` is a clone of this repository, so the mod is already on disk after the next
   pull, and every later edit to it arrives with every pull after that.
2. **Windows support in the mod.** It read the home folder from `HOME` only. Windows may have
   no `HOME`, or a Git Bash form (`/c/Users/x`) that native file calls cannot open. It now uses
   `USERPROFILE` in those cases, and builds paths with the separator the home folder uses.
3. **One helper, `scripts/install-helpers/ensure-monitor-mod.cjs`, edits `settings.json`**,
   called from `install.sh`, `scripts/update.sh`, `install.ps1` and `scripts/update.ps1`. It
   adds `~/.ownmind/mods/ownmind-monitor` to `env.CLAUDE_CODE_PLUGIN_DIRS` (':' on macOS/Linux,
   ';' on Windows) and sets `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` to `"1"`. Because the
   updaters run after every auto-update pull, existing machines get it on their next update,
   not only on a fresh install.
4. **Migration.** An entry pointing at the hand-installed copy
   (`~/.claude/mods/ownmind-monitor`, tilde or expanded) is replaced in place by the
   checkout's path, so the mod is not loaded twice.
5. **Opt-out.** `~/.ownmind/.no-monitor-mod` makes the helper remove its own entry and leave
   everything else alone, on this and every later update.

## Decisions

- **Settings `env`, not a marketplace install.** `CLAUDE_CODE_PLUGIN_DIRS` loads a folder
  straight from disk, read from `~/.claude/settings.json` (never project settings). That folder
  is inside the OwnMind clone, so the mod follows `git pull` with no versioned plugin cache in
  between.
- **`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is forced to "1".** Function hooks are the early-access
  switch the mod needs. Vin chose default-on for everyone; a member who wants it off uses the
  opt-out file, which is what the next update respects.
- **Other plugin folders are kept, in order, de-duplicated.** Only entries that name this mod
  are rewritten.
- **No write when nothing changes**, so a daily update does not touch the file.
- **The folder must exist.** If the checkout has no `mods/ownmind-monitor` the helper writes
  nothing, so Claude Code is never pointed at a missing folder.

## Not in scope

- Deleting the hand-installed copy at `~/.claude/mods/ownmind-monitor`. Only the settings entry
  is migrated; the folder is the user's.
- Older Claude Code versions without function hooks: they ignore the two variables, so those
  members see no button and nothing else changes.
