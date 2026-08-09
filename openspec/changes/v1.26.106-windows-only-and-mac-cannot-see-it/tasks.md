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
- [x] Four `new URL().pathname` sites → `fileURLToPath()`.
- [x] `tests/git-bash-detection.test.js` — `-ExecutionPolicy Bypass`, and cmd.exe
      metacharacters escaped in the stub.
- [x] `tests/install-artifacts.test.js` — ENOTDIR instead of `chmod(0o000)`, which also
      removes the root special case.
- [x] `tests/installer-node-paths.test.js` — empty PATH instead of `/usr/bin:/bin`.
- [x] Two new suites, **neither requiring Windows** — that requirement is why these lived so
      long: `tests/windows-log-encoding.test.js` (18) and `tests/windows-test-hygiene.test.js`
      (267, growing with the number of test files).
- [x] Reverse-verified each fix — restore the defect, confirm the test goes red:

      | reverted | result |
      |---|---|
      | baseline | encoding 18/0, hygiene 265/0 |
      | `Tee-Object` back in install.ps1 | encoding **16/2** |
      | `-ExecutionPolicy Bypass` removed | hygiene **264/1** |
      | `CIM_TIMEOUT_MS` back to 5000 | hygiene **262/3** |

- [x] Windows, file by file, against an unmodified v1.26.102: `git-bash-detection` 13/2 →
      15/0; `install-artifacts` process crash → 16/0; `installer-node-paths` 22/1 → 23/0;
      `session-log-args` fail → 19/0; `source-files-are-text` fail → 6/0;
      `edit-trigger-reminder` 32/4 → 34/2.
- [x] Whole Windows-relevant subset, comparing failing test **names** rather than counts
      across two trees: 55 failing before, 39 after, **0 newly broken**, 16 fixed. The
      remaining 39 are identical on both sides and are that machine's environment (node
      cannot find `bash`).
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.106

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
