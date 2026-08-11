# v1.26.141 — Proposal: a memory that only answered when the wording matched

Two reports, one root cause: everything the session context does is a **push**. It states
what is known. Nothing in it is a **pull** — nothing tells the assistant when to go and look.

So the system worked whenever the user's words happened to collide with a title in a list,
and failed silently the rest of the time. Failing silently here means an assistant that
sounds confident and is simply unaware, which reads to the user as "the AI forgot OwnMind
exists".

---

## 1. The instruction for reading a standard returns nothing

The context ends its team-standards list with:

```
For the full text of one: ownmind_get("standard_detail").
```

Measured 2026-08-11 against production:

```
ownmind_get({ type: 'standard_detail', parent_id: 869 })  ->  { "data": [] }
```

Memory 869 is `[團隊] 發布網頁到 pages.fontrip.com`, added the same morning. Its text lives on
its own record; it has no child fragments, so the one documented lookup returns an empty list
for exactly the standard being asked about. `ownmind_search("發 pages")` returns it as the
first row.

### How it was found

Two independent assistants were given only what a colleague's machine gets at session start,
with no locally installed skill for the task, and the user line 「幫我做一個網頁，上面只寫 hi，
然後發 pages」.

| | |
|---|---|
| recognised the standard from its title | both |
| decided to fetch it before doing anything | both |
| reached for `ownmind_get("standard_detail")` | both |
| flagged it themselves as suspicious | both — *"that does not look like a real id"* |

They were right, and they were only saved by being careful. Nothing in the design caught it.

## 2. Nothing says to search at all

The context lists titles and gives two ways to fetch something whose name you already know.
The word "search" does not appear in it.

The consequence is a system that works on lexical luck:

| the user says | what happens |
|---|---|
| 「發 pages」 | matches the title 「發布網頁到 pages.fontrip.com」 → looked up |
| 「公司 pages」 | matches nothing → not looked up, and the assistant improvises |

### The sharper case, reported the same day

The user's access details for a production server had been in memory for weeks. The
assistant still answered 「我沒有 kkvin.com 的資訊」, then found them immediately when told
to look.

That one is worse than a missed lookup, because it is a false statement delivered with
confidence. And it is entirely explicable: the context renders profile, iron rules, team
standard titles and principle titles — **and no project memories at all**, which is where
that server lives. From where the assistant sat, having no information and there being no
information were indistinguishable.

`kkvin` appears **0 times** in the 18 KB of context the assistant is given.

## What changes

Three lines, in both of the places the guidance is delivered.

1. **The standards list says how to actually read one**: `ownmind_search("<its title>")`,
   then `ownmind_get({ id })` on the row it returns.
2. **Something that points at them rather than at the world is a reason to search** — a
   name, tool, site, server or decision you cannot resolve from the repo in front of you.
   Keyed on the referent, not the vocabulary, and deliberately not on "before every action":
   see section 4. "Search every message" is noise, and noise is what gets ignored.
3. **"I have no information about that" requires having looked.** Never say it about
   something of the user's — a server, a project, a credential, a decision — without an
   `ownmind_search` in that session first. It is a claim about their memory, not about the
   world.

### Where they go, and the round it took to get that right

`hooks/lib/render-session-context.js` is how Claude Code loads memory. The first version of
this change put the same three rules in `INSTRUCTIONS_SOP` and said that covered the other
tools. **It does not.** Review caught it and the code says so plainly:

```
src/routes/memory.js   ...(!compact && { instructions: INSTRUCTIONS_SOP })
mcp/index.js:769       GET /api/memory/init?client_version=…&compact=true
```

Every caller in the repo asks for compact — `ownmind_init`, the conditional sync, the shell
hook. The field is stripped before it leaves the server, so the fix had been placed in the
one part of the payload nobody receives. That is precisely the v1.26.128 shape it was written
to avoid, and the tests could not see it because they read `memory.js` as a text file: they
proved the source contains words, never that a response carries them.

What actually survives, and what the rules now use:

| surface | reaches | read |
|---|---|---|
| `hooks/lib/render-session-context.js` | Claude Code | once, at session start |
| `mcp/index.js` tool descriptions | every tool | every turn |
| `configs/ownmind-rules-block.md`, written into the user's own files | every install | every turn |

The `ownmind_search` description now says *when to call it*, not only what it returns, and
`ownmind_get` no longer points at `standard_detail` — a tool description is in front of the
model on every turn, so it outranked the session context that was saying the same wrong
thing. The SOP section stays for the non-compact path; nothing depends on it.

## Verified

Re-ran the simulation against the new context, one clean case each:

- 「幫我看一下 kkvin.com 那台的部署狀況」 → first action `ownmind_search("kkvin.com")`; asked
  whether it would have said it had no information, the answer was no, quoting the new line.
- 「幫我做一個網頁寫 hi，然後放到公司 pages」 → searched rather than improvising.

**Caveat on the second run:** that assistant also cited a locally installed skill it could
see in its own environment, so its result is contaminated and only the first is clean
evidence. Recorded rather than presented as two clean runs.

## A finding from review that did not survive measurement

Review also reported that the new instruction is unusable because the rendered line carries a
`[團隊] ` prefix that is not part of the stored title, and that search ANDs its tokens — so
searching the line verbatim would return nothing. It read the tokenizer source rather than
calling the endpoint. Measured against production:

| query | first row |
|---|---|
| `[團隊] 發布網頁到 pages.fontrip.com` | **#869**, the standard itself |
| `公司 pages` | **#869** |
| `kkvin.com` | #653, **#745** (the server memory), #702, #632 |

All three resolve, including the wording the release is named after. Recorded because the
reasoning was careful and specific and still wrong, and because it would have sent this
change chasing a prefix that is not a problem.

## 4. Where the rules actually live, after a second round with Vin

The three sentences were only ever half the answer. Vin asked the question that finds the
other half: *should the installer be writing this into CLAUDE.md?*

It should, and it was not — and the reason is the same shape as everything else in this
release. `install.sh` and `install.ps1` wrote a five-line block with a heredoc and then
skipped the file forever after, on the strength of the word "OwnMind" appearing anywhere in
it. Neither `update.sh` nor `update.ps1` touched the file at all. **Every machine's copy
froze on its install date.** Measured 2026-08-11: one machine was still carrying a four-line
version that had been superseded three times.

So a rule written today reached nobody through that path, no matter how well worded.

### What changed

`configs/ownmind-rules-block.md` is now the single source, injected as a marked block into
the user's own instruction files — CLAUDE.md and the six other tools' — by one Node helper
that all four scripts call. The block is rewritten on every upgrade. The only thing outside the markers that changes is
the run of blank lines at the end of the file, which is normalised to one.

The marker-block job had already been written twice, once in shell and once in PowerShell,
and v1.26.140 found the two had drifted until one threw on an empty file and the other did
not. It is one implementation now, in the runtime all three platforms already depend on.

### The block itself, after review

A reviewer took the first draft apart, and four of its objections were right:

- **"Before you act" is self-defeating.** A coding agent edits a file nearly every turn, so
  the rule fires every turn, returns nothing useful, and teaches the model that this whole
  block is ignorable. Neither reported failure needed it. Replaced with a trigger on the
  *referent*: does this point at them, or at the world? 「公司 pages」 is every-word-familiar
  and entirely unresolvable from the repo, which is exactly the case a vocabulary-based
  trigger misses.
- **"Correct the memory" was not executable.** `ownmind_update` needs a numeric id; the
  assistant has a title. The instruction now names the whole sequence — search, read in full,
  then update — which is the same gap this release exists to close, reintroduced one layer
  over.
- **Updating from a search result overwrites the rest of the memory.** Search returns 400
  characters. Now stated: read it in full first.
- **Nothing stopped one person's assistant rewriting a company standard.** Correction is
  scoped to their own `project` and `env` memories; for a `team_standard` or an `iron_rule`
  — the user's own words from a real incident — it reports and lets them decide.

Two sections were cut on the same review: precedence between rule types (inert, and
contradicted by enforcement that happens lower down) and three of the four lines on secrets
(the API already rejects them with HTTP 400, and both write tools say so).

### Migration, for machines that already have the old block

The old block has no markers, so an upgrade cannot recognise it and would leave a stale copy
above the new one. The helper matches it line by line against every wording this project has
shipped:

- every line is one of ours → replaced
- anything else → **left alone**, and the updater prints a line telling the user there is an
  old section they may want to delete

That file is where people keep their own rules. Eating a hand-written line to save a
duplicated heading is not a trade worth making (IR-112).

## What this does not change

No new lists are added and nothing is fetched that was not fetched before. The context itself
does grow — measured on a minimal fixture, 448 → 1,069 bytes — because three sentences are
three sentences. An earlier draft of these notes said "no payload grows", which was wrong.

## What this does not fix

`install.sh` still has the same freeze-forever check for `GEMINI.md` — a different template,
not converted here. Gemini users do get the new rules: the upgrade path writes the block into
`GEMINI.md` like every other tool's file.

The `ownmind-upgrade-rule` block still has its own shell and PowerShell implementations
rather than using the shared helper. It works and is tested; converting it is a separate
change.


**Project memories are still not listed anywhere in the session context.** This change makes
the assistant go and look for one instead of asserting it does not exist, which is the
reported failure. It does not make the user's 133 project memories visible up front. Doing
that would add about 5.8 KB of titles to every session — a real cost against an 18 KB
context, and a decision about attention rather than correctness. Left to the user, with the
number measured rather than guessed.
