# v1.20.2 — Add a concrete ownmind_report_compliance call example to the hook failure message

## One-line summary

When the `recent_event_exists` check fails, the hook failure message should directly tell the AI how to call `ownmind_report_compliance` (including the correct `rule_title` and the key hint "do not pass `rule_code`"), to keep the AI from repeatedly hitting the same trap.

## Background

On 2026-05-26 while Vin was committing in another internal project, the two checks of the IR-025 hook (verification + code-review) kept blocking. The AI ran the superpowers skills, dispatched a reviewer subagent, and called `ownmind_report_compliance` twice, but the hook still blocked.

The problem only surfaced after pulling the actual compliance records:

| Time | Written event field | Reason |
|------|---------------|------|
| 05:12:43 | `IR-025` | AI's 1st call passed `rule_code='IR-025'`; `mcp/index.js:1082` hardcodes `event: args.rule_code || args.rule_title` → written as event=IR-025, but the hook is looking for event=verification |
| 05:13:05 | `verification` | AI's 2nd call passed only `rule_title='verification'`, no `rule_code` → `args.rule_code || args.rule_title` falls through to title → written as event=verification ✓ |
| — | — | AI missed the `event=code-review` call → hook keeps blocking |

The real source of the bug is `mcp/index.js:1082`: when MCP handles `ownmind_report_compliance` it hardcodes `event: args.rule_code || args.rule_title`, giving `rule_code` priority into event. `shared/compliance.js:43` does have a fallback `event = entry.event || entry.rule_code || ''`, but on the MCP path the event is already computed at line 1082, so that fallback in compliance.js never takes effect on this path.

The post-commit hook spelled it out clearly: `failures: ["code review not done yet, please complete the step for \"code-review\" first"]`. The hook logic is not broken — the AI just doesn't know how to call it correctly.

## Why the AI easily hits this trap

1. **The MCP handler implicitly prefers rule_code, with no way for the AI to notice**: `mcp/index.js:1082` writes `event: args.rule_code || args.rule_title`, giving rule_code priority into event. But the `inputSchema` of `ownmind_report_compliance` only says "report iron-rule compliance status", with fields `rule_title` + `rule_code`. The schema gives no hint that rule_code swallows rule_title, nor that you should write a semantic event name (verification / code-review).
2. **The hook error message only states the symptom, not the solution**: the original message "please complete the step for 'verification' first" gives the AI no idea how to "complete" that step.
3. **Running a skill does not automatically write compliance**: superpowers skills were run, subagents were dispatched, but these actions are not wired to the OwnMind compliance recording mechanism.

## In scope

- Change `FIX_HINTS.recent_event_exists` in `shared/verification.js` so the message contains a full call example plus the hint that rule_code must not be filled in
- Add a reproduction test to `tests/verification.test.js`
- Update CHANGELOG / FILELIST / package.json / SERVER_VERSION versions (IR-008 / IR-031)
- Sync the README tri-language versions if they mention the hook message format (IR-032)

## Out of scope

- ❌ Root-cause fix: delete `args.rule_code || args.rule_title` at `mcp/index.js:1082`, or add an `event` field to the schema so the caller can specify it directly (medium cost, leave as backlog)
- ❌ Automatically detect skill / subagent launch and write a compliance record (high cost, leave as backlog)
- ❌ Fix for the bug_report flow not getting a fingerprint on the hook-failure path (separate bug, leave as backlog)
- ❌ Renumbering the admin-pages / super-pages / legacy-retire stub proposals (mutually independent, leave for Vin to handle when starting them)
- ❌ Syncing the README tri-language version markers to v1.20.2 (existing stale; v1.20.0→v1.20.1 was not synced either, handle in a separate commit)

## Version decision

This proposal is versioned v1.20.2, sharing the v1.20.2 prefix with the stub `v1.20.2-admin-pages`. Reasons:

- This is a patch-level bug fix, not feature work like admin-pages
- admin-pages is still a stub (status: stub, pending expansion after the v1.20.1 release), not actually tied to a release
- This hotfix takes the v1.20.2 number first; admin-pages can decide whether to bump itself later when it starts

## Risks

- **MCP schema not changed, AI may still mistakenly pass rule_code and trigger the fallback**: the hint is a workaround, not a root-cause fix. A follow-up backlog can add an `event` field to the schema to fix it for good.
- **An already-installed local hook message will not auto-update**: it requires the user to upgrade OwnMind to get it. Vin can manually sync `~/.ownmind/shared/verification.js` locally.

## Follow-up patch #3 (within the same version, no separate version number)

Alice (another AI session) reported a bug: rule IR-036 says "if the context already explained it, may keep as-is", but the lint code did not implement term memory. Terms explained earlier in the same session still got blocked in later replies, blowing up the user's rewrite cost.

Took the chance to wire up and fix the whole bug report flow:

1. **Add term memory to lint**: `checkJargonExplanation` + `lintReply` add a second parameter `historicalCorpus`; the lint hook extracts all prior-turn assistant text from the transcript and feeds it in.
2. **Both hook failures carry a bug report path**: lint hook + pre-commit hook failure stderr add `bug_fingerprint:` + `suggest_report: true`; the AI can submit a bug report once it has the fingerprint.
3. **Register 3 new fingerprints**: `lint_context_memory_missing` / `lint_hook_no_suggest_report_path` / `mem_iron_rule_blocking_commit_no_fingerprint`.

See the CHANGELOG v1.20.2 follow-up #3 section for the fix list. Tests `npm test` 1923/1923 all green.

## Follow-up patch #2 (within the same version, no separate version number)

While working, Vin hit the UX pain point of "every time I write OwnMind I have to init to get a token first, otherwise 409". The AI also hit it 3 times in a row during this work.

**Root cause**: `sync_token` is designed to prevent stale writes (plain English: prevent overwriting with outdated data), but is too strict for "user has multiple AI sessions open at once". During this session active_handoff jumped from id=68 to id=70, indicating another session created a handoff and bumped the token, invalidating this session's token.

**Fix**: the MCP-side callApi function automatically intercepts the 409 sync_token error → hits the lightweight endpoint GET /api/memory/sync-token to get a new token → retries once. Transparent to the AI.

**Changes**:
- `mcp/lib/sync-token-retry.js` (new): two pure-function helpers, independently testable
- `mcp/index.js`: callApi adds `_retried` to prevent infinite loops, adds `refreshSyncToken()` lightweight endpoint call
- `tests/auto-retry-sync-token.test.js` (new): 17 cases covering safeguards like GET not retried / 500 not retried / non-sync_token message not retried

**Limitations**:
- Retries only once
- Only for write operations (not GET / HEAD)
- The message must contain the sync_token keyword

## Follow-up patch #1 (within the same version, no separate version number)

After the main fix went live, real-world testing (after 2026-05-26 commit `de3a74f`) revealed a side-effect bug:

**Symptom**: the MCP tool `ownmind_report_compliance` returns `status: blocked`, yet the pre-commit hook lets the same commit through. The hook message is exactly the new hint from this main fix (plain English: the fix itself works in production, but also happens to expose the problem more clearly).

**Root cause**: the autoComply at `mcp/index.js:1090-1129` (plain English: the mechanism that re-runs the hook check after a compliance call) uses the in-memory variable `complianceEvents`. `ownmind_init` resets it to zero, and a session restart clears it. The pre-commit hook reads from the file `~/.ownmind/logs/compliance.jsonl`, unaffected by session restarts. The two data sources are inconsistent → behavior is inconsistent.

**Evidence**: the session log shows session_id switching from `1779774294945` to `1779778052749`; the compliance record jsonl still had two fresh comply entries, but autoComply, because the in-memory variable was reset, falsely judged block.

**Fix** (within the same v1.20.2 version, no separate version number):
- `mcp/index.js`: inside autoComply, merge the in-memory variable with the file (`[...complianceEvents, ...readComplianceEvents()]`). Treat the file as the single reliable source; the in-memory variable is only a cache for the current session (plain English: temporary store).
- `tests/auto-comply-reads-file.test.js`: add 3 cases guarding the design contract.
- No helper extracted (plain English: a small independently-testable function): weighing simplicity vs a strict reproduction-test red/green cycle, chose the former; the test follows a "design contract + counter-evidence" style rather than strict red/green. Noted in the commit message.
