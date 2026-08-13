# Tasks — v1.26.171

- [x] Red tests: array trigger selects tagged rule; array with no match selects nothing;
      always-rules outrank tag-matches under budget (enforcement-judge.test.js)
- [x] Fix `matchesTag` (array any-of) + rank `trigger:always` at 0 (select-rules.js)
- [x] Red tests: skipped → loud notice; no credentials → loud notice; check id in block
      stderr (enforcement-compliance-step.test.js)
- [x] Fix `runComplianceStep` + `formatViolationFeedback` (compliance-step.js,
      compliance-client.js passes `enabled` through)
- [x] Red tests: notice branches emit systemMessage JSON on stdout, tty never opened
      (enforcement-reply-lint-wiring.test.js)
- [x] Replace writeToTty primary channel with stdout systemMessage in ownmind-reply-lint.js;
      spool demoted to audit record
- [x] Full test suite green; lint green
- [x] README ×3 / FILELIST / CHANGELOG
- [x] verification-before-completion → requesting-code-review → receiving-code-review
- [x] Commit on feat/enforcement-p0-channel; no tag, no deploy (IR-136: ask Vin)
