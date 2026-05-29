# v1.19.15 — bug_reports series id changed from BIGSERIAL to SERIAL

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: In progress
- **Estimated version**: v1.19.15 (hotfix-class patch)

---

## 0. One-line summary

Change the id column of the five bug_reports tables introduced in v1.19.14 from BIGSERIAL (64-bit auto-increment) to SERIAL (32-bit auto-increment), to avoid the node-pg package returning the id as a string by default, and to stay consistent with the existing memories table.

---

## 1. Design rationale

### 1.1 Inconsistency found in v1.19.14 smoke test

After deploying v1.19.14 and running the smoke test, we found:

```bash
$ curl -X POST /api/bug-reports ...
{"id": "1", "status": "new"}  ← id is a string
```

Compared with the existing memories table:

```bash
$ curl /api/memory/init
{"profile": {"id": 3, ...}}  ← id is a number
```

The difference is `BIGSERIAL` (64-bit, PostgreSQL type oid 20): the node-pg package returns bigint as a string by default, to avoid precision loss beyond the JS Number safe-integer limit (2^53 - 1, about 9 × 10^15). `SERIAL` (32-bit, oid 23) is automatically converted to a Number.

### 1.2 Why choose SERIAL (instead of setting a global type parser)

- A global `pg.types.setTypeParser(20, parseInt)` would affect the existing token_usage table's BIGINT counter columns (accumulated token counts may exceed the Number safe range and need to stay strings)
- Changing the schema is lower-risk and smaller-impact than changing the parser
- The bug_reports tables using SERIAL (2.1 billion limit) are more than enough (10,000 rows/day would take 575 years to exhaust)

---

## 2. Design scope

### 2.1 Change the id column of 5 tables

| Table | Old type | New type |
|---|---|---|
| `bug_reports.id` | BIGSERIAL | SERIAL |
| `bug_report_declines.id` | BIGSERIAL | SERIAL |
| `bug_report_spam_suspects.id` | BIGSERIAL | SERIAL |
| `bug_report_spam_blocks.id` | BIGSERIAL | SERIAL |
| `bug_report_notification_mutes.id` | BIGSERIAL | SERIAL |

### 2.2 Also change report_ids from BIGINT[] to INT[]

`bug_report_spam_suspects.report_ids` is `BIGINT[]`; it should align with the new INT type of `bug_reports.id` and be changed to `INT[]`.

### 2.3 Safety guarantee

Add a sanity check at the start of migration 017:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bug_reports LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_declines LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_spam_suspects LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_spam_blocks LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_notification_mutes LIMIT 1) THEN
    RAISE EXCEPTION 'bug_reports 系列表已有資料、不能用此 migration 改 id 型別、請手動處理（先匯出資料 → DROP → CREATE → 匯入）';
  END IF;
END $$;
```

If a table is non-empty, reject outright and take no risk.

### 2.4 Implementation approach

PostgreSQL cannot directly ALTER BIGSERIAL → SERIAL (the sequence type is locked in), and this time the tables are confirmed empty, so we pick the simplest approach: DROP + CREATE.

---

## 3. Workload

| Item | Lines |
|---|---|
| migration 017 SQL | 200 |
| migration 017 tests | 100 |
| Fix spec/proposal descriptions of BIGSERIAL | 0 (preserve v1.19.14 history) |
| Version + CHANGELOG + FILELIST + tri-lingual README | 50 |
| **Total** | about 350 lines |

Engineering time: about 30-45 minutes (including deploy + verification).

---

## 4. Risk checkpoints

- [ ] migration 017 refuses to run when tables are non-empty (sanity check works)
- [ ] migration 017 runs smoothly when tables are empty
- [ ] After running, the id of all five tables is INT, not BIGINT
- [ ] CHECK constraints and indexes are all rebuilt
- [ ] Full test suite (including the original v1.19.14 tests) is green
- [ ] After prod deploy, curl POST /api/bug-reports and verify the response id is a number, not a string
- [ ] Tri-lingual version 1.19.15
