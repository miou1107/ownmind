# v1.26.87 — Proposal: a failed check reaches Vin without being asked for

## Background

Every install, upgrade and daily auto-update runs a self-check and uploads the result to
`install_check_logs`. Production holds **393 reports, 9 users, 13 machines, 2026-05-08
through 2026-08-06**. Nothing reads them.

`grep install_check_logs src/ client/ mcp/ hooks/` returns the migration and nothing else.
The only writer is `POST /api/debug/install-check`; there is no reader, no page, no alert.

Twice in one week that cost real time:

- Adam's report has carried `memory_load: fail` with `bash_is_wsl: true` and the exact
  explanation — "`bash` on this machine is the WSL launcher, whose home directory is not
  this one" — since May. The answer to "why do six Windows machines never load memories"
  sat in the database for two months while the question took a week of hand-digging.
- Adam's May report also showed the credentials lookup failing. Nobody saw that either.

Vin, 2026-08-06, stating the requirement: 「每次在安裝、升級的時候都要做完整的檢測，檢測
如果有問題就要自己 repair 並且回報給 ownmind 做紀錄，讓開發者可以分析問題並發新版解決。
這樣才是完整閉環」.

Of that loop, detect / repair / report / release are in place. **Analyze is the broken
link**, and it is this proposal.

## Decisions (Vin, 2026-08-06)

| question | decision | rejected alternatives |
|---|---|---|
| where does the alert land | a broadcast targeted at Vin alone; his AI tells him at the start of a conversation | email, Telegram, dashboard-only |
| when does it fire | only for a **new** failure: one that has not been reported since it last passed. A failure already running when this ships counts as new and surfaces once | daily digest of everything currently red; daily digest regardless of state |
| scope of this release | push only, with enough detail in the message to act on | push plus an admin page; admin page first |

## Why evaluate on ingest rather than on a schedule

The set of failing checks changes only when a new report arrives. Evaluating at that moment
is both the most immediate option and the one with fewest moving parts — no cron, no
polling, no second code path that can rot unnoticed (which is the defect class this whole
release is about). A nightly job would add up to 24 hours of delay for no gain.

One sweep runs at server startup as well, so the 393 reports already in the table are
evaluated once rather than waiting for each machine to check in again. The state table makes
it idempotent, so a redeploy does not re-announce anything.

## Scope

**In:**

- A state table recording which (user, machine, check) failures have been announced.
- A pure evaluator: latest report per machine + announced state → new failures, resolved failures.
- Rollup: identical failures across machines collapse into one line.
- A broadcast composed from the result, targeted at the oldest `super_admin` (the same
  attribution `nightly-upgrade-reminder` already uses).
- Fixing two literal NUL bytes in `src/routes/debug.js` (see below).

**Out, deliberately:**

- `warn` items. Today's warns include "the key is only in the environment", which Vin has
  decided not to repair; alerting on it trains the reader to ignore the channel.
- Recovery notices. Good news does not need to interrupt.
- The admin page. Deferred until the push proves whether a page is still wanted.
- Any change to the self-check itself.

## The NUL bytes

`src/routes/debug.js` contains two raw NUL bytes, at lines 73 and 81, inside comments that
explain how the route strips NUL bytes out of client payloads. `file` reports the source as
`data`, and `grep` treats it as binary and prints nothing — so a search of `src/` for
`install-check` or `install_check_logs` comes back empty and reads as "this endpoint does
not exist". That is the same failure mode as the rest of this release: information present,
invisible to whoever goes looking. The route is being edited here anyway.

## Risks

- **The first broadcast is long.** Every historical failure surfaces at once. Broadcast
  bodies are capped at 2000 characters, so the message must truncate explicitly and say how
  many items it dropped — a silent cut would recreate the defect being fixed.
- **A noisy check would spam.** Mitigated by keying on (user, machine, check): a failure is
  announced once and stays silent until it passes and fails again.
- **Alerting must never break an upload.** Evaluation runs after the row is committed and
  its failures are swallowed and logged; a self-check report is still stored if alerting
  throws.
