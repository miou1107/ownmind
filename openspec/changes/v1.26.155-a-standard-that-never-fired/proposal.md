# A standard that had never fired

## Why

`[團隊] 對外送出前先獨立審查` says: run an independent review before anything leaves —
reports to clients, replies to stakeholders, external documents, public posts, **formal
replies on issues or PRs**. Its stated reason is that what goes out cannot be taken back;
a typo can be fixed, a wrong fact and an internal detail cannot.

Its author tagged it `trigger:send`. **Nothing has ever asked for that tag.** Measured
2026-08-12 against the live account:

```
gh issue create   → (no trigger)
gh issue comment  → (no trigger)
gh pr create      → (no trigger)
```

An issue was filed that same afternoon. The standard did not appear.

It was not alone. A sweep of every `trigger:` tag on the account found nine memories that
carry tags matching no operation at all, and the failure is invisible from both ends: the
author sees a tag they wrote, and the reminder shows a category count that is simply lower
than it should be.

## What changes

**A new trigger: `send`.** `gh issue|pr create|comment|edit|review|close|reopen`, and
`git send-email`. Narrow on purpose — `gh issue list` and `gh pr view` send nothing, and a
reminder in front of every list command is one that gets scrolled past, taking the real case
with it.

**Not folded into `deploy`, though that was cheaper.** The label reaches the user, and
"This operation is a Deploy procedure" over a comment on an issue is the same defect as the
`install` label that once appeared over a plain `curl` and had someone asking what was being
installed. The label is `Outward send`.

**`gh release create` goes to `deploy`, not `send`.** It publishes a build. Calling that an
outward send would be the same mislabelling pointing the other way.

**`publish` / `發布` / `發佈` match both `send` and `deploy`.** This was the one real design
question, and it was settled by the ambiguity being real rather than fixable:

> 發布新版本 is a deploy. 發布一篇文章 is an outward send.

The author of a memory cannot know which bucket their tag will land in. Matching both costs
one extra line on the operation it does not apply to. Matching one costs a rule that stays
silent on the operation it was written for — and the standard behind this supplies the
tiebreaker itself: what goes out cannot be taken back.

The deploy-only vocabulary (`部署`, `上線`, `升級`, `kubectl`…) is **not** carried over, so a
deployment standard does not turn up on a reply to an issue.

## What was deliberately not fixed

Seven of the nine invisible memories cannot be fixed by widening a vocabulary, because what
they name is not an operation:

| memory | tags | why |
|---|---|---|
| the reply-language iron rule | `reply`, `language` | replying is not a tool call; no hook sees it |
| wrap-up / handoff self-check | `wrap-up`, `handoff` | the user says it out loud; there is no command |
| systematic debugging | `bug`, `debug` | `debug` is *deliberately* excluded from `install` |
| learn-and-propagate | `save`, `learn` | no operation |
| project architecture | `architecture`, `design` | no operation |
| FAPA onboarding | seven bespoke tags | no operation |
| GitLab migration | four `gitlab*` tags | no operation |

These already work through the other channel: every team standard's **title** is loaded at
session start, so saying "I'm wrapping up" reaches the standard by name. The tags on them are
redundant, not broken. Inventing triggers for them would mean tagging them `trigger:command`,
which matches everything — the noise v1.26.151 removed.

`trigger:push` looks like an omission and is not worth acting on: all three memories carrying
it already match `commit` through another tag, so adding the word would change nothing today.

## Impact

- `shared/helpers.js` — `detectCommandTrigger` gains the send branch and `gh release`;
  `TRIGGER_TAG_ALIASES` gains `send` and `發佈`.
- `shared/hook-context.js` — `TRIGGER_LABELS.send`.
- Tests — the parity table gains the send cases and the two that must **not** fire; the alias
  file gains the both-buckets rule and its negative.
- No hook changes. A new trigger flows through the existing paths unmodified, which is what
  the v1.26.150 consolidation was for.
