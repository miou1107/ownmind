# v1.26.74 — 最近活動 means the last thing the person did

## What Vin saw

2026-08-06, working in Claude at the time, and 團隊用量 said his last activity was 00:20 —
eight hours earlier.

The number was right. The meaning was wrong.

## Why

`last_active_at` was `MAX(session_logs.created_at)`. A `session_log` is written only when
the AI calls `ownmind_log_session`, and that tool's own description says it happens
"before a conversation ends". So a long working session displays the time it **started**
and does not move again until it finishes. The longer somebody works in one sitting, the
more wrong the column gets — which is exactly backwards.

`統計儀表板` had the same defect in a milder form: `MAX(activity_logs.ts)`, which moves
only when the AI calls an ownmind tool, and a long coding session may never call one.

## The choice

Rename the column to 最近記錄, or fix what it reads. Vin chose to fix the data on
2026-08-06, and the reason holds: renaming would be accurate and would still leave nobody
able to see who is working right now.

## The fix

Three sources, three different delays, and the newest of them is the honest answer:

| source | lands when |
|---|---|
| `session_logs` | a conversation ends |
| `activity_logs` | the AI calls an ownmind tool |
| `token_events` | the scanner uploads — the only one that moves mid-session |

`token_events.ts` is the **message** timestamp, not the upload time, so the scanner's
30-minute schedule delays when the value becomes visible, never what it says.

Postgres `GREATEST` ignores NULLs and returns NULL only when every argument is one, so a
member with nothing in one source simply does not contribute to it.

Both pages now read the same three. Two pages answering one question with two numbers is
its own defect — backlog item 7 is that shape already.

## What is deliberately unchanged

Who appears in 團隊用量 is still decided by `JOIN session_logs`. What the timestamp means
and who the page is about are separate questions, and widening the join would quietly
change the second one while claiming to fix the first.
