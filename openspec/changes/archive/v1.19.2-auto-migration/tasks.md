# v1.19.2 — Auto Migration task list

> Per IR-003 (TDD): write the test before each implementation task
> Per IR-012 (quality gate three steps): verify → request review → handle feedback
> Per IR-008 (commit syncs README/FILELIST/CHANGELOG)

---

## Phase A: schema_migrations table

- [ ] A1. New file `db/015_schema_migrations_table.sql`
  - `CREATE TABLE IF NOT EXISTS schema_migrations(filename PK, applied_at, applied_by)`
  - Use `IF NOT EXISTS` to ensure idempotency
  - INSERT its own record (self-record)
- [ ] A2. Bring up the DB locally via docker compose and run once → confirm the table is created and the record is written

---

## Phase B: Runner logic

- [ ] B1. Write the test `tests/run-migrations.test.js` (scenarios 1 ~ 9)
  - happy path: first run, applies all SQL
  - idempotent: second run, all skipped
  - new addition: runs only the new one
  - stop on failure: broken SQL interrupts
  - backfill: skips records already present
  - non-migration skipped (`backfill-iron-rule-codes.sql`)
  - **Test implementation strategy**: use mock filesystem + mock psql command, pure-function testing of the runner's internal logic; DB end-to-end is done in phase D
- [ ] B2. New file `scripts/run-migrations.sh`
  - Detect the execution environment (docker exec vs direct psql)
  - Run 015 to ensure the table exists
  - List `db/[0-9][0-9][0-9]_*.sql`, sort
  - Compare against schema_migrations, run the unapplied ones
  - On failure, exit 1, don't write a record
  - Output format: `INFO:` / `OK:` / `ERROR:` prefix (consistent with bootstrap.sh)

---

## Phase C: interactive-upgrade integration

- [ ] C1. Change `scripts/interactive-upgrade.sh`: insert `bash scripts/run-migrations.sh` after `npm install`, before `docker restart`
- [ ] C2. Failure handling: runner exit != 0 → output `ERROR:migration:...` → abort upgrade (don't restart the api)
- [ ] C3. Add the same to the Windows version `interactive-upgrade.ps1` (via `bash` over WSL or call psql.exe directly)

---

## Phase D: end-to-end verification

- [ ] D1. Local: `docker compose down -v && docker compose up -d` → fresh DB → run runner → confirm all 15 applied and tables created
- [ ] D2. Local: run runner again → confirm everything is skipped
- [ ] D3. Local: manually add `db/099_test.sql` (`SELECT 1`) → run runner → confirm only 099 runs → delete the test file
- [ ] D4. Prod: backfill the 14 historical migrations (manual INSERT into schema_migrations)
- [ ] D5. Prod: run the runner once → confirm 015 runs (creates the table + self-records) → everything else skipped
- [ ] D6. Prod: live-test that `ownmind_save` works normally

---

## Phase E: docs sync (IR-008 + IR-026 + IR-032)

- [ ] E1. `README.md`: add "migrations auto-apply" explanation to the Deploy section
- [ ] E2. `docs/README.zh-TW.md`: sync Traditional Chinese version
- [ ] E3. `docs/README.ja.md`: sync Japanese version
- [ ] E4. `CHANGELOG.md`: add v1.19.2 entry
- [ ] E5. `FILELIST.md`: add 015 + run-migrations.sh + test file

---

## Phase F: version number + commit + tag + deploy

- [ ] F1. Sync version number in three places (IR-031): `package.json` v1.19.2, `SERVER_VERSION` 1.19.2, tag `v1.19.2`
- [ ] F2. Quality gate three steps (IR-012):
  - verification-before-completion: run the full test suite + lint
  - requesting-code-review: request review
  - receiving-code-review: handle feedback
- [ ] F3. Commit: per IR-009 (Vin contributor) + IR-024 (no Co-Authored-By) + IR-026 (README/FILELIST/CHANGELOG already synced)
- [ ] F4. Tag `v1.19.2` + push origin main + tag
- [ ] F5. Deploy prod: use `docker compose build` (IR-023) + `interactive-upgrade.sh` auto-runs migration
- [ ] F6. Post-deploy browser live-test (IR-020): open the admin UI, test ownmind_save / log_session once each
- [ ] F7. Downgrade IR-048 to advisory: the manual check is now automated, the reminder layer is downgraded

---

## Phase G: archive

- [ ] G1. Move this change folder to `openspec/changes/archive/v1.19.2-auto-migration/`
- [ ] G2. Update `openspec/specs/dashboard/spec.md` to add the migration runner scenario (if needed)
