# v1.26.148 — Proposal: a tip that names the standards you can actually ask for

Issue #85. Every OwnMind response ends with one line of tip, and one of the 25 in the pool
says:

> OwnMind has team standards: every member's AI follows the same rules automatically, so
> nobody breaks them by accident

That announces a mechanism. It does not tell a member a single thing they can go and do.

The case that opened the issue, 2026-08-11: a team standard for publishing a page to
`pages.fontrip.com` was uploaded, and from then on any member's AI would carry out the whole
flow if they said 「幫我發 pages」. **Unless somebody told them out loud, no member would ever
learn that.** The tip line is the only surface the product speaks on every day, and it was
spending that surface on the existence of the mechanism.

## Why the tip cannot simply read the titles aloud

The issue's first draft did exactly that. Rendered against the real account it produces:

```
Tip: 你們公司有一條規範「發布網頁到 pages.fontrip.com」，直接開口叫我做就行
Tip: 你們公司有一條規範「不要 blind edit」，直接開口叫我做就行
Tip: 你們公司有一條規範「pages 發布工具 pages.py 全文（配合「發布網頁到 pages.」，直接開口叫我做就行
```

Two problems, both measured on the production account (32 standards, 2026-08-12):

| kind | example | count | worth saying? |
|---|---|---|---|
| discipline — how the AI works | 不要 blind edit, 修 bug 先寫重現測試 | 17 | no — nobody asks for it |
| content — what the AI reads | pages.py 全文, 各種重點摘要 | 8 | no — not written for people |
| capability — what a user can ask for | 發布網頁到 pages.fontrip.com | 6 | yes |

So five titles in six are noise. And a title is not a line of copy: it is written to be
recognised by whoever manages the standards, which is why one of them reads
「pages 發布工具 pages.py 全文（配合…」 and gets cut off mid-parenthesis.

`trigger:` tags do not rescue it either — they hold keywords like `pages`, `commit`, `deploy`,
not the sentence a person would say.

## What changes

**A standard says both things itself**, and neither is inferred:

```
metadata.user_invocable  : true          — a user can ask for this by name
metadata.invocation_hint : "想把東西變成網址傳給人看？直接說「幫我發 pages」"
```

Where an account has standards carrying both, those sentences take the place of the static
team-standard tip. Where it has none, **nothing changes for anyone** — the pool is what it was.

### Four decisions inside that

**1. The flag without the sentence is refused at write time.** `POST /` and `PUT /:id` return
400 with the sentence to write. Marking a standard without a hint would degrade to reading its
title aloud, which is the failure this pair exists to prevent — and it would be discovered by
whoever saw the tip, not by whoever set the flag.

**2. It replaces the static tip rather than joining the pool.** A company with six invocable
standards would otherwise turn a 25-line pool into 31 lines of which 6 are its own; a company
with twenty would drown the product's own tips. Replacement keeps the proportion fixed at one.

**3. The list travels on the init response, in compact mode too.** `GET /api/memory/init`
gains `invocable_standards: [{ id, title, hint }]`, computed from the team standards it
already loads. It is deliberately not behind `!compact`: every caller asks for compact, and
v1.26.141 was the bug where a payload half nobody received looked correct in the source.

**4. Two builders, not one clever one.** `buildInvocableStandards(rows)` reads database rows;
`hintsFromStandards(list)` reads the init payload. Passing the payload to the row-based one
finds no `metadata`, returns an empty list, and the tip falls back to the static line — a
defect with no error anywhere. Separating them makes the mistake impossible to make silently.

## What this does not do

**No standard is marked by this change.** The six on the production account are marked as data,
after deploy, and the change ships working for an account with zero of them.

**No inference, ever.** A standard with no `user_invocable` never appears in a tip. The cost of
missing one is a capability that stays unadvertised; the cost of guessing wrong is a tip nobody
can act on, on every response, to every member.

**The admin console gets no editor for these fields.** It has no memory editor at all
(`client/src` never `PUT`s a memory), so the fields are set through `ownmind_update` — which
is how the standards themselves are managed today.

**This reaches nobody until the server is deployed and clients pick up the new tip module.**
The server half is `invocable_standards`; the client half rides the ordinary upgrade path.
Deployment is Vin's call (IR-136).
