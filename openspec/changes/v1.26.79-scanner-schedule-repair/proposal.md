# v1.26.79 — The auto-update path must repair a dead scanner schedule

## Why

Usage collection depends on a scheduled job that runs every two hours and reads the local
databases. It is registered once, at install time. Nothing ever looks at it again.

When it dies, nothing says so. The dashboard renders the person's usage columns as
`尚無資料`, which is indistinguishable from "this person did no work".

Measured on production 2026-08-06. Adam's `collector_heartbeat` rows:

```
tool          machine  os     version   last_reported
claude-code   after    win32  1.26.67   08-06 11:36   ← written by the MCP
antigravity   after           1.26.29   07-15 13:54   ← written by the scanner
codex         after           1.26.29   07-15 13:54
cursor        after           1.26.29   07-15 13:54
opencode      after           1.26.29   07-15 13:54
```

His MCP was alive the entire time: `activity_logs` shows `update_applied` that same
morning at 09:03, and `update_skipped` 156 times over the month. Files were being upgraded
daily. Only the schedule was gone, and it had been gone for three weeks. His last
`token_events` row is 2026-07-15.

Amiee Kuo has the same shape: scanner rows frozen at 1.26.26 since 07-27, last token event
2026-05-05.

## The part that makes this worth its own release

**The repair already exists and cannot reach the people who need it.**

`scripts/interactive-upgrade.ps1:195` re-registers the scheduled task, and the comment
written above it in v1.26.65 names this exact user: 「Adam 因此斷了二十天」.

But only `bootstrap.ps1` calls `interactive-upgrade.ps1`, and `bootstrap.ps1` is something
a person types by hand. Nobody types it. The path that actually runs on these machines,
every day, is `mcp/index.js` → `git pull` → `update.ps1` / `update.sh`, and neither of
those scripts has ever looked at the schedule.

A fix built for a failure, sitting on a road that failure never travels, is not a fix.

## What changes

1. **`ensure-scanner-schedule.sh` / `.ps1`** — new. Ask the OS whether the schedule is
   alive; if not, put it back; then ask the OS again. Idempotent: a healthy schedule is
   left untouched, so the normal path costs one query.
2. **`update.sh` / `update.ps1`** call it on every auto-update. Because `mcp/index.js`
   pulls *before* it runs these scripts, the repair reaches a user on the very next
   update, not the one after.
3. **A failed repair is reported to the server.** The defect being fixed is a failure
   nobody hears about; a repair that fails quietly reproduces it exactly.
4. **`install.sh` verifies its own registration** on macOS and Linux. Windows has done
   this since v1.17.12; the Unix branches only ever checked whether the register command
   returned an error.

## Explicitly not in scope

- **Backfill.** The three weeks of Adam's usage are gone. Nothing reconstructs them.
- **Restructuring `install.sh`'s registration.** Its `launchctl unload` → `load` pair is
  the delete-then-create shape v1.26.65 removed from Windows, and it is a real hazard.
  But install-time registration must overwrite an existing agent, and rewriting that is a
  wider change than this one. Verification is added so the failure becomes visible; the
  restructure is recorded, not attempted here.
- **Why schedules die in the first place.** This restores them. It does not explain them.
  The server-side report exists so that the frequency becomes measurable rather than
  guessed at.
