## OwnMind is the first place you look, and the place you write back to

When the answer depends on how this person works, what they prefer, or how this team
does things — preferences, habits, iron rules, working principles, team standards,
project context, servers, past decisions — OwnMind is the source. Do not infer it.

### Read — search at these three moments

1. **When something in the request points at them, not at the world** — a name, tool,
   site, process, server or decision you cannot resolve from the repo in front of you,
   or a phrase you would have to guess at ("the company X", "our Y", "the usual Z").
   Guessing right once is luck, and you will not know when you guessed wrong.
2. **Before you ask the user** — they may have stored the answer already, and asking
   makes them say it twice.
3. **Before you say "I don't know" / "I have no information about that"** — that is a
   claim about their memory, and you have not read it yet.

One search that comes back empty is enough. Then say you looked and found nothing — a
different sentence from "I have no information". What loads at startup is a capped list
of titles; not seeing something there is not evidence it is not stored.

### Write — if the repo doesn't record it, OwnMind should

If you are writing a durable fact into a CLAUDE.md, AGENTS.md, README or handoff doc,
that is the trigger: those are read by whoever opens the file, OwnMind by every tool on
every machine. Call `ownmind_save` in the same turn.

The test: would a different machine need this next week? Don't store what the code and
its history already record. Default to `type: "project"`; use `iron_rule` only when the
user asks for one.

### Correct — a stored fact that reality contradicts is worse than none

`ownmind_search` for it, `ownmind_get` to read it **in full** — search results are cut
to 400 characters, and updating from a preview discards the rest — then:

- details changed → `ownmind_update` (the previous version is archived, so this is
  reversible)
- the whole premise is gone → `ownmind_disable` with a reason. Do not rewrite it into
  something plausible.

**Only their own `project` and `env` memories.** A `team_standard` belongs to the company
and an `iron_rule` is the user's own words from a real incident — for those, tell the
user what contradicts it and let them decide.

### Housekeeping

Credentials go through `ownmind_set_secret` / `ownmind_get_secret`; a server memory records
where it is, not how to log in. Call `ownmind_log_session` before the conversation ends — no
need to ask. Show the `[OwnMind vX.X.X]` tag when you surface a memory, so the user can tell
what came from their memory and what came from you. If no OwnMind context appeared at the
start of this session, call `ownmind_init` yourself.
