# v1.23.0 — Tasks

## Phase 1: Translation — `hooks/ownmind-session-start.js`

- [ ] Brand banner line 73 `[OwnMind v${server_version}] Memory loaded: your personal memories are now active`
- [ ] `## Iron rules (strictly enforced)` header
- [ ] `## Working principles` header
- [ ] `## Pending handoff` header
- [ ] `Project: ${name}` line
- [ ] `## Bug report notifications` header
- [ ] Admin / reporter notification message bodies
- [ ] Hint line under bug report notifications
- [ ] Footer line about `ownmind_* MCP tools`

## Phase 2: Translation — `hooks/lib/render-session-context.js`

- [ ] `## 📢 OwnMind broadcast` header
- [ ] CTA upgrade hint (`let the AI run the upgrade`)
- [ ] Snooze hint (`(Not ready? Say "snooze upgrade" to defer for ${h} hours)`)
- [ ] Remaining-broadcasts line (`(N more broadcast(s) not shown)`)
- [ ] `[SYSTEM] Action required:` mandatory broadcast prompt (preserve imperative force)
- [ ] Brand banner Memory loaded line
- [ ] Iron rules header with tier counts
- [ ] Working principles header
- [ ] Pending handoff header + Project line
- [ ] Footer line about `ownmind_* MCP tools`

## Phase 3: Verification

- [ ] `rg '[\p{Han}]|【|】' hooks/ownmind-session-start.js` returns only comment matches
- [ ] `rg '[\p{Han}]|【|】' hooks/lib/render-session-context.js` returns only comment matches
- [ ] `node --check hooks/ownmind-session-start.js` OK
- [ ] `node --check hooks/lib/render-session-context.js` OK
- [ ] `npm test` passes (update tests that assert on Chinese strings)
- [ ] Identify tests touching SessionStart render and update them

## Phase 4: Release

- [ ] Bump `package.json` to `1.23.0`
- [ ] Add `CHANGELOG.md` entry
- [ ] Update `FILELIST.md`
- [ ] Sync trilingual README badges
- [ ] Commit with conventional-commit message
- [ ] `git tag v1.23.0`
- [ ] Archive this folder to `openspec/changes/archive/`
