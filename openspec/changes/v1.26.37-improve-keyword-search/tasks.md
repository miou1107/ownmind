# v1.26.37 tasks

## RED (IR-003 TDD, write test before impl)

- [ ] Add `tests/memory-search.test.js` covering:
  - multi-token AND (`"iron rule sync"` finds memory titled "iron_rule sync" but not one that only has "iron")
  - tag hit only (query matches nothing in title/content, matches a tag)
  - code hit only (query matches nothing else, matches `code` column, e.g. `IR-042`)
  - case-insensitive
  - title-hit ranks above content-hit
  - `q=`, `q=" "`, tokens all whitespace → 400
- [ ] Run: tests fail (RED)

## GREEN

- [ ] Rewrite `GET /api/memory/search` handler in `src/routes/memory.js` (~L864)
  - tokenize q, cap ~10 tokens, drop empties
  - build parameterized `AND` where each token is `(title ILIKE $X OR content ILIKE $X OR code ILIKE $X OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $X))`
  - add `ORDER BY (title ILIKE first-token) DESC, updated_at DESC`
- [ ] Run: all new tests pass, existing test suite green

## Option C — cleanup misleading semantic claims

- [ ] `mcp/index.js:229` tip → describe multi-keyword match
- [ ] `mcp/index.js` `_offline_notice` → describe actual offline behavior
- [ ] `src/routes/memory.js` `INSTRUCTIONS_SOP` (~L294) → drop "semantic query"
- [ ] `README.md`, `docs/README.zh-TW.md`, `docs/README.ja.md` → retire "semantic search built in" bullet, note keyword search + roadmap
- [ ] Optional: add a one-liner grep-based guard test that fails on `"semantic search"` re-appearing in tool tips (light-touch)

## Bug #7-A follow-up (backlog only, no code)

- [ ] Save a project memory `bug_7a_semantic_search_backlog` capturing: root cause, why deferred, decision points needed (embedding provider, budget, backfill strategy), pointer to `db/001_init.sql:42` + `src/routes/memory.js:1047`

## Docs + version sync (IR-121, IR-130)

- [ ] `package.json` version → `1.26.37`
- [ ] `src/config.js` or wherever `SERVER_VERSION` lives → 1.26.37
- [ ] `CHANGELOG.md` entry
- [ ] `FILELIST.md` if any new files added
- [ ] README (3 langs) — only if user-facing behavior surfaces there (search description likely yes)

## Quality gates (IR-045)

- [ ] `superpowers:verification-before-completion` — run tests, run lint, verify claims
- [ ] `superpowers:requesting-code-review` — general-purpose subagent, review scoped diff
- [ ] `superpowers:receiving-code-review` — act on findings

## Release

- [ ] Commit, push
- [ ] `git tag v1.26.37 && git push --tags`
- [ ] Deploy kkvin.com: `git pull && docker compose build --no-cache && docker compose up -d`
- [ ] Verify: `docker exec ownmind-api node -p 'require("/app/package.json").version'` returns `1.26.37`
- [ ] Live smoke: from MCP, save a memory with a distinctive tag, `ownmind_search` with that tag alone, confirm it's found
