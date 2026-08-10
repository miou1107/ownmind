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

## 7. Ship

- [x] Full test suite
- [x] CHANGELOG + FILELIST + version bump
- [ ] Deploy — needs Vin. `db/024` must run before the new image serves traffic; the index
      build is on an empty table, so it is instant
