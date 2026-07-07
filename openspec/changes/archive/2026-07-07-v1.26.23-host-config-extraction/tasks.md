# Tasks — v1.26.23 host config extraction + de-branding

## Safety
- Mapping (real→placeholder) NOT recorded in any committed file.
- Functional host refs → env config; keep existing users + author deploy working.
- Test fixtures renamed in lockstep; npm test stays green (new baseline 2008).

## Phase 1: Functional (host → env)
- [x] `callLLMSwitch` reads `OWNMIND_LLM_API_BASE`; tests updated (pass apiBase).
- [x] translate.mjs drops hardcoded default.
- [x] hooks/ownmind-iron-rule-check.sh drops host fallback.
- [x] health-report-daily.sh default → root@YOUR_PROD_HOST.
- [x] setup.html → GitHub-raw bootstrap fetch + window.location.origin API URL.
- [x] me/index.html footer → generic brand text.
- [x] .mcp.json OWNMIND_API_URL → placeholder.
- [x] README ×3 + bootstrap.sh/ps1 + skills/ownmind-upgrade.md → GitHub-raw install.
- [x] language-lint whitelist trimmed + paired test fixture updated.
- [x] .env.example documents OWNMIND_LLM_API_BASE + OWNMIND_PROD_HOST.

## Phase 2: De-branding (docs/comments/history)
- [x] Genericize private host, company domain, work email, project codenames
      (RING/auto_speech/client project/etc.) across CHANGELOG/docs/openspec/comments.
- [x] Rewrite scrub-documentation so it no longer reveals real→placeholder maps;
      rename design doc file to drop the host name.

## Phase 3: Verify
- [x] Repo-wide scan: 0 real names / host / company domain / codenames.
- [ ] Fresh `npm test` pre-commit (expect 2008/0/0).

## Phase 4: Quality gates + release
- [ ] verification-before-completion.
- [ ] requesting-code-review (functional changes — important).
- [ ] receiving-code-review.
- [ ] Version sync: package.json 1.26.22 → 1.26.23, CHANGELOG, FILELIST, tag.
- [ ] Commit (no Co-Authored-By). Push when Vin approves.
- [ ] Hand Vin the deploy env-var list.
