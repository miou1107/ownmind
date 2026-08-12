# v1.26.149 — two copies of one decision, answering differently (issue #92)

## What is wrong

`ownmind-iron-rule-check` is the PreToolUse hook that names the iron rules relevant to a
command before that command runs. It ships twice:

- `hooks/ownmind-iron-rule-check.js` classifies through `detectCommandTrigger()` in
  `shared/helpers.js`
- `hooks/ownmind-iron-rule-check.sh` rebuilds the same decision as a hand-written
  `grep -qiE` chain

Both copies are deliberate. The shell one needs no node on `PATH`, and it avoids handing
node a path — the move behind two silent Windows failures (`install.sh CLAUDE_SETTINGS`
in v1.26.88, `/dev/stdin` in v1.26.90). Duplication is the cheaper risk there.

What was missing is anything holding the two to the same answers. The `KEEP IN SYNC` note in
`shared/helpers.js` covers `TRIGGER_TAG_ALIASES`, and `tests/iron-rule-trigger-aliases.test.js`
compares that one table. **Which command produces which trigger was unguarded**, and
`install.sh:513` registers the `.sh` copy on mac and Linux — so the unguarded implementation
is the one most users are actually running.

Measured across 17 sample commands, 7 were classified differently:

```
command                                    .sh       .js (reference)
------------------------------------------------------------------------
≠ git tag v1.2.3                           null      commit
≠ docker compose build                     null      deploy
≠ docker compose push web                  null      deploy
≠ docker logs backup                       deploy    null
≠ docker ps | grep uptime                  deploy    null
≠ Remove-Item -Recurse ./dist              null      delete
≠ docker compose up -d && rm -rf ./old     delete     deploy
```

Three of these are user-visible failures rather than differences of opinion:

1. **`git tag` reached no trigger on mac or Linux.** Tagging a release is the moment the
   version-sync rules exist for, and the hook was silent through it.
2. **`docker compose build` and `docker compose push` reached no trigger there either.** The
   shell deploy pattern was `docker.*deploy|docker.*up`, which contains neither. A rule
   written to say "deploy with `docker compose build`" could not fire when someone ran
   `docker compose build`.
3. **`docker.*up` matched things that are not deploys.** `docker logs backup` and
   `docker ps | grep uptime` both contain `up`, inside `backup` and `uptime`. Reading a log
   produced a full deployment rule listing.

The last row is not a pattern gap but an ordering one: both families match, the reference
tests deploy before delete, and the shell chain tested delete first.

## What changes

**A guard test first.** `tests/iron-rule-trigger-parity.test.js` feeds the table above to
both implementations and requires identical answers. It runs the real `.sh` hook and reads
the trigger back out of the hook's own banner — it does not restate the grep chain. A third
copy of the logic, written inside the thing that exists to catch copies drifting, would be
the same defect one level up.

**Then the shell chain becomes a transcription of the reference**, in the reference's order.
`shared/helpers.js` is the side that wins ties: it is the copy the `KEEP IN SYNC` note
names, the copy carrying the per-pattern rationale, and the copy already under test.

**One pattern moved the other way.** `docker.*deploy` — i.e. `docker stack deploy` — existed
only in the shell copy. Squaring the two could have removed it or promoted it; it was
promoted into `shared/helpers.js`, because a Swarm deploy is a deploy and the alternative was
to stop recognising it where it already worked.

**One pattern is dropped.** `del `, the cmd.exe delete, cannot appear on the platforms the
shell copy runs on, and PowerShell's own name for the same operation — `Remove-Item` — is
matched. Keeping it would mean a difference the parity test would have to be taught to
tolerate, which is the beginning of the next drift.

## What this does not do

**The duplication itself stays.** Issue #92 proposes two ways to remove it — turning the
patterns into data both sides read, or having `.sh` call `.js` — and both need a decision
about whether the shell copy's independence from node is still required. That is a
release of its own. This one makes the duplication safe to have: the two copies can no
longer disagree without a test going red.

**The banner strings stay unsynchronised.** `.js` prints English, `.sh` prints Chinese, and
the copy that runs on mac and Linux is the Chinese one — so a member working in English or
Japanese gets a Chinese line. That is issue #91's scope (hooks i18n) and is not touched here.

## Risk

The shell chain now classifies six commands differently than it did yesterday. Five of those
are the failures above. The sixth is `docker compose up -d && rm -rf ./old`, which changes
from `delete` to `deploy`: a compound command that deploys and then tidies up now lists the
deployment rules rather than the deletion rules. That follows the reference, which is what
every Windows user has always seen, so the change makes the platforms agree rather than
inventing a third behaviour. Recorded here because it is the one row where "which answer is
correct" is a judgement rather than a defect.
