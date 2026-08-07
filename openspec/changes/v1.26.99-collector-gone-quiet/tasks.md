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
- [x] **Job.** `src/jobs/collector-silence-alerts.js` — record every silence, then
      claim-and-broadcast in one transaction, then write recoveries. The announce-once
      rule lives in the claim statement, not in JavaScript.
- [x] **Wiring.** `src/index.js` — boot sweep plus a 04:00 Asia/Taipei schedule.
- [x] **Tests.** 82 across four files: evaluator against the real production snapshot
      (including the ten machines that must stay quiet), both messages, the job with a
      stateful fake, migration and wiring, and the two timing constants pinned to the
      properties they exist to satisfy rather than to copies of their own values.
- [x] **Break every guard once, twice.** Fourteen mutations over two rounds. Four
      survived and every one was a real gap:
      - deleting the claim's `WHERE` clause changed nothing, because the fake implements
        that rule itself — the failure mode where both ends of an interface are ours;
      - swallowing the member broadcast's error changed nothing, because the admin insert
        then threw instead and the assertion could not tell them apart;
      - setting `CONFIRM_HOURS` to 0 and `REANNOUNCE_DAYS` to infinity changed nothing,
        for the same both-ends reason: the fake carried its own copies of both numbers.
      All four now have tests and all four mutations were re-run to confirm they fail.
      The mutation harness itself had a bug on the first attempt — the helper returned
      `cmp`'s exit status, so every applied mutation looked like a failure to apply and
      no test ever ran. Nine "survivors" were an instrument reading, not a result.
- [x] **Code review**, and act on it. Three Important findings, all reproduced, all
      fixed; the largest moved the announce-once decision out of JavaScript entirely.
      Recorded in proposal.md.
- [x] **Run what a fake cannot vouch for against the real database**, each in a
      rolled-back transaction, table confirmed absent afterwards: the migration (`\d`
      matched the intended shape) and the sighting/claim pair (0 just seen, 1 confirmed,
      0 same day, 1 after a fortnight, 0 once resolved, and a re-sighting reopening the
      row). Re-run after the review changed the claim's shape — the first probe validated
      a statement that no longer exists.
- [x] **Full suite**, after the review fixes.
- [x] Docs: CHANGELOG, FILELIST, README ×3, BACKLOG item 4 closed and its excluded half
      recorded, version bump.
- [ ] **Release.** Not authorised. v1.26.98 is also built and waiting; Vin said 「等等發」.
