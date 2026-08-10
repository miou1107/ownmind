# v1.26.137 — Proposal: a report that existed for one of its three ranges

## What was measured

Production, 2026-08-10. `GET /api/me/narrative/insights`, the AI half of the 整體分析 page:

| range | result | request body |
|---|---|---|
| `7d` | 200, 3.6 s | 32,372 bytes |
| `14d` | **502**, three consecutive calls | 47,893 bytes |
| `30d` | **502** | 52,842 bytes |

Server log: `LLM upstream 502: All 3 provider attempts failed: groq/llama-3.1-8b-instant:
413 Payload Too Large; groq/llama-3.3-70b-versatile: 413; mistral/mistral-small-latest: …`

The ceiling was measured rather than assumed, one request every 20 seconds so that rate
limiting could not be read as a size limit: **39,600 bytes goes through, 41,025 comes back
413.** 40 KiB.

A first attempt at this measurement produced a non-monotonic result — 20,000 characters
passing while 8,000 failed — because the probes were fired back to back and were being
rate limited. Pacing them removed it entirely. Recorded here because the wrong reading was
convincing.

## Why

`/insights` sends the whole mechanical report as one user message. Its size grows with the
range, and two of the three ranges the page offers have been over the ceiling.

Where the bytes are, at 30 days: `project_friction_raw` 23,366, `compliance` 9,861,
`versions` 5,921, everything else under 3,600 combined.

## What changes

The payload is condensed before it is sent, and only when it needs to be. Each step
re-measures and stops the moment it fits, because the cheapest step that works loses the
least. A 7-day report is inside the budget and goes out untouched.

The order is by information density, not size:

1. **Long friction notes are truncated**, none deleted. They are prose; the first sentences
   carry the point.
2. **Compliance rows with nothing to report are dropped**, with a count left behind. A rule
   everybody followed is the least informative row in the file.
3. **The version list is collapsed to one row per machine, keeping the OLDEST version seen
   on it.** That section is read to find who is behind; keeping the newest would hide
   exactly that.
4. **Last resort: trim whatever the largest list currently is**, recording how many rows
   were left out. This covers a section nobody anticipated growing — without it, such a
   section passes every targeted step, comes back over budget, and is sent anyway, which is
   the 502 this change exists to remove.

The budget is 38,000 bytes: under the 39,600 that was measured to pass, and above the
32,372 of the 7-day report so that the one range that always worked is not condensed for
nothing.

Whatever was condensed is returned to the page and included in the model's input, so a
summarised report is not read as a complete one.

`buildRequestBody()` is extracted so that the size being checked and the body being posted
are produced by the same function. A check measuring anything other than what the upstream
receives is measuring a number nobody enforces.

## What this does not change

The mechanical report (`GET /api/me/narrative`) is untouched — it never went near the LLM
and always worked for every range. The 7-day insights output is byte-for-byte what it was.

## What this does not fix

The upstream error is truncated to 200 characters before it is logged, which cut off why
the second and third providers failed; diagnosing this needed the request replayed by hand
from the server. Widening it is a separate, one-line change and is not in here.
