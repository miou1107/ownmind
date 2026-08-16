# Reproductions for the 2026-08-16 findings

One script per claim in [`../2026-08-16-install-and-guard-audit.md`](../2026-08-16-install-and-guard-audit.md).

They are here rather than thrown away because several of them were expensive to get right —
`verify-bug20.mjs` took five attempts, and four of those five failed for reasons that had
nothing to do with the defect (the rules cache is a bare array not `{rules: […]}`; the commit
trigger lives at `metadata.verification.trigger`; `patterns` nests under `conditions.params`;
`execFileSync` discards stderr on a zero exit). Rebuilding that from the finding's prose
would cost the same afternoon again.

Each one runs standalone from a checkout, resolves the repo from its own location, and works
in a throwaway directory. None of them writes to the real `~/.ownmind` — `real-hook-repro.sh`
reads it and copies out.

```bash
node docs/findings/repros/<name>.mjs
bash docs/findings/repros/real-hook-repro.sh
```

| Script | Answers | Finding | Should now print |
|---|---|---|---|
| `my-repro.mjs` | Can the assistant approve its own gate? | O1 (fixed) | blocked, at every step |
| `real-hook-repro.sh` | Same question, driven through the hook Claude Code actually runs | O1 (fixed) | blocked — **reads the installed `~/.ownmind`, so it keeps showing the hole until that copy is upgraded** |
| `tiebreak.mjs` | Is the consent code recoverable, is the signing key readable, and which key shapes does the scanner catch? | O1 (fixed), O3 (open) | ~17 hours to sweep the code space; the key still readable; 8 of 25 key shapes caught |
| `verify-bug20.mjs` | Does a secret rule set to "do not block" print a green tick over a leaked key? | O2 (fixed) | blocked in all three cases |
| `symlink-escape.mjs` | Does a symlink out of the repo escape the path guard? | O5 (open) | allowed — the escape is still there |
| `repro-guard-failopen.mjs` | The five ways the path guard used to allow a guarded edit | F1, F2 (fixed) | blocked, all five |
| `edge-cases.mjs` | Does the fixed guard answer correctly for worktrees, submodules, nested repos, missing folders? | F1, F2 (fixed) | blocked, every case |

A script that starts printing "allowed" where the table says blocked means its finding has
come back. `symlink-escape.mjs` is the one that is *supposed* to print allowed today.

Two of these read the real gate rather than grepping the source for a line that used to be
there — `my-repro.mjs` and `tiebreak.mjs` both used to assume the consent code was stored as
a plain sha256 and would have reported "fixed" the moment that line was reworded. They now
issue a real ask and read what landed on disk.

**Nothing here is a live credential.** The key-shaped strings are AWS's own published
documentation examples or obviously fake, and several are assembled at runtime so that the
repository's own pre-commit scanner does not have to make a judgement call about them.
