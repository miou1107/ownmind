# v1.26.144 — the upgrader calls its own output "your changes"

## Why

`scripts/interactive-upgrade.sh` and `.ps1` decide whether the working tree is dirty by
reading `git status --porcelain`. When it is non-empty they assume the user has edited the
checkout, save a backup, file an `upgrade_dirty_tree` error report, and run
`git reset --hard origin/main`.

Measured on a real installation (`~/.ownmind`, 2026-08-11), that check is non-empty on a
machine nobody has touched:

```
 M hooks/ownmind-usage-scanner.js     <- mode 100644 -> 100755
?? bin/                               <- written by install.sh:701
?? reports/                           <- written by the daily health report
```

Neither entry is the user's, and neither can be cleared by the reset that answers it.

**The tracked one repeats forever.** `hooks/ownmind-usage-scanner.js` is committed
`100644`; `install.sh:691` and `scripts/update.sh:342` both `chmod +x` it. So the file is
mode-dirty from the moment OwnMind is installed. `git reset --hard` restores `100644` —
and then the sync script at the end of the same upgrade sets `100755` again. Every
subsequent upgrade takes the destructive branch, on every macOS and Linux machine, for as
long as the installation exists.

**The untracked ones cannot be cleared at all.** `git reset --hard` does not remove
untracked files, so `?? bin/` and `?? reports/` are still there afterwards and the branch
fires again next time. Eric's machine reports `tree: ?? standards/` on every upgrade for
the same reason.

The cost is not the reset itself — a backup is taken first. It is that the branch which
overwrites uncommitted work is the *default* branch, that its warning is printed on every
upgrade, and that a genuine local edit therefore scrolls past inside a message everyone
has learned to ignore. `.gitignore` records this failure being fixed once already, in
v1.26.105; the list it added was hand-written and three paths have appeared since.

## What changes

1. **Commit the exec bit.** `hooks/ownmind-usage-scanner.js` becomes `100755` in the
   repository, matching what both installers set on disk. The tracked-file dirt disappears
   at its source rather than being tidied up afterwards.

2. **A grown check, not a hand-written one.** A test reads `install.sh` and
   `scripts/update.sh`, extracts every path they `chmod +x` inside the checkout, and
   asserts each is committed `100755`. The next file someone makes executable fails the
   test instead of failing quietly on every user's machine.

3. **Untracked files stop triggering the reset.** The dirty decision reads
   `git status --porcelain --untracked-files=no`, because `git reset --hard` acts only on
   tracked files: including untracked entries guarantees a branch that cannot succeed.
   Untracked paths are still written to the log — they are worth seeing — but they no
   longer overwrite anything or file an error report.

4. **`bin/` and `reports/` join `.gitignore`**, so they stop appearing in anything that
   reads status, including the log line above.

Both the `.sh` and `.ps1` upgraders change together (IR-022).

## Impact

- A machine nobody has edited stops reporting `upgrade_dirty_tree`, so the report keeps
  meaning "somebody changed something here".
- A genuine uncommitted edit is still detected and still backed up before the reset — that
  path is unchanged.
- No server, database or API change.
