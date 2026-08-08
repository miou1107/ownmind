# v1.26.95 — Proposal: every field the shell hooks logged was discarded on arrival

## Background

`log_event` in both shell hooks takes key/value pairs and builds a JSON line:

```sh
extra="$extra,\"$1\":\"$val\""
local entry="{\"ts\":\"$ts\",\"event\":\"$event\",\"tool\":\"claude-code\",\"source\":\"hook\"$extra}"
```

and posts that same object to the batch endpoint:

```sh
-d "{\"events\":[$entry]}"
```

The handler at `src/routes/activity.js` reads exactly one place for the payload of an
event — `e.details` — and stores it. `details` was never present, so every row landed with
`{}`.

The local file on the user's own machine had the answer. The server, which is where anyone
would actually look, did not.

## What it cost

Measured on production, 2026-08-07, last 14 days:

| user | `update_failed` rows | rows carrying any detail |
|---|---|---|
| Phoebe | 18 | 0 |
| Michelle | 9 | 0 |
| Vincent | 2 | 0 |

`hooks/ownmind-session-start.sh` distinguishes six failure steps — `lock`, `cd`, `fetch`,
`pull`, `npm`, `update_sh` — and logs which one it was. None of that reached the server, so
"Phoebe's upgrade has failed 18 times" was the entire available picture, with no way to ask
why without going to her machine.

The same silence covers `iron_rule_trigger` (which trigger fired), `init` (status), and the
`edit_reminder_failed` event added one release earlier in v1.26.92 — a failure channel that
was born already broken.

## What this changes

`log_event` nests its pairs under `details`. That is the whole fix; no server change is
needed, because the server has always read the right key.

## Compatibility

A client that has not upgraded keeps sending flat fields, and those keep being dropped —
exactly as today, no worse. Nothing reads the flat keys: the insert takes `ts`, `event`,
`tool`, `source`, `details`, `client_event_id` and ignores the rest, and the only local
reader of a `.jsonl` (`flush-pending-banners.js`) reads a different file.

## Why it stayed hidden

The event name was always right. A dashboard counting failures by event worked perfectly;
only the answer to "which step" was missing, and nobody asks that until somebody's upgrade
starts failing repeatedly. Phoebe's did, 18 times, and there was nothing to look at.
