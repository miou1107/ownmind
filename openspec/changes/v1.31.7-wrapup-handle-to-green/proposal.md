# Wrap-up: every tile handled to green

## Why

On 2026-10-03 Vin typed 收工. The pane showed one red tile and three yellow ones, and the
AI answered with a paragraph per tile explaining why each was fine. Vin's verdict: "你這樣會
誤導 user。通常打了收工之後，所有 label 都應該要變成綠色，如果沒有綠色你要處理到綠色。放一堆資訊很容易誤導。"

Two of the six tiles could never turn green, whatever the AI did:

- **版號** is yellow whenever commits follow the newest tag. Between batched releases that is
  the normal state, and the only way to clear it was to cut a release nobody needed.
- **待辦與交接** is always yellow: the mod cannot read OwnMind's handoff list, so it asks the
  AI to, and nothing turns the tile green once the AI has.

And one tile was yellow for a reason that was not this session's: OwnMind's own reply judge
(agy) listens on a port for the few seconds it judges, so the residue check caught it at
almost every wrap-up on machines that use it.

So the AI was left explaining yellow tiles in prose, which is the misleading report Vin
described.

## What changes

1. **A tool the model calls when it has handled a yellow tile**, `mcp__wrapup-check__resolve`
   (`item`, `done`). The checks run again first. A tile that is red is refused with what is
   still wrong: red is measured, and only fixing it clears it. A yellow tile turns green and
   shows the model's one sentence. The answer lists the tiles that are still not green.
2. **Handled tiles stay green on 再查一次** for the rest of that wrap-up, and are forgotten
   when the user types a wrap-up word again: each wrap-up starts from the machine as it is.
3. **The instruction handed to the model** now says to handle every tile to green before
   answering, to leave one only when the user has to decide it, and to keep the report to
   two sentences without the handling details.
4. **agy is port noise**, like the always-on desktop apps already listed.
5. **A handled tile is green only while it still says the same thing.** The resolution keeps
   the row's detail lines; one more commit after the tag, or a baseline that landed since,
   is a new reason and the tile is yellow again.
6. **Only the user's own prompt starts a wrap-up.** A background task's notice, another
   session's message or a scheduled prompt that quotes "wrap-up" no longer runs the checks
   (2026-10-03: a review agent titled "Review wrap-up resolve change" opened the pane).
7. **Overlapping runs cannot overwrite a newer result.** Each run is numbered and only the
   newest one writes the pane.

8. **The pane is a checklist of the six items** (Vin approved a mockup on 2026-10-03: "我覺得你那些
   kpi label 應該是要對應 6 項自檢，有點像 check list，每完成一樣就打勾"). The three number cards
   are gone. On top: "完成 n / 6" and a progress bar. Each item is one line: a tick and what was
   found or done; while the AI is still answering the wrap-up, an open item says "AI 處理中";
   after the answer (`turn.complete` of the main conversation, not a subagent's), it says
   "等你決定：…" (yellow) or "還沒處理：…" (red), and the desktop lists their detail below.
   The desktop picture switches its text colors with the system's dark mode.

## Not in scope

- Reading the handoff list from the mod. Still not reachable from a plugin; the model checks
  it with the OwnMind tool and resolves the tile.
- Deciding by itself whether untagged commits need a release. That stays a judgment, which
  is what the yellow tile and the resolve sentence are for.
