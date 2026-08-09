# v1.26.106 — Tasks

- [x] Establish the common cause rather than treat four bugs as four accidents: no CI
      (`.github/` holds only `CODEOWNERS`), so Windows-only paths are skipped or unreachable
      on the machine where tests actually run.
- [x] Measure the log corruption on the affected machine: 298 bytes, 148 NULs, `fffe` BOM;
      every `register-task-*.log` on it, oldest dated 2026-05-09. Confirm the cause by listing
      `Tee-Object`'s parameters on Windows PowerShell 5.1 — no `-Encoding`.
- [x] Connect it to v1.17.83 rather than treating it as cosmetic: one NUL, Postgres rejects
      the JSONB document, INSERT fails, retry spool resends forever.
- [x] Measure the CIM call five times on an idle Windows 10: 1494 / 1515 / 1462 / 1460 /
      1457 ms against a 5000 ms budget, and reproduce the 2026-08-09 failure verbatim by
      lowering the timeout to 600 ms.
- [x] Confirm the detector is not the defect before changing the test: run `Test-IsGitBash`
      against a hand-written stub → `True`. The test's `.cmd` stub was the problem.
- [x] `scripts/install-helpers/read-text-file.cjs` — decode by BOM; `stripNul`,
      `stripNulEscapes`.
- [x] `install.ps1` — `Write-Utf8NoBom` for the register log, `Write-Host` for the screen
      output `Tee-Object` also provided, `$LASTEXITCODE` read on the next line.
- [x] `scripts/install-helpers/self-check.cjs` — read by BOM; `CIM_TIMEOUT_MS` 5000 → 30000;
      `describeSpawnFailure()`; upload and spool share one `serializeReport()`.
- [x] Six `new URL().pathname` sites across four test files → `fileURLToPath()`
      (`install-artifacts` 1, `session-log-args` 1, `source-files-are-text` 2,
      `installer-node-paths` 2).
- [x] `tests/git-bash-detection.test.js` — `-ExecutionPolicy Bypass`, and cmd.exe
      metacharacters escaped in the stub.
- [x] `tests/install-artifacts.test.js` — ENOTDIR instead of `chmod(0o000)`, which also
      removes the root special case.
- [x] `tests/installer-node-paths.test.js` — empty PATH instead of `/usr/bin:/bin`.
- [x] Two new suites, **neither requiring Windows** — that requirement is why these lived so
      long: `tests/windows-log-encoding.test.js` (20) and `tests/windows-test-hygiene.test.js`
      (288, growing with the number of files scanned).
- [x] Reverse-verified each fix — restore the defect, confirm the test goes red. Re-measured
      after review, on the final tree:

      | reverted | result |
      |---|---|
      | baseline | encoding 20/0, hygiene 288/0 |
      | `Tee-Object` back in install.ps1 | encoding **18/2** |
      | `-ExecutionPolicy Bypass` removed | hygiene **287/1** |
      | `CIM_TIMEOUT_MS` back to 5000 | hygiene **287/1** |
      | bare `.pathname` back in the commit-msg hook | hygiene **287/1** |

      The earlier draft of this table claimed three failures for the `CIM_TIMEOUT_MS` revert.
      Measured, it is one: both call sites still reference the constant, so the "both
      functions use it" case stays green and only the budget assertion fires. Three would
      require reverting the call sites too, which is a different revert than the label says.

- [x] Windows, file by file, against an unmodified v1.26.102: `git-bash-detection` 13/2 →
      15/0; `install-artifacts` process crash → 16/0; `installer-node-paths` 22/1 → 23/0;
      `session-log-args` fail → 19/0; `source-files-are-text` fail → 6/0;
      `edit-trigger-reminder` 32/4 → 34/2.
- [x] Whole Windows-relevant subset, comparing failing test **names** rather than counts
      across two trees: 55 failing before, 39 after, **0 newly broken**, 16 fixed. The
      remaining 39 are identical on both sides and are that machine's environment (node
      cannot find `bash`).
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.106

## Found in review

- [x] The guard scanned `tests/` only. The same defect was live in shipping code:
      `hooks/ownmind-git-commit-msg.js` resolved its own directory through a bare
      `.pathname`, so on Windows its `../shared/helpers.js` import could not resolve — and
      that hook exits 0 on any failure by design, so every commit-message rule introduced one
      release earlier was silently unenforced there. Fixed, and the guard now walks `hooks/`,
      `mcp/`, `scripts/`, `shared/` and `src/` as well.
- [x] The guard picked its subjects with a case-sensitive quoted `powershell`, so
      `tests/install-failed-beacon-ps1.test.js` — which spawns through a `PWSH` const — was
      never inspected, and it was violating the Bypass rule. Selection widened to
      `/pwsh|powershell/i`; the argument-array pattern no longer requires `'-NoProfile'` to be
      the first element or single-quoted.
- [x] `stripNulEscapes` could turn a valid payload into unparseable JSON. It removed the
      six-character sequence wherever it appeared, including when the leading backslash was
      itself escaped — i.e. when the source text literally contained those characters. The
      result is a lone backslash escaping the next character, a document the server rejects,
      and a spool that retries it: the v1.17.83 loop, produced by the function written to
      prevent it. Now counts the preceding backslashes.
- [x] `retrySpool` wrote back to the spool with `JSON.stringify`, which is the third caller
      the comment on `serializeReport` warns against, in the same file.
- [x] `describeSpawnFailure({})` returned an empty string, so a malformed result uploaded as
      `Get-ScheduledTask failed: ` with nothing after the colon.

## Corrected mid-flight

- The first NUL fix searched the serialized text for a raw NUL, which `JSON.stringify` has
  already turned into an escape sequence — so it found nothing and reported success, while
  the escape sequence is precisely what Postgres rejects. A test caught it; `stripNulEscapes`
  exists because of that.
- An explanatory comment was placed between `& powershell ...` and
  `$regExit = $LASTEXITCODE`. `install-ps1-scanner-task-check.test.js` reads 600 characters
  forward from the script name and requires the check inside that window; the comment pushed
  it to 703, so a file that did perform the check was scored as not performing it. The
  comment moved above the block, with a line left in place explaining why it cannot go back.

## Renumbered on merge

Written and reviewed as v1.26.104, stacked on the branch that was then v1.26.103. Both
numbers were taken by work that landed first, so this release moved to 1.26.106 and its base
to 1.26.105 — CHANGELOG section, `package.json`, and the in-code version annotations. Nothing
else changed.
