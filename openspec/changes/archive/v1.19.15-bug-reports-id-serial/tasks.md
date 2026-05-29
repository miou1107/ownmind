# v1.19.15 — bug_reports id changed to SERIAL task list

## Scope

- [x] Write proposal.md
- [ ] Write `db/017_bug_reports_id_to_serial.sql`
  - [ ] sanity check: RAISE EXCEPTION and refuse to run when tables are non-empty
  - [ ] DROP CASCADE the five tables (order: mutes → spam_blocks → spam_suspects → declines → bug_reports)
  - [ ] Rebuild the five tables, id using SERIAL, report_ids using INT[]
  - [ ] Rebuild all CHECK constraints
  - [ ] Rebuild all indexes
- [ ] Write `tests/migration-017-bug-reports-id-serial.test.js`
  - [ ] Confirm the file exists
  - [ ] Confirm the sanity check statement exists
  - [ ] Confirm all 5 DROP TABLE use CASCADE
  - [ ] Confirm all 5 CREATE TABLE use SERIAL (not BIGSERIAL)
  - [ ] Confirm report_ids is INT[], not BIGINT[]
  - [ ] Confirm all CHECK / index are rebuilt
- [ ] Version 1.19.14 → 1.19.15 (`package.json`)
- [ ] Add a v1.19.15 section to CHANGELOG.md
- [ ] Add a v1.19.15 section to FILELIST.md
- [ ] Update tri-lingual README version
- [ ] Run the full `node --test`, must be all green
- [ ] commit + push + tag v1.19.15
- [ ] kkvin.com deploy (pull / migration / build / up / smoke test confirming id is a number)

## Non-tasks

- ❌ Changing the existing memories / token_usage / install_check_logs tables (out of scope)
- ❌ Globally changing the node-pg type parser (would affect BIGINT counter columns)
- ❌ Changing the 016 migration (preserve history, override with 017)
