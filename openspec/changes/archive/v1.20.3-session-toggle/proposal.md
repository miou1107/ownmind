# v1.20.3 — Session temporary off switch (/ownmind-off / /ownmind-on)

## One-line summary

Add two slash commands so the user can temporarily disable OwnMind's two hooks (reply quality lint + pre-commit check) within the current session, without being blocked. While disabled, remind the user every 10 AI response turns that "OwnMind is currently off", to avoid forgetting to re-enable. A new session automatically invalidates it (plain English: starting a new conversation auto re-enables it).

## Background

During development the user (Vin) sometimes finds the OwnMind hooks too strict or falsely blocking (e.g. IR-036 / IR-037 lint in a row, or the pre-v1.20.2 IR-025 too-strict commit blocking). The user wants a temporary switch to "leave it for now, re-enable later".

But there is also the worry: after turning it off, forgetting to re-enable, and unknowingly going long-term without hook protection. So a "periodic reminder" mechanism is needed.

## In scope

- New state file `~/.ownmind/state/session-off.json` containing the current `session_id` + `off_at` timestamp + `tick_count` counter
- New helper module `shared/session-off-state.js` (pure functions, zero external dependencies)
- Two new MCP tools: `ownmind_session_off` / `ownmind_session_on`
- Change `hooks/ownmind-reply-lint.js`: read the state file at the start; if this session is already off, tick + skip, and every 10 turns use `writeToTty` to write a terminal reminder
- Change `hooks/ownmind-git-pre-commit.js`: read the state file at the start; if this session is already off, skip + print a hint + allow the commit
- Two Claude Code slash command files (`~/.claude/commands/ownmind-off.md` + `ownmind-on.md`)
- Cross-session invalidation logic: if the `session_id` in the state file does not match the current session → treat as invalid, auto-ignore

## Out of scope

- ❌ Disabling the MCP tool layer (C): kept; the user's /ownmind-on still relies on MCP to re-enable
- ❌ Disabling SessionStart loading (D): kept; the AI still knows OwnMind exists
- ❌ Persistent off (across sessions): deliberately not done; a new session always re-enables, to avoid long-term lack of protection
- ❌ Fine-grained off (turn off only IR-036 but not IR-037): kept as future backlog

## Version decision

v1.20.3, continuing the v1.20.2 series, sharing the version prefix with v1.20.2's stub `v1.20.2-admin-pages` / `v1.20.3-super-pages` but with no folder-name conflict (this one is `v1.20.3-session-toggle`, the other is `v1.20.3-super-pages`). The stub `v1.20.3-super-pages` has not started; Vin can decide whether to bump it later when starting it.

## Risks

- **TTY echo failure fallback**: `writeToTty` will fail in some environments (CI / no TTY), falling back to stderr. But messages written to stderr are seen by the AI, not the user. By design both paths should be attempted.
- **State file race condition**: multiple hooks reading/writing the state file at once may conflict. Low probability in practice (rare), not handled for now.
- **session_id unavailable**: the pre-commit hook is not inside a Claude Code session and cannot get the session_id. Mitigation: the pre-commit hook only checks whether the state file exists + whether `off_at` is "recent" (e.g. within 24 hours), without strictly comparing session_id.
