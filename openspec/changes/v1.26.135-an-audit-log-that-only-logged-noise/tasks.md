# v1.26.135 — Tasks

## 1. Measure before changing anything

- [x] Count `usage_audit_log` by `event_type` on production — 253,409 rows, all
      `unknown_model`, none of any other type
- [x] Break the count down by model over 14 days — every model listed is in daily use
- [x] Trace the allowlist to `model_pricing` and confirm its newest Anthropic entry predates
      the models in the breakdown

## 2. Tests first

- [x] `records unknown_model once per model, not once per message` — fails before the change
- [x] `does not record unknown_model again for a model already reported` — fails before
- [x] `still reports each distinct unknown model in a mixed batch` — fails before
- [x] `keeps token_regression per-message` — guards the rule against spreading to other types
- [x] Confirm all three new tests are red against the unmodified implementation, then green
      after (26 pass / 3 fail → 30 pass / 0 fail)

## 3. Implementation

- [x] `lookupReportedUnknownModels()` — which of the batch's unknown models already have a row
- [x] Claim one message per model key per batch; the rest audit nothing
- [x] `db/024` partial unique index on `(tool, details->>'model')` where
      `event_type = 'unknown_model'`
- [x] `ON CONFLICT DO NOTHING` on the audit insert, so the race loser is dropped rather than
      logged as a write failure

## 4. Production data

- [x] Dump the table to `/VinService/ownmind-backups/usage_audit_log-20260810.sql.gz` (8.4 MB)
- [x] Truncate `usage_audit_log`; verify 0 rows and that `token_events`,
      `token_usage_daily`, `activity_logs` and `audit_logs` are untouched

## 5. Code review round

Three findings, all real, all fixed:

- [x] **Critical — a replayed first message ate the model's audit claim.** The claim was made
      before the insert loop, so if the batch's first event for a new model came back as a
      duplicate, nothing was written and every later event for that model was skipped. A
      genuinely new model could go unrecorded forever, and replays are normal traffic. Claim
      moved to insert time, inside `if (insertRes.inserted)`.
- [x] **Important — `db/024` would abort server boot on any database still holding the old
      rows.** `CREATE UNIQUE INDEX` raises on existing duplicates and `IF NOT EXISTS` matches
      on index *name*, so it never looked. The runner throws, startup aborts, and the file is
      only recorded on success — a crash-loop. A `DELETE` collapsing duplicates now runs first.
- [x] **Important — the four new tests did not test the change.** Removing both halves of the
      application de-dup left the suite green: the fake DB's index emulation carried every
      assertion on its own, and the ON CONFLICT path was never driven. The fake now counts
      *attempted* writes, and three cases were added: the replay above, an all-replay batch,
      and a stale lookup that forces the conflict path.
- [x] **Minor — bare `ON CONFLICT DO NOTHING` swallowed unrelated unique violations.** Arbiter
      named.

## 6. Verify the guards actually fire

- [x] Mutant A — delete the in-batch claim → `records unknown_model once per model` goes red
- [x] Mutant B — restore the exact reviewed bug (claim before the insert loop) → `a replayed
      first message must not consume the model's one chance` goes red
- [x] Restore from backup; 33/33 green
- [x] `db/024` run verbatim against production Postgres inside a rolled-back transaction,
      seeded with duplicates: DELETE 2, index created, second run a no-op, `token_regression`
      rows untouched, named arbiter drops the duplicate `unknown_model` and still inserts
      other types. Rollback verified — production still 0 rows, no index

## 7. Second review round

An independent pass, told not to trust §5. Two Important, four Minor, no Critical.

- [x] **Important — the mechanism this change is named after had no test.** Neutering
      `lookupReportedUnknownModels()` to always return empty, and separately dropping the
      `alreadyReported` filter, both left the suite 33/33 green. The cross-batch case asserted
      only `state.audits.length === 1`, which the fake index produces on its own. §5 fixed the
      in-batch half of exactly this defect and left the cross-batch half. Added the
      `auditAttempts === 0` assertion; both mutants now go red.
- [x] **Important — the duplicate-collapsing DELETE was quadratic.** `DELETE ... USING ...
      WHERE a.id > b.id` materialises every duplicate *pair*, and this table's shape is the
      worst case: 253,409 rows over six keys. Measured on a Postgres 16 seeded to that exact
      shape — planner estimate 95,539,188 join rows, still running when cancelled at 3m59s.
      There is no `statement_timeout` on the pool and the migration runner blocks `listen()`,
      so it would not abort, it would hold the server down. §6 validated this with two rows,
      which is why the cost never showed. Rewritten as `id NOT IN (SELECT min(id) ... GROUP
      BY)`: **527 ms**, same survivors.
- [x] **Minor — a model name containing `::` was truncated by the key split.** Keys are
      `tool::model` strings and `split('::')` took the wrong half, so the lookup asked about a
      model nobody had written and always answered "not reported" — one INSERT attempt per
      batch forever, absorbed by the index, visible nowhere. `splitKey()` splits on the first
      separator only; applied to the session lookup too, which had the same latent bug.
- [x] **Minor — rollback direction documented.** See the deploy note below.
- [x] **Minor — cross-user and case-sensitivity semantics written into the spec.** Both were
      correct but undocumented, and the admin audit page's `user_id` filter makes the first
      one easy to misread.
- [x] **Minor — doc drift.** FILELIST said 4 new tests, CHANGELOG said three review findings.

## 8. Re-verify after the second round

- [x] Mutant C — `lookupReportedUnknownModels` returns empty → `does not record unknown_model
      again for a model already reported` goes red
- [x] Mutant D — ignore the lookup result (`new Set(unknownKeys)`) → same test goes red
- [x] Mutant E — `splitKey` back to `k.split('::')` → the embedded-`::` test goes red
- [x] Restored from backup each time; 34/34 green
- [x] `db/024` verbatim against Postgres 16 seeded to production's shape (253,409 rows over
      six keys, plus `token_regression`, `fingerprint_mismatch`, a NULL-`tool` duplicate pair
      and a pair with no `model` key): DELETE 253,403 in 527 ms, survivors are exactly the
      lowest id per key, every other event type untouched, and the NULL-`tool` and no-`model`
      duplicates left alone — a unique index treats those NULLs as distinct, so collapsing
      them would have deleted rows the index permits. Index then built on top. Second run
      `DELETE 0`, third run on an empty table `DELETE 0` — idempotent both ways.
- [x] Named arbiter re-checked against the real index: same model under a different `tool`
      inserts, `token_regression` for the same model inserts twice, the duplicate
      `unknown_model` from a different user is dropped
- [x] Test container removed

## 9. Ship

- [x] Full test suite
- [x] CHANGELOG + FILELIST + version bump
- [ ] Deploy — needs Vin. `db/024` must run before the new image serves traffic; the index
      build is on an empty table, so it is instant.
      **Rolling back is not free.** If the image goes back to v1.26.131 or earlier while the
      index stays, the old `writeAudit` has no `ON CONFLICT` and every `unknown_model` write
      past the first raises a unique violation, logged as `usage_audit_log write failed` —
      about 6,700 error lines a day. No data is lost. Drop
      `uq_usage_audit_unknown_model` as part of any rollback.
