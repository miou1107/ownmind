# v1.26.140 — Tasks

## 1. The updater's empty-file failure

- [x] Reproduce under real PowerShell before changing anything — empty target throws,
      missing and non-empty targets do not
- [x] Extract `Add-OwnMindUpgradeRule` into `scripts/windows/lib/append-upgrade-rule.ps1`
- [x] Treat a null read as `''`
- [x] Return `written` / `skipped`; throw on anything else
- [x] Write BOM-less UTF-8 via `WriteAllText`
- [x] `update.ps1` counts results, names failures, and no longer prints a fixed `[ OK ]`
- [x] Warn rather than skip silently when the helper is missing from the checkout
- [x] Behavioural tests under pwsh (`tests/append-upgrade-rule.test.js`), skipped with a
      visible reason where pwsh is absent
- [x] Static tests pinning the fragile pattern out of `update.ps1`
- [x] Verify the behaviours in real PowerShell under `Set-StrictMode -Version Latest`
      (container, pwsh 7) — 6 cases, all pass
- [x] Confirm `scripts/update.sh` does not share the null crash (it does not — Node's
      `readFileSync` returns `''`)

## 2. The gateway that was blamed for a size limit

- [x] Measure what the gateway actually accepts: 40,214-byte probe → 200; route's real
      35,301-byte body → 502 during the window, 200 on six replays after it
- [x] Correct the 40 KiB ceiling claim in `narrative-condense.js` and `me-narrative.js`
- [x] Retry 408 / 429 / 5xx and transport failures in `callLLMSwitch`
- [x] Do not retry 4xx the gateway will repeat
- [x] Overall deadline that also clamps each attempt's timeout
- [x] Report the number of attempts spent in the thrown error
- [x] Keep 2,000 characters of the upstream reply instead of 200
- [x] Tests, with mutation checks: dropping 429, defaulting retries to 0, narrowing the
      excerpt, removing the attempt count, and retrying every status were each caught

## 3. Review round

- [x] Real abort instead of a hand-built `AbortError` — the fake one hid a TypeError that
      destroyed every timeout error
- [x] Stop mutating caught errors; the final message is a new `Error` with `cause`
- [x] Classify at the point of failure instead of matching words in the message, so a report
      that mentions a network error is not retried
- [x] Check the deadline before starting an attempt, not only after one fails
- [x] `retries: -1` still makes one attempt
- [x] Read with `[System.IO.File]::ReadAllText` — `Get-Content -Raw` decodes a BOM-less file
      by the system code page on PowerShell 5.1, which would mangle the user's own Chinese
      on the update after this one
- [x] Same for the snippet itself: a live defect predating this change, since
      `ownmind-upgrade-agents-snippet.md` is UTF-8 with Chinese and no BOM
- [x] Non-ASCII round-trip test, run twice
- [x] `Set-StrictMode -Version Latest` in the test runner, matching what `update.ps1` sets
- [x] Fix the summary-line test, which was matching the WARN line and would have passed
      against the fixed `[ OK ]` string it exists to forbid
- [x] `update.sh`: counted summary, no `|| true` on the strip; tests drive the block lifted
      out of the real script, with mutation checks

### Second round

- [x] A body that stalls after the headers arrive is retried, and reported readably — the
      body read was outside the classification, so it escaped as a raw DOMException
- [x] Clamp the inter-attempt sleep to the deadline, so the documented 60 seconds is true
- [x] `retries: NaN` guarded with `Number.isFinite`
- [x] Build the request URL once, before the loop — an unusable `apiBase` is not retried
- [x] `update.sh`: `cat` checked on its own, so an unreadable snippet is a failure rather
      than an empty rule block reported as written
- [x] Mutation checks on all four JS guards, and on the shell one

## 4. Release

- [x] `package.json` → 1.26.140
- [x] CHANGELOG
- [x] README × 3 (en / zh-TW / ja)
- [x] FILELIST
- [ ] Full suite green
- [ ] Code review
- [ ] Verify on production after deploy — Vin decides when
