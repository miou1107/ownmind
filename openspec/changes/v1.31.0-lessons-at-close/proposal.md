# Lessons at close

## Why

The team standard "update every layer when you learn something" asks that a lesson learned
in a session — where it got stuck, what unstuck it, what to do differently — be written down
where the next person and the next AI will find it. Measured against the memory table, that
almost never happens: the AI calls `ownmind_log_session` with a one-line summary and the
conversation ends. The summary says what was done. The part worth keeping is lost with the
transcript.

Vin's framing (2026-10-03, while weighing a task board for the team): a board is not the
point; the close of a task is the one moment somebody has the lesson in hand, and OwnMind's
job is memory. So the close itself should ask.

## What changes

1. **`ownmind_log_session` takes `lessons`.** A list of `{ stuck, fix, next_time }`, or bare
   strings for `stuck` alone. Optional — requiring it would discard the whole session record
   to protect a list the AI may honestly have nothing to put in, the trade v1.26.61 refused
   for `model`. `shared/session-lessons.js` normalises it on both ends.
2. **A `session_lessons` table.** One row per lesson, `new` until resolved. A lesson is not a
   memory: it waits for the person.
3. **Three endpoints under `/api/session/lessons`.** List mine; promote one (creates a
   `project` memory with the three answers kept apart, same secret scan as every memory
   write); dismiss one.
4. **A page, 學到的, under 我的.** The waiting list with two buttons per row.
5. **The session-start context says how many are waiting**, and the tool's answer, when no
   lessons were passed, says so in one line. Both are reminders and nothing more; see
   Decisions.
6. **The AI instructions** (`configs/CLAUDE.md`, `configs/ownmind-rules-block.md`) tell the AI
   to pass lessons at close.

## Decisions

- **The AI cannot promote.** It can only report. Promotion is a click on the page. A memory
  table that fills itself from every session is a log, and a log is what the AI already
  fails to read.
- **Reminders are declared as reminders.** The context line and the tool notice raise the
  odds the AI passes lessons; they do not make it. The product principle says a feature that
  only reminds must say so. The enforcing half — refusing a close with no lessons — was
  considered and rejected for the reason in point 1 above. What *is* enforced: a lesson that
  quotes a secret is never stored and never promoted.
- **Secrets are refused at both doors.** POST /api/session drops a lesson that fails
  `detectSecretLike` and reports the count; promote refuses with the rule name and no text.
- **A lesson keeps its project.** `details.project` from the same call, so the page can group
  and the memory title can be prefixed.
- **Old servers, new clients and the reverse.** A client sending `lessons` to a server without
  this release: the field is ignored and the session is still logged. A server with this
  release and an older client: `lessons` absent, nothing changes. The init endpoint counts
  waiting lessons inside a try/catch so a database without migration 027 still answers.

## Not in scope

- Team-wide visibility of lessons (an admin seeing everyone's). The row is personal; a
  promoted memory follows the memory table's own visibility rules.
- Automatic promotion by any rule. Deliberately.
- The three later changes that grew from the same conversation: collision warning
  (v1.31.2), tasks the AI picks up (v1.31.3), release check (v1.31.4). Each has its own folder.
