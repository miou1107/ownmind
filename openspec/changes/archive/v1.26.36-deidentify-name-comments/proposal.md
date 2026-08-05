# v1.26.36 — De-identify the owner name in code comments + source-scan guard

## One-Line Summary

After v1.26.35 removed the owner name "Vin" from user-facing generated output,
12 developer-facing comments across product code still referenced "Vin" as
project history. This change neutralizes them and adds a source-scan guard so
the name cannot reappear in product code.

## Why

- Completes the name de-identification for an international/OSS codebase: outside
  contributors reading the code should not meet a specific owner's name in
  comments. (These are not multi-user leaks like the generated output was —
  they're accurate history — but the user asked to clean them for consistency.)
- Enforced with logic, not a reminder: a guard test that fails on `\bVin\b` /
  `\bVincent\b` in product code files.

## Current State (before)

12 comment references to "Vin" (e.g. `// Per Vin's spec`, `Vin's 3 specs`,
`a need Vin raised`, an example path `/c/Users/Vin/.ownmind`) across
iron-rule-origin-context.js, run-migrations.js, iron-rule-suggest.js, me.js,
compose-tool-response.js, ownmind-tty-echo.cjs, ownmind-reply-lint.js,
language-lint.js, ownmind-session-start.sh, conditional-sync.js,
flush-compliance-spool.js.

## Fix

- Reword each comment to drop the name while keeping the meaning
  (`Vin's spec` → `spec`, `a need Vin raised` → `a need the user raised`, the
  example path → `/c/Users/<user>/.ownmind`, etc.).
- Extend `tests/no-hardcoded-names-in-output.test.js` with a source-scan over
  src/mcp/hooks/shared/client-src (code file extensions) asserting no
  `\bVin\b`/`\bVincent\b`.

## Non-Goals

- `mcp/package.json` `author: "Vin (miou1107)"` and the
  `github.com/miou1107/ownmind` install/repo URLs are legitimate authorship and
  distribution metadata, kept. (`.json` is not a scanned code file.)

## Release

Final change in the batch. Tag v1.26.36 + deploy covers v1.26.32-36 as one
user-facing upgrade.
