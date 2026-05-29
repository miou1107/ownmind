# v1.26.23 — host config extraction + finish open-source de-branding

- **Author**: Vin
- **Date**: 2026-05-29
- **Status**: In progress
- **Spec**: `docs/superpowers/specs/2026-05-29-host-config-extraction-design.md`

## Why

Final pre-open-source pass. v1.26.21/v1.26.22 removed real names + the most
sensitive fixtures. This change removes the author's private prod host and the
remaining internal project codenames from the source, and moves the real host
into runtime config so existing users and the author's own deploy keep working.

## What

**Functional (host → env config, "clean派" chosen by Vin):**
- `src/lib/llm-narrative.js` `callLLMSwitch` reads the endpoint base from
  `OWNMIND_LLM_API_BASE` (no hardcoded host; throws a clear error if unset).
- `client/src/scripts/translate.mjs` drops the hardcoded `TRANSLATE_API_BASE`
  default.
- `hooks/ownmind-iron-rule-check.sh` drops the hardcoded API-URL fallback
  (reads the user's own `OWNMIND_API_URL`; empty otherwise).
- `scripts/health-report-daily.sh` default host → `root@YOUR_PROD_HOST`.
- `src/public/setup.html` install command fetches `bootstrap.sh` from the public
  GitHub repo (E2); the API URL is the admin server's own `window.location.origin`.
- `src/public/me/index.html` footer brand → generic text.
- `.mcp.json` `OWNMIND_API_URL` → `https://YOUR_OWNMIND_URL/ownmind` placeholder
  (real value via `.mcp.local.json` / env, per the existing `_comment`).
- `README.md` / `docs/README.*.md` / `scripts/bootstrap.*` / `skills/ownmind-upgrade.md`
  install + upgrade commands fetch from GitHub raw; API URL shown as a placeholder.
- `shared/language-lint.js` proper-noun whitelist trimmed to generic/product
  terms (personal project codenames removed); paired test fixture updated in
  lockstep (4 obsolete word-cases removed → test baseline 2012 → 2008).

**De-branding (docs/comments/history):**
- All remaining references to the private host, the company domain, the work
  email, and internal project codenames (RING, auto_speech, the client project,
  etc.) genericized across CHANGELOG / docs / openspec / comments.
- Files that previously *documented* the scrub mapping were rewritten so they no
  longer reveal real→placeholder correspondences (incl. renaming the design doc
  file to drop the host name).

## Deploy note (REQUIRED before next prod deploy)

The hosted server must set these env vars or the affected features break:
- `OWNMIND_LLM_API_BASE` — the OpenAI-compatible LLM endpoint base (else the
  `/me` narrative-insights feature returns its configured error).
- `OWNMIND_PROD_HOST` — for the health-report script.
- Local dev: keep the real host in `.mcp.local.json` (gitignored) or env.

## Verification

- Repo-wide scan: zero real names / private host / company domain / internal
  codenames (mapping not recorded anywhere committed).
- `npm test` 2008 / 0 / 0 (4 obsolete whitelist word-cases intentionally removed).
- Quality gates: verification-before-completion + requesting/receiving review.

## Out of scope

- The actual prod host/domain keeps running (only its source references leave).
- `.mcp.json` args path `/Users/<user>/.ownmind/...` (local-path concern, separate).
