# v1.26.101 — half the index budget was being spent on a duplicate

## What is wrong

v1.26.100 gave `MEMORY.md` a 140-line budget and shared it out by entry count.
That is neutral, and neutral is wrong here, because the two things in the index
do not cost the same to leave out.

**Iron rules already reach the session by another route.** The SessionStart hook
injects every one of them, with its trigger conditions, directly into the
session. An index line for a rule adds only the link to its local file.

**Projects have no second channel.** A project that is not listed in the index
is not in the session at all.

Sharing by count therefore spent about half the budget re-listing something the
session already had. On the measured install:

```
iron rules listed   63   (all 143 were already in the session anyway)
projects listed     63
projects unlisted   67
```

## What changes

Iron rules take a fixed small share of the index; everything else goes to the
types that have nowhere else to appear.

```js
export const IRON_RULE_INDEX_CAP = 20;
```

The cap is applied where the allocator is told how many lines each type will
accept, so a capped type releases the difference exactly like any other type
that wants less than its share. Nothing else in the allocator changes.

Same data, after:

```
iron rules listed    20
projects listed     106   (was 47 before any of this work)
```

## Why 20, and why it is a judgement rather than a measurement

There is no threshold to measure here: the rules are in the session either way,
so the only thing an index line buys is a one-click path to the local file for a
rule the user is currently working with. Twenty covers the recently changed ones.
The omission note states the rest, as it does for every type.

## What does not change

- Every memory still has its own file on disk. Nothing is deleted and nothing
  becomes unreachable.
- The omission note is still computed from the real total, so a capped type
  reports everything it left out, not just what fell past the cap.
- The 140-line and 200-character ceilings, the newest-first ordering, the
  by-need redistribution, and the failure-marker reservation are untouched.
