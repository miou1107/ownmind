# v1.26.99 — tasks

- [x] **Measure before choosing thresholds.** Dump every `collector_heartbeat` row on
      production with ages, plus last usage event and last init per person. Result: one
      machine disagrees with itself (0.2d vs 11.2d), ten do not (freshest == stalest),
      longest healthy silence 4.2 days. Thresholds follow from that, not from a guess.
- [x] **Extract the delivery envelope.** `src/lib/broadcast-envelope.js`, with
      `install-check-alert-message.js` importing it. Two callers is the threshold; a second
      implementation of "what reaches the reader" would be two answers to one question.
      Verified by the existing 21 tests, unchanged.
- [x] **Migration.** `db/023_collector_silence_alert_state.sql`, keyed `(user_id, machine)`,
      carrying `broadcast_id INTEGER REFERENCES broadcast_messages(id) ON DELETE SET NULL`.
- [x] **Evaluator.** `src/lib/collector-silence.js` — pure, clock injected.
- [x] **Messages.** `src/lib/collector-silence-message.js` — one per audience.
- [x] **Job.** `src/jobs/collector-silence-alerts.js` — claim-then-broadcast in one
      transaction, resolve and detail updates outside it.
- [x] **Wiring.** `src/index.js` — boot sweep plus a 04:00 Asia/Taipei schedule.
- [x] **Tests.** 44 across four files: evaluator against the real production snapshot
      (including the ten machines that must stay quiet), both messages, the job with a
      stateful fake, migration and wiring.
- [x] **Break every guard once.** Ten mutations. Eight were caught immediately; two
      survived and were real gaps, not test noise:
      - deleting the claim's `WHERE` clause changed nothing, because the fake implements
        that rule itself — the failure mode where both ends of an interface are ours;
      - swallowing the member broadcast's error changed nothing, because the admin insert
        then threw instead and the assertion could not tell them apart.
      Both now have tests, and both mutations were re-run to confirm they fail.
- [x] **Run the two things a fake cannot vouch for against the real database**, each in a
      rolled-back transaction, table confirmed absent afterwards: the migration (`\d`
      matched the intended shape) and the claim statement (1 / 0 / 1 across fresh, already
      announced, after recovery).
- [x] **Full suite.** 3514 pass, 0 fail, 2 skipped.
- [x] Docs: CHANGELOG, FILELIST, README ×3, BACKLOG item 4 closed and its excluded half
      recorded, version bump.
- [ ] **Release.** Not authorised. v1.26.98 is also built and waiting; Vin said 「等等發」.
