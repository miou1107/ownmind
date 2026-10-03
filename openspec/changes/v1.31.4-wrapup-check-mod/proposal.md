# Wrap-up self-check mod, shipped to every member

## Why

Team standard 723 lists six things to check before a session ends: unmerged or local-only
branches; unpushed, unpulled or stashed commits; version numbers and a deploy that did not
happen; verification that was skipped and docs that did not move; test environments left
running; todos and handoffs nobody picked up. The standard reaches the AI at session start.
Reaching is not reading: on 2026-08-16 the AI answered "收工" with a goodbye and ran none of
the six, and the next day a test database had been running for 14 hours and a handoff had
waited ten days (OwnMind memory project 955). The standard is the kind of thing OwnMind
exists to enforce, and in its own repo it was not enforced.

Vin built a Claude Code mod on 2026-10-03 that runs the six checks itself the moment the
word is typed, and wants every member to have it. This proposal ships it the way the
monitor mod shipped in v1.30.45.

## What changes

1. **`mods/wrapup-check`** — a function-hooks plugin. When the prompt contains 收工, 收尾,
   下班, 交接 or "wrap up", or the user runs `/wrapup`, it runs the six checks with git,
   `docker ps`, `lsof` and the session's own records, opens the pane "OwnMind 收工自我檢查"
   (desktop: three number cards and six colored tiles drawn as one SVG, then the red and
   yellow items in full; terminal: a summary line, a colored bar, one row per check that
   expands on press), and appends the text result to the prompt's context so the model
   answers from it. The residue check compares against a snapshot taken at session start,
   so only what this session added counts; containers started by another project's
   `docker compose` are excluded through their working-directory label.
2. **`scripts/install-helpers/ensure-monitor-mod.cjs`** now manages a list of mods
   (`ownmind-monitor`, `wrapup-check`) instead of one. Each gets its own opt-out marker
   (`~/.ownmind/.no-monitor-mod`, `~/.ownmind/.no-wrapup-mod`) and is removed on its own
   when its folder is missing. The output line lists one status per mod. The file name is
   unchanged so update scripts of older checkouts keep working.
3. **Installers and updaters** print "OwnMind mods:" instead of "OwnMind monitor mod:".

## Decisions

- **The checks run before the model answers, not after.** The 2026-08-16 failure was the
  model deciding the word was a goodbye. A `prompt.submit` hook does not decide anything:
  the word is in the prompt, the checks run, the result is in the context.
- **Only three of the six are judged by the mod.** Branches, sync and residue are facts the
  mod can establish. Version, verification/docs and handoffs end in "for you to
  judge" (the version row compares files with tags and says that the server is not checked): the mod shows what it found and the model is told to query OwnMind for open
  handoffs. Claiming more would be the kind of green light that is not one.
- **Chinese strings, English code.** The strings mirror a Chinese team standard and the AI
  answers the user in Chinese (configs/CLAUDE.md); comments and identifiers follow the
  repo's English-code rule.
- **One helper, one output line.** Two helpers would have meant two chances for the
  installer to miss one. The single-mod export `ensureMonitorMod` stays for callers that
  still use it.

## Not in scope

- Reading OwnMind's handoff list from inside the mod (no API from a plugin; the model
  does it with the MCP tool).
- Windows listening-port detection (`lsof` is not there; the check reports nothing).
- Localizing the pane strings (the monitor mod's are not localized either).
