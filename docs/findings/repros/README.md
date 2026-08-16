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

| Script | Answers | Finding |
|---|---|---|
| `my-repro.mjs` | Can the assistant approve its own gate? | O1 |
| `real-hook-repro.sh` | Same question, driven through the hook Claude Code actually runs | O1 |
| `tiebreak.mjs` | Is the consent code recoverable, is the signing key readable, and which key shapes does the scanner catch? | O1, O3 |
| `verify-bug20.mjs` | Does a secret rule set to "do not block" print a green tick over a leaked key? | O2 |
| `symlink-escape.mjs` | Does a symlink out of the repo escape the path guard? | O5 |
| `repro-guard-failopen.mjs` | The five ways the path guard used to allow a guarded edit | F1, F2 (fixed) |
| `edge-cases.mjs` | Does the fixed guard answer correctly for worktrees, submodules, nested repos, missing folders? | F1, F2 (fixed) |

The last two should now print "blocked" for every case. If either starts printing "allowed"
again, F1 or F2 has come back.

**Nothing here is a live credential.** The key-shaped strings are AWS's own published
documentation examples or obviously fake, and several are assembled at runtime so that the
repository's own pre-commit scanner does not have to make a judgement call about them.
