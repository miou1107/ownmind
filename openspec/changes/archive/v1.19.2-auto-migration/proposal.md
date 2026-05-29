# v1.19.2 — Auto-apply DB migrations + schema_migrations tracking table

- **Author**: Vin
- **Date**: 2026-05-22 (proposal + start of work)
- **Status**: In progress
- **Worktree**: None (directly on main; small change, reversible)
- **Branch**: `main`

---

## 0. One-line summary

deploy / interactive-upgrade automatically detects whether `db/*.sql` has any unapplied migrations, applies them automatically, tracks them via the `schema_migrations` table, and **no longer relies on a human remembering to run the SQL**. Maps to IR-027 "reminders don't work, only logic does" + the newly created IR-048.

> Plain language: previously, when releasing a new version you had to remember to log into prod and manually run `psql -f 014_xxx.sql`; missing it would blow up with a 500. Now it auto-detects and auto-runs, so releasing just means pushing a tag — nothing to forget.

---

## 1. Design rationale

### 1.1 Real incident (noon, 2026-05-22)

OwnMind v1.19.0 commit `f0ad9a7` added `db/014_iron_rule_tier.sql` to the repo (added a `tier` column to the memories table). During release we ran:

- ✅ `git pull` on prod
- ✅ `docker compose build`
- ✅ `docker restart ownmind-api`
- ❌ **Nobody remembered** `docker exec ownmind-db psql -f 014_iron_rule_tier.sql`

Result: all `POST /api/memory` returned 500 `column "tier" does not exist`, ownmind_save / ownmind_update all crashed, log_session used a different table so it still worked, misleading the user into thinking "just one feature is broken". The user couldn't see the server log and spent half an hour before discovering it was a schema mismatch.

### 1.2 Why the docker-compose auto-apply mechanism doesn't work

`docker-compose.yml` only mounts `001_init.sql` into `/docker-entrypoint-initdb.d/`, and that folder **only runs the first time the volume is initialized**. The subsequent 14 migrations all have to be run manually.

In other words: the docker-compose path auto-applies `001` on the "first fresh install", but **has never auto-applied 002 ~ 014** — all 14 of those were run manually by Vin, remembered by luck.

### 1.3 Why v1.19.2 rather than v1.20

- Small blast radius: 3 new files + 1 change to an existing script
- Low risk: purely additive, doesn't touch existing data, re-runnable (idempotent)
- Already burned: v1.19.0 → v1.19.1 were both the same schema problem twice in a row, can't wait
- v1.20's scope is "Critical iron-rule enforcement", unrelated to this, shouldn't be bundled

---

## 2. Design

### 2.1 Core: schema_migrations tracking table

Add `db/015_schema_migrations_table.sql`:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by VARCHAR(100) DEFAULT 'auto'
);
```

After each SQL runs, `INSERT` one row. Next time the runner runs, `SELECT filename FROM schema_migrations` is compared against the `db/*.sql` filenames, and only the unapplied ones are run.

**Reasons for choosing this approach** (vs marker file / repo APPLIED.md):
- Standard practice (Rails / Django / Flyway / Liquibase all do this)
- State is bound to the DB itself; reinstalling the host / rebuilding the docker volume won't lose it
- In future an admin UI "DB schema status" page can be added, querying `SELECT * FROM schema_migrations`

### 2.2 Runner: scripts/run-migrations.sh

Core logic (pseudo-code):

```bash
ensure_table_exists()  # run 015_schema_migrations_table.sql (IF NOT EXISTS, safe)
applied=$(psql -t -c "SELECT filename FROM schema_migrations ORDER BY filename")
for sql in $(ls db/*.sql | sort); do
  basename=$(basename $sql)
  if echo "$applied" | grep -q "^$basename$"; then
    echo "✓ skip $basename (already applied)"
    continue
  fi
  echo "→ applying $basename"
  psql -f "$sql" || exit 1
  psql -c "INSERT INTO schema_migrations(filename) VALUES('$basename')"
done
```

**Properties:**
- Idempotent: running it twice, the second run does nothing
- Order: relies on `ls | sort`, so filenames must be in `NNN_xxx.sql` format
- Stop on failure: if some SQL fails it exits 1, doesn't continue to the next one (avoids state gaps)
- Uses `docker exec ownmind-db psql`, doesn't depend on psql being present on the host

### 2.3 Integration point: interactive-upgrade.sh

In the existing flow:

```
git pull → npm install → ★ run-migrations.sh ★ → docker restart api
```

The starred step is the new one. On failure, abort, don't restart the api, to avoid running with code whose schema doesn't match.

### 2.4 Backfill the existing 14 migrations

On the first deploy to prod, `schema_migrations` is empty, so the runner will try to re-run 001 ~ 014. Although most of the SQL is protected with `IF NOT EXISTS`, there's no guarantee every one is 100% safe.

**Solution**: before deploying v1.19.2, manually run one backfill SQL:

```sql
INSERT INTO schema_migrations(filename, applied_by) VALUES
  ('001_init.sql', 'backfill'),
  ('002_add_team_standard.sql', 'backfill'),
  ('003_activity_logs.sql', 'backfill'),
  ...
  ('014_iron_rule_tier.sql', 'backfill');
```

Afterward, when the runner runs it will "✓ skip 001 ~ 014 (already applied)" and only run the newly added `015_schema_migrations_table.sql` (and `015` uses `IF NOT EXISTS`, so re-running is also safe).

---

## 3. In scope vs out of scope

### 3.1 In scope (v1.19.2)

- ✅ New file `db/015_schema_migrations_table.sql`
- ✅ New file `scripts/run-migrations.sh` (migrations runner)
- ✅ Change `scripts/interactive-upgrade.sh`: insert a `run-migrations.sh` call
- ✅ New test `tests/run-migrations.test.js` (happy path + edge case)
- ✅ Backfill the existing 14 migrations on prod
- ✅ Sync README / FILELIST / CHANGELOG (IR-008 + IR-026 + IR-032, all three languages)
- ✅ Sync version number in three places to v1.19.2 (IR-031)

### 3.2 Out of scope

- ❌ Port to other internal projects: do OwnMind first, port in a later version once it runs smoothly
- ❌ rollback / down migration: OwnMind has never done a down migration, not planned for now
- ❌ Migration edit lint (checking the NNN_xxx.sql filename format): the runner relies on sort ordering, a wrong filename naturally errors out, no separate lint added
- ❌ Admin UI "DB schema status" page: open later, not in this version

---

## 4. Blast radius

### 4.1 Server / scripts

| File | Change |
|------|------|
| `db/015_schema_migrations_table.sql` | **New file** — schema_migrations table |
| `scripts/run-migrations.sh` | **New file** — migrations runner |
| `scripts/interactive-upgrade.sh` | Add `bash scripts/run-migrations.sh` after npm install, before restart |

### 4.2 Docs

| File | Change |
|------|------|
| `README.md` | Add "migrations auto-apply" explanation to the Deploy section |
| `docs/README.zh-TW.md` | Same, Traditional Chinese version (IR-032) |
| `docs/README.ja.md` | Same, Japanese version (IR-032) |
| `CHANGELOG.md` | Add v1.19.2 entry |
| `FILELIST.md` | Add the 3 new files |

### 4.3 Tests

| File | Coverage |
|------|------|
| `tests/run-migrations.test.js` | 1. happy path (new migration auto-applied)<br>2. idempotent (running twice, the second run skips)<br>3. backfill (existing records not re-run)<br>4. stop on failure (some SQL fails, the rest don't run) |

### 4.4 Iron rules

None added (the existing **IR-048** covers the manual version; after this version's automation, IR-048 can be downgraded to advisory).

### 4.5 Prod operations

- One-time backfill SQL (14 INSERTs)
- Deploys are fully automatic afterward

---

## 5. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------|------|------|
| Runner re-runs some SQL lacking `IF NOT EXISTS` → errors | Low (won't happen after backfill) | Medium | After backfilling the 14, new versions only run 015 onward; new SQL is required to use `IF NOT EXISTS` |
| Some SQL fails halfway → schema half-applied | Medium | High | Runner stops on failure + doesn't write that schema_migrations row; the next re-run retries (requires the SQL itself to be idempotent) |
| The schema_migrations table itself gets deleted by mistake | Low | High | 015 uses `IF NOT EXISTS`, so re-running rebuilds an empty table, but the applied records are lost → must backfill again. Recommend adding a read-only display in the admin UI |
| Backfill misses one (e.g. `db/backfill-iron-rule-codes.sql` is not a migration, it's a tool script) | Medium | Medium | The backfill list is drafted by the AI, decided by Vin; non-migration SQL is moved to a `db/tools/` subfolder, the runner only scans `db/NNN_*.sql` |
| Local development inconsistent with prod | Medium | Medium | The runner also supports local docker compose; a developer running `bash scripts/run-migrations.sh` can sync |

---

## 6. Decision record

| # | Topic | Options to decide |
|---|------|-----------|
| 1 | Tracking mechanism | A. schema_migrations table (recommended, this proposal) / B. host marker file / C. repo APPLIED.md |
| 2 | Scope | A. OwnMind only (recommended) / B. port to other internal projects along the way |
| 3 | Integration point | A. interactive-upgrade.sh runs automatically (recommended) / B. standalone script run manually |
| 4 | Backfill strategy | A. one-time SQL backfill of 14 (recommended) / B. add a check "DB already has memories table → treat 001~014 as applied" |
| 5 | non-migration SQL handling | A. move to `db/tools/` (recommended) / B. add a whitelist for the runner to skip |

**Vin's decision**: 1A / 2A / 3A / 4A / 5A (chosen in the previous conversation)

---

## 7. Next steps

1. ✅ Vin decides (done)
2. ⏳ Write `spec.md` (GIVEN/WHEN/THEN scenarios)
3. ⏳ Write `tasks.md` (task list)
4. ⏳ Follow TDD (IR-003): write test first → run red → implement → run green
5. ⏳ Local end-to-end test (docker compose with a clean DB)
6. ⏳ Backfill prod
7. ⏳ Run the runner once on prod to confirm idempotency
8. ⏳ Quality gate three steps (IR-012): verification → request review → handle review
9. ⏳ Sync README / FILELIST / CHANGELOG (IR-008 + IR-026 + IR-032)
10. ⏳ Sync version number in three places to v1.19.2 (IR-031)
11. ⏳ Tag v1.19.2, push, deploy prod
