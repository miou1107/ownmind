# Tasks

- [x] 1. Reproduce deterministically enough to study: 16 contenders, seeded leaked marker,
      12 CPU-saturating background processes → 10 double acquisitions in 240 rounds
- [x] 2. Trace the interleaving with append-only markers (a `date` subshell per trace point
      serialises the race and hides it) → three processes inside the section at once
- [x] 3. `hooks/ownmind-session-start.sh` — token on the marker; verify before deleting the
      lock and before deleting the marker
- [x] 4. `shared/update-lock.js` — the same (IR-022)
- [x] 5. Discard the two approaches that measured worse, and record why in the code
- [x] 6. Deterministic regression tests on both sides, driving the window with an injected
      pause rather than scheduling luck, each with a control that fails if nothing reclaims
- [x] 7. Make the test harness's lifted-function list grow from the source
- [x] 8. Mutation-test all six new assertions
- [x] 9. Re-measure: 500 rounds of the failing scenario, plus the ordinary case
- [x] 10. Version bump + CHANGELOG + FILELIST + three READMEs (IR-026, IR-032)
- [x] 11. `superpowers:verification-before-completion`
- [x] 12. `superpowers:requesting-code-review` + adversarial review (IR-072)
- [x] 13. Release and deploy (authorised 2026-08-11), then verify on production
