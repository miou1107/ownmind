# OpenSpec proposal-folder conventions (CONVENTIONS)

> This document is OwnMind's internal convention for OpenSpec (spec-driven
> development workflow) folder layout.
> OpenSpec means the workflow of "write a proposal first, pin down the spec and
> tasks too, then start changing code."

This file is a policy declaration — it governs how every OpenSpec proposal
migration should be done **from now on**.
Alongside this file, PR #37 (the first archive migration) moves three already
released proposals into `archive/`, which is the first concrete instance of
this convention.

---

## 1. Folder structure

The diagram below is the **target structure** this convention defines (the
`archive/` subdirectory is created at the first migration; it did not exist
before):

```
openspec/
├── CONVENTIONS.md              # this file, OpenSpec conventions
└── changes/                    # all proposals live here
    ├── <version>-<topic>/      # in-progress proposals (one folder per version)
    │   ├── proposal.md         # proposal: background, motivation, decisions
    │   ├── spec.md             # spec: GIVEN/WHEN/THEN scenarios
    │   │                       # (plainly, a three-part precondition/action/
    │   │                       #  expected-result BDD description)
    │   └── tasks.md            # task breakdown: execution checklist & progress
    └── archive/                # released or deprecated proposals (frozen snapshots)
        └── <version>-<topic>/  # same structure, but contents no longer change
```

Notes (plain language):

- `openspec/changes/`: holds proposals **still in progress**, one folder per
  version (e.g. `v1.18.0-iron-rule-schema`).
- `openspec/changes/archive/`: holds **completed** proposals, treated as
  historical snapshots, no longer modified. This subdirectory is created only
  at the first migration.

---

## 2. When a proposal enters the archive

A proposal may move into `archive/` only if it meets one of these conditions:

1. **The version is officially released** — `CHANGELOG.md` has a matching
   version entry.
2. **The proposal is officially deprecated** — `proposal.md` contains an
   explicit deprecation statement (e.g. the v1.18.9 proposal deprecated Phase 2
   and Phase 3, narrowing down to a latency-instrumentation-only release).
   - Deprecated means "decided not to do it"; not necessarily broken — it may
     be a strategy change or a scope reduction.

If neither condition is met, **keep the proposal in the `openspec/changes/`
root** and do not migrate it early.

---

## 3. Migration rules

When moving a proposal from `changes/` to `changes/archive/`:

1. **Always use `git mv`** — to preserve file history.
   - `git blame` (who changed each line) and `git log --follow` (follow history
     across renames) both rely on git's rename records.
   - Do not use `mv` or IDE drag-and-drop; git would treat that as "delete the
     old file + create a new file" and lose the rename record.
2. **Folder renaming**: if the folder name does not match the internal
   `proposal.md` title, rename it during the migration.
   - Example: the v1.18.9 release narrowed down to latency instrumentation, but
     the folder was still the originally planned
     `v1.18.5-block-feedback-and-safety-alerts`. Rename it to
     `v1.18.9-mcp-latency-tracking` during migration.
   - Renaming (plain language) means "rename the folder to match its actual
     contents."
3. **Sync-check external references**: after migrating, grep the following
   locations and update every old path to the new path:
   - `CHANGELOG.md`
   - `FILELIST.md`
   - tests and comments under `tests/`
   - any other file in the repo that references the proposal by absolute path
     (e.g. README, docs/)

---

## 4. Archive freeze policy

All files inside `archive/` are treated as **historical snapshots**:

- Contents **freeze** the moment they are moved in, and do not change afterward.
- Even if the folder is renamed again, or the external structure changes
  drastically, **do not retroactively edit old path or old folder-name
  references inside archive files**.
- Those old references are part of "the historical record at that time," kept
  intentionally, reflecting how the proposal actually looked when it was
  finalized.

**Why do this?**

If every external structure change required going back to edit all files in the
archive, the archive would lose its meaning as a "historical snapshot"; besides,
these files are never executed or read again — they only serve future readers
looking at history, and the old paths are actually part of the context of that
time.

**Exception**: if a reference inside the archive would cause a **real broken
link** (e.g. some archive file links to code in the repo that has been
**deleted**, so a reader clicking through hits a 404), reassess whether to
repair it. But "the path or folder name itself being outdated" does **not**
count as a broken link and need not be fixed — nobody clicks an old folder name,
it is just a textual record.

---

## 5. Verification flow

After each migration, use the grep template below to confirm there is **no
leftover** old path outside the archive:

```bash
grep -rn "openspec/changes/<old-name>" \
  --include="*.md" --include="*.js" --include="*.json" --include="*.ts" \
  . | grep -v "archive/"
```

Replace `<old-name>` with the actual migrated folder name (e.g.
`v1.17.66-windows-hardening`).

Expected output: **zero results** (no leftovers outside the archive).

If there are hits, update those few spots to the new path, then rerun the grep
until it reaches zero.

> Note: the trailing `grep -v "archive/"` deliberately filters out the old
> references inside the archive — per the freeze policy in section 4, those are
> historical snapshots and need not be fixed.

---

## Reference records

- **PR #37** (first migration of released proposals into the archive, which set
  the freeze policy):
  https://github.com/miou1107/ownmind/pull/37
- **The PR that established CONVENTIONS.md itself**:
  https://github.com/miou1107/ownmind/pull/38
  If this file is revised later, keep appending links here.
