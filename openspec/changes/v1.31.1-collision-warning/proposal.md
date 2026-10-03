# Collision warning

## Why

GitLab knows who claimed which issue. Nothing knows who is editing which folder *right now*,
and the collision happens before anyone commits: two people spend a day in the same module
in two AI conversations, and the merge is where they find out. A board cannot show this,
because the work is invisible until it is pushed. The only thing that sees it is the hook
OwnMind already runs before every file edit on every member's machine.

Vin, 2026-10-03: of the four uses that grew out of the task-board conversation, this is the
one no existing tool covers.

## What changes

1. **The edit hook reports where it is.** `ownmind-iron-rule-check.js`, on its edit branch,
   already has the file path. It sends the *project name and the directory* (never the file
   name, never the full path — the directory name is work context, the path is where someone
   keeps their files, the line v1.26.98 drew) to `POST /api/activity/touch`, with the
   session id. One request per directory per session per 10 minutes, cached in
   `~/.ownmind/state/touches.json`, so a burst of edits costs one round trip.
2. **The server keeps a short memory of touches.** `edit_touches` (user_id, project, dir,
   session_id, last_seen), upserted, rows older than 24 hours ignored by every query and
   deleted by the existing daily cron.
3. **The answer names who else is there.** The same request returns every *other* member
   who touched the same project and directory in the last 2 hours: name, how long ago, and
   their session's project. The hook prints one line as `additionalContext`:
   `OwnMind: Amiee is also editing order/ in idaytour (12 minutes ago). Mention it to the
   user once.` — once per (member, dir) per session, so it does not nag.
4. **A line on the team stats page** (`/team/stats`, admin+): overlaps in the last 24 hours,
   so a lead can see the pattern without being in the conversation.

## Decisions

- **Reminder, declared as such.** The hook does not block the edit. Two people in one folder
  is often correct (a refactor and a bug fix). What is enforced is only that the line is
  printed when the overlap is real.
- **Directory, not file.** A file-level signal would be more precise and would send the file
  name — a name like `payroll-export.js` is already information. The directory is the unit
  people reason about ("the order module") and is coarse enough to leave out.
- **Opt-out per person.** `~/.ownmind/.no-touch-report` stops the hook sending; the person
  then also receives no warnings. Both halves go together on purpose.
- **Fail-open.** Server unreachable, table missing, anything: the edit proceeds and a line in
  the hook log says the check did not run (the v1.26.87 rule — a guard that stopped guarding
  must say so).
- **No history.** Touches are not an audit trail; they are a 24-hour window and nothing
  reads them after that. The team page shows overlaps, not a per-person timeline.

## Not in scope

- Branch-level conflict detection (comparing diffs). That is git's job at merge time.
- Blocking edits. Never.
- Members outside the OwnMind team (the hook only knows OwnMind users).
