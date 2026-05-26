# v1.22.0 — Tasks

## Phase 1: Survey

- [x] Locate all Chinese `description:` strings in `mcp/index.js` (TOOLS array, lines 420-734)
- [x] Locate all Chinese `console.*` strings in `hooks/ownmind-git-pre-commit.js` and `hooks/ownmind-git-post-commit.js`

## Phase 2: Translation — MCP descriptions

Translate per glossary in proposal.md. Preserve `⚠️`, examples, optional/required annotations, behavioral imperatives.

- [ ] `ownmind_init` description
- [ ] `ownmind_get` description + `type` enum description
- [ ] `ownmind_search` description + `query` description
- [ ] `ownmind_save` description (large) + all sub-field descriptions
- [ ] `ownmind_update` description + all sub-field descriptions
- [ ] `ownmind_disable` description + sub-fields
- [ ] `ownmind_handoff_create` description + sub-fields
- [ ] `ownmind_handoff_accept` description + sub-fields
- [ ] `ownmind_log_session` description + nested `details` sub-fields
- [ ] `ownmind_get_secret` / `ownmind_list_secrets` / `ownmind_set_secret` / `ownmind_delete_secret`
- [ ] `ownmind_report_compliance` description + sub-fields
- [ ] `ownmind_upload_standard` description + sub-fields
- [ ] `ownmind_confirm_upload` description + sub-fields
- [ ] `ownmind_report_bug` description (large, includes critical AI protocol) + sub-fields
- [ ] `ownmind_session_off` description + `reason` description
- [ ] `ownmind_session_on` description

## Phase 3: Translation — Hook console messages

- [ ] `ownmind-git-pre-commit.js:182` — session-off notice
- [ ] `ownmind-git-pre-commit.js:257` — validator unavailable warning
- [ ] `ownmind-git-pre-commit.js:318` — pre-commit error fallback
- [ ] `ownmind-git-post-commit.js:77` — validator unavailable warning
- [ ] `ownmind-git-post-commit.js:121-122` — version tag reminder
- [ ] `ownmind-git-post-commit.js:131` — commit-time audit warning
- [ ] `ownmind-git-post-commit.js:139` — violation logged guidance
- [ ] `ownmind-git-post-commit.js:147` — post-commit error fallback

## Phase 4: Verification

- [ ] `rg '[\p{Han}]' mcp/index.js` shows only `// ...` comment matches, no `description:` matches
- [ ] `rg 'console\.(log|error|warn).*[\p{Han}]' hooks/ownmind-git-*.js` returns 0 results
- [ ] `node --check mcp/index.js` syntax-OK
- [ ] `node --check hooks/ownmind-git-pre-commit.js` syntax-OK
- [ ] `node --check hooks/ownmind-git-post-commit.js` syntax-OK
- [ ] `npm test` passes
- [ ] MCP server starts cleanly: `timeout 3 node mcp/index.js < /dev/null` exits without throwing
- [ ] Manual smoke: open Claude Code, confirm MCP tool list shows English descriptions

## Phase 5: Release

- [ ] Bump `package.json` version: `1.21.0` → `1.22.0`
- [ ] Add `CHANGELOG.md` entry for v1.22.0
- [ ] Update `FILELIST.md` with changed-file note
- [ ] Sync README trilingual version badges (`README.md`, `docs/README.zh-TW.md`, `docs/README.ja.md`)
- [ ] Vin reviews diff
- [ ] Commit with conventional-commit message
- [ ] `git tag v1.22.0`
- [ ] Archive this change folder: `mv openspec/changes/v1.22.0-i18n-user-facing openspec/changes/archive/`
