# v1.19.2 — Auto Migration spec (GIVEN / WHEN / THEN)

> BDD three-part form (precondition / action / expected result). Runner behavior, table structure, externally observable behavior of the integration point.

---

## Scenario 1: first runner run, schema_migrations table doesn't exist yet → auto-create table

**GIVEN**

- A brand-new OwnMind deployment (fresh install), the `schema_migrations` table doesn't exist
- The `db/` directory has `001_init.sql` ~ `015_schema_migrations_table.sql`, 15 SQL files total

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- The `schema_migrations` table is created successfully (created by `015_schema_migrations_table.sql`)
- All 15 SQL files have run, `schema_migrations` has 15 records
- exit code = 0
- stdout contains the "→ applying NNN_xxx.sql" message for each migration

---

## Scenario 2: runner runs a second time, all migrations already applied → all skipped

**GIVEN**

- The `schema_migrations` table already exists, containing 15 records
- No additions to `db/*.sql`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- Doesn't run any `psql -f`
- stdout contains "✓ skip NNN_xxx.sql (already applied)" x15
- stdout ends with "✅ no new migration, DB schema is up to date"
- exit code = 0
- `schema_migrations` row count is still 15

---

## Scenario 3: add one migration → run only that new one

**GIVEN**

- The `schema_migrations` table contains 015 records
- The developer adds `db/016_add_user_avatar.sql`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 1 ~ 15 all skipped (records already present)
- 16 runs `psql -f db/016_add_user_avatar.sql`
- After running, `INSERT INTO schema_migrations(filename) VALUES('016_add_user_avatar.sql')`
- `schema_migrations` row count = 16
- exit code = 0

---

## Scenario 4: some migration SQL fails → runner stops on failure, doesn't write a record

**GIVEN**

- `schema_migrations` contains 015 records
- The developer adds `db/016_broken.sql` (containing a syntax error)
- The developer adds `db/017_should_not_run.sql`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 016 attempts `psql -f`, psql returns exit code != 0
- The runner exits immediately, doesn't run 017
- `schema_migrations` doesn't write the 016 row (nor 017)
- exit code = 1
- stderr contains "❌ migration 016_broken.sql failed, stopping"

---

## Scenario 5: after backfill, run the runner again → existing SQL not re-run

**GIVEN**

- Prod has been running for a while, tables like `memories` already exist, but `schema_migrations` doesn't
- Run the backfill SQL (INSERT 14 records 001 ~ 014) + run `015_schema_migrations_table.sql`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 001 ~ 015 all skipped (records present, including the 14 just backfilled + 015 also INSERTs itself when the table is created)
- No new migration → "✅ no new migration, DB schema is up to date"
- exit code = 0
- Existing data is completely untouched

---

## Scenario 6: the runner auto-creating the schema_migrations table also counts as a migration

**GIVEN**

- Brand-new DB, `schema_migrations` doesn't exist
- `db/015_schema_migrations_table.sql` exists

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- When 015 runs it creates the table + INSERTs its own 015 record (self-recording)
- After 015 has run, 016+ can use `INSERT INTO schema_migrations`
- Order guaranteed: the runner first runs 001 ~ 014 (with try-catch; the INSERT fails when the table isn't yet created, so 001 ~ 014 don't write the table after running) → runs 015 to create the table + back-fill 001 ~ 015, 15 records total

**Design simplification**: to avoid the chicken-and-egg problem, the runner instead `psql -f 015_schema_migrations_table.sql` (with `IF NOT EXISTS`, safe) right at the start, then begins the normal loop.

---

## Scenario 7: interactive-upgrade integration — migration fails → don't restart API

**GIVEN**

- Prod runs `interactive-upgrade.sh`
- Pulls a version containing a broken migration

**WHEN**

upgrade reaches the `run-migrations.sh` step

**THEN**

- The runner fails, exit 1
- interactive-upgrade.sh detects the runner failure, outputs `ERROR:migration:some migration failed`
- **Does not run** `docker restart ownmind-api`
- Leaves the old version api still serving (avoids new code with old schema)
- Writes a log to `logs/upgrade-<timestamp>.log` containing the migration failure stack

---

## Scenario 8: interactive-upgrade integration — migration succeeds → normal restart

**GIVEN**

- Prod runs `interactive-upgrade.sh`
- Pulls a version containing a new migration

**WHEN**

upgrade reaches the `run-migrations.sh` step

**THEN**

- The runner finishes, exit 0
- Outputs `OK:migration:N migrations applied` (N is the actual number applied)
- Continues to `docker restart ownmind-api`
- The upgrade flow completes normally

---

## Scenario 9: non-migration SQL (such as backfill-iron-rule-codes.sql) → runner skips it

**GIVEN**

- The `db/` directory contains `backfill-iron-rule-codes.sql` (no NNN_ prefix, it's a tool script)

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- The runner only scans files matching the `db/[0-9][0-9][0-9]_*.sql` glob
- `backfill-iron-rule-codes.sql` is ignored, not run, not written to schema_migrations
- exit code = 0

---

## Scenario 10: the runner reads DB connection parameters from environment variables

**GIVEN**

- Environment variables `DB_HOST=ownmind-db`, `DB_USER=ownmind`, `DB_NAME=ownmind`, `DB_PORT=5432`
- Or in a docker environment, the runner uses `docker exec ownmind-db psql -U ownmind -d ownmind`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- The runner prefers `docker exec ownmind-db` (detecting the container exists)
- Otherwise falls back to `psql` direct connection (reading `DB_HOST` and other environment variables)
- Both modes work, unifying local and prod
