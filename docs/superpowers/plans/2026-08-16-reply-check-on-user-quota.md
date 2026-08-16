# Reply check on the user's own quota, after the fact

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task.

**Goal:** the reply check judges on the user's own Claude Code subscription instead of the
llm switch, and stops making the user wait for it.

**Why:** IR-160 — Vin has twice said any model OwnMind uses to judge should be the user's own
subscription, not the switch. Separately, the switch path fails 474 of 1006 checks (47%);
measured directly, 6 of 12 gateway calls return `502 All 2 provider attempts failed`.

**Architecture:** selection stays on the server, judging moves to the client. The client
already caches selectors (318) but **no rule text** — measured — so shipping the whole corpus
would be a much larger change. Instead the server keeps doing what it is good at (matching
rules to the turn, applying the 20k budget) and returns the selected rules with their text;
the client runs the judge locally and never blocks the turn.

## Global Constraints

- **The judge spends the user's Claude Code quota.** No `callLLMSwitch`, no
  `LLM_SWITCH_API_KEY`, no `OWNMIND_LLM_API_BASE` anywhere on this path. (IR-160, critical.)
- **Never fail silently.** Every state a user can land in — no `claude` CLI, judge timed out,
  verdict never collected — says so in their language. A check that did not run must not look
  like a check that passed. (CLAUDE.md, product principle 2.)
- **User-facing copy passes the four checks** in CLAUDE.md: subject is 你 or AI never a
  mechanism; actions attributed; say what they must do or that they need do nothing; no
  jargon. Applies to table headers and list labels too.
- **zh is the source**; en/ja follow with override files, and the hard-coded English fallbacks
  in the six files listed in CLAUDE.md must match `en.json`.
- New code, comments and commits in English (track B).

## Measured, before writing any of this

| Question | Answer | How |
|---|---|---|
| Does `claude -p` work headlessly on the user's subscription? | Yes | ran it |
| How long for a real judge payload (8 rules, long reply)? | haiku 18s and 57s; sonnet 43s and 45s | ran it, twice each |
| How much of that is startup? | ~10s — a bare "reply OK" takes 10.5s | ran it |
| Does the client already hold rule text? | **No.** 0 of 318 selectors carry text | read the cache |
| Can a hook leave work running after it exits? | Yes — the child is reparented to init | ran it |
| Current end-to-end budget it must live inside | 4s server, client aborts at 5s, an abort silences the check for 5 min | read the code |

The last row is why this cannot stay synchronous: the fastest measured judge is 3× the
client's abort, and an abort costs five minutes of no checking at all.

---

### Task 1: the server answers "which rules apply", without judging

**Files:**
- Modify: `src/routes/compliance.js` — split rule selection from the judge call
- Test: `tests/compliance-select-only.test.js`

The route already does the whole job in one handler: read the account switch, fetch readable
memories, `selectRules`, call the judge, record. Everything up to the judge call is cheap,
deterministic and already tested. Split it so a client can ask for just that part and get the
selected rules **with their text**, plus the `check_id` the eventual verdict will be recorded
against.

The existing behaviour stays reachable and unchanged until Task 3 switches the client over —
this is the release that must not break the check for anyone mid-upgrade.

- [ ] **Step 1:** write the failing test — a request in select-only mode returns the selected
      rules with `judgeText`, records a row with outcome `pending`, and makes **no** LLM call
      (inject an `llmFn` that throws if called)
- [ ] **Step 2:** run it, watch it fail
- [ ] **Step 3:** implement
- [ ] **Step 4:** run it, watch it pass; run the existing compliance route tests unchanged
- [ ] **Step 5:** commit

### Task 2: a judge that runs on this machine

**Files:**
- Create: `hooks/lib/local-judge.js` — build the argv, spawn `claude -p`, parse the verdict
- Create: `tests/local-judge.test.js`

`claude -p --model haiku --allowed-tools '' --system-prompt <judge system>`, **prompt on
stdin** — a prompt beginning `---` is read as a flag, which is how the first probe died.

What the tests must pin, because each of these is a way to fail quietly:

- the prompt goes on stdin, never argv
- no tools are granted — a judge that can edit files is not a judge
- a non-zero exit, a timeout, or unparseable output produces a **stated** failure, never an
  empty verdict list that reads as "clean"
- `claude` not on PATH is its own case with its own message

- [ ] **Step 1:** write the failing tests against a fake `claude` on PATH
- [ ] **Step 2:** run them, watch them fail
- [ ] **Step 3:** implement
- [ ] **Step 4:** run them; then run the real CLI once by hand and record the latency
- [ ] **Step 5:** commit

### Task 3: fire at Stop, collect at the next turn

**Files:**
- Modify: `hooks/ownmind-reply-lint.js` — start the judge detached, return immediately
- Modify: `hooks/ownmind-prompt-inject.js` — collect any finished verdict, hand it to the AI
- Modify: `hooks/lib/compliance-step.js` — the client half of Task 1's endpoint
- Modify: `hooks/locales/{zh,en,ja}.json` + both override files
- Test: `tests/reply-check-async.test.js`

The Stop hook stops waiting: it asks the server which rules apply, spawns the judge detached
(proven to survive — the child reparents to init), and returns. The verdict lands in
`~/.ownmind/state/reply-verdict-<session>.json`. The next `UserPromptSubmit` reads it, hands
any violation to the AI, and posts the outcome back so `compliance_checks` keeps its record.

**Verify inside a real hook first.** The detachment was proven for a plain parent/child; the
harness's own cleanup is a separate question and is the first thing that could sink this.

The states a user can be in, each with its own line:

| What happened | What they are told |
|---|---|
| Verdict arrived, nothing violated | nothing — silence is the everyday path |
| Verdict arrived, something violated | the finding, and that the AI has been told to fix it |
| Verdict not ready yet | nothing — it lands next turn |
| Judge could not run | that the reply was not checked, and what repairs it |

- [ ] **Step 1:** verify a real Stop hook can leave the judge running
- [ ] **Step 2:** write the failing tests for the four states
- [ ] **Step 3:** implement
- [ ] **Step 4:** run the suite; break each new check once to confirm it goes red (IR-134)
- [ ] **Step 5:** commit

---

## What this gives up, recorded so nobody rediscovers it as a bug

The check can no longer stop a reply before the user reads it. Today it can push back and make
the AI rewrite; after this, the user sees the reply once and the AI is corrected on the next
turn.

That is a real reduction against this product's own principle that a reminder is not
enforcement. It is accepted because the blocking version only runs about half the time, and a
check that always runs a turn late enforces more in practice than one that blocks when it
happens to work. **If the failure rate on the new path turns out to be low, revisit whether a
short synchronous wait can be reinstated for the fast cases.**

## Still open, to settle during implementation

1. What an account with no Claude Code CLI gets. Every OwnMind user is a Claude Code user, so
   this is the empty set today — but it must not fail silently when it happens.
2. Whether the ~10s CLI startup can be avoided. It is two thirds of the haiku latency, and it
   is the difference between "ready before the next turn" and "usually ready".
3. `compliance_checks` is still write-only: nothing in the product reads it, so measuring
   whether this worked needs SSH. Worth fixing while the schema is being touched anyway.
