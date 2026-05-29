# Extract hardcoded `kkvin.com` into config — design

**Date:** 2026-05-29
**Author:** Vin
**Status:** Design (awaiting review)

## Goal

OwnMind is going open-source. Today the author's personal server host
`kkvin.com` is hardcoded in ~60 places across source, docs, tests, and history.
Make every reference come from configuration so that:

1. **Existing users are unaffected** — their installed client keeps working.
2. **People who clone the public repo never see the author's private host** —
   they see placeholders and fill in their own.
3. The author can still run one hosted server (`kkvin.com`) for themselves and
   friends, and still onboard new friends as users.

## Requirements as personas

- **小明 (existing user):** installed months ago; his `~/.ownmind` already holds
  his own `OWNMIND_API_URL`. Changing the repo must not touch him. His old
  upgrade one-liner that hits `kkvin.com` must keep working.
- **阿華 (stranger who clones to self-host):** opens the repo, sees
  `YOUR_OWNMIND_URL` placeholders, fills his own host. No `kkvin.com` anywhere
  in what he reads.
- **阿明 (friend who becomes a user):** the author privately hands him one
  install command containing the real `kkvin.com` API URL + his API key. This
  command is NOT in the public repo.
- **admin = the author deploying to kkvin.com:** real values live in a
  gitignored `.env` on the host; deployment reads them at runtime.

## Decisions (locked with Vin)

- **D2** — open-source / self-host model; the repo is generic.
- **E2** — the install script is fetched from the public **GitHub repo**, not
  from `kkvin.com`. The author's "serve bootstrap" route stays alive for
  backward compatibility (小明), but the public README points at GitHub.
- **Approach A** — env vars + `.env.example` (no new config-file mechanism;
  OwnMind already uses env vars; `.env` is already gitignored, `.env.example`
  already tracked).
- **Historical files included** — `CHANGELOG.md`, `docs/superpowers/**`, and
  `openspec/changes/archive/**` also get `kkvin.com` → `example.com`.

## Mechanism

Real values live only in the host's gitignored `.env` and in the author's
private friend-onboarding snippet. The repo ships `.env.example` with
placeholders. Runtime code reads env; docs/comments/tests use placeholders or
`example.com`.

### Env vars

| Var | Meaning | Used by | Default if unset |
|---|---|---|---|
| `OWNMIND_API_URL` (exists) | API endpoint the client calls | MCP client, hooks | empty (client already supplies its own) |
| `OWNMIND_PUBLIC_URL` (new) | public base URL shown in install command + brand line | `setup.html` generator, `me/index.html` | empty → generic text / placeholder |
| `OWNMIND_LLM_API_BASE` (new) | llm-switch endpoint | `src/lib/llm-narrative.js`, `client/src/scripts/translate.mjs` | empty → feature errors with "configure OWNMIND_LLM_API_BASE" |
| `OWNMIND_PROD_HOST` (exists) | SSH deploy target | `scripts/health-report-daily.sh` | placeholder `root@YOUR_HOST` |

> Planning note: confirm what the existing `OWNMIND_URL` (14 refs) means vs
> `OWNMIND_API_URL` before adding `OWNMIND_PUBLIC_URL`; reuse if equivalent.

## Per-role changes

### ① OwnMind API URL (client)
- `hooks/ownmind-iron-rule-check.sh:97-98` — drop the hardcoded
  `|| 'https://kkvin.com/ownmind'` fallback; if env missing, no-op (小明 has it).
- `hooks/lib/conditional-sync.js:69` — JSDoc example → `https://your-host/ownmind`.

### ② llm-switch (server + translate script)
- `src/lib/llm-narrative.js:81` — read `process.env.OWNMIND_LLM_API_BASE`; no
  `kkvin.com` default; error clearly if unset.
- `client/src/scripts/translate.mjs:25,156` — default → placeholder; require env.
- `.env.example` — document `OWNMIND_LLM_API_BASE` (replaces the
  `kkvin.com/llm-switch/dashboard` comment at line 25).

### ③ SSH deploy host (ops)
- `scripts/health-report-daily.sh:20` — default → `root@YOUR_HOST`.

### ④ install / bootstrap (the E2 change)
- `README.md`, `docs/README.zh-TW.md`, `docs/README.ja.md` — install commands
  fetch `bootstrap.sh|ps1` from GitHub raw; API URL arg shown as
  `YOUR_OWNMIND_URL`.
- `scripts/bootstrap.sh` / `bootstrap.ps1` — header "usage" comments → GitHub raw.
- `src/public/setup.html:170` — generate the command using `OWNMIND_PUBLIC_URL`
  (server's own configured value) + GitHub-raw fetch, so the author's rendered
  setup page still shows the real command.
- `skills/ownmind-upgrade.md` — upgrade commands → GitHub raw.
- `src/app.js:167` — comment → generic.
- **Keep** `src/app.js:183-186` (`/bootstrap.sh`, `/bootstrap.ps1` routes) —
  domain-agnostic, so 小明's old `kkvin.com` one-liner keeps working untouched.

### ⑤ brand display
- `src/public/me/index.html:555` — "資料即時取自 kkvin.com" → inject
  `OWNMIND_PUBLIC_URL` host, or generic "你的 OwnMind 伺服器".

### ⑥ comments / tests / history
- Code comments (`client/src/api/client.js:21`, `client/src/main.jsx:17`,
  `src/app.js:17`) → `example.com` / generic.
- Tests (`tests/self-check.test.js`, `tests/llm-narrative.test.js`,
  `tests/me-trailing-slash.test.js`, `tests/bootstrap-strip-bom.test.js`) →
  `example.com` fixtures. Behavioral assertions, so the suite stays green.
- History: `CHANGELOG.md`, `docs/superpowers/**`, `openspec/changes/archive/**`
  → `kkvin.com` → `example.com` (and `root@kkvin.com` → `root@example.com`).

## Backward compatibility

- 小明's client reads his own `~/.ownmind` env → unaffected by repo changes.
- The bootstrap-serving route stays, so his old `kkvin.com` upgrade one-liner
  still works.
- The hosted `kkvin.com` service keeps running; only its references leave the
  source. Real values move to the host's gitignored `.env`.

## Also in scope — repo-wide de-identification (folded in 2026-05-29)

The same pre-open-source de-branding effort. v1.26.21 only scrubbed the openspec
copies + the sensitive test fixtures (incident data, FUNIT vault). A code review
found real identifiers still scattered across ~40 files. Handle them in this
pass:

- **Real first names in bug-attribution comments** (Adam / Eric / Michelle /
  Phoebe), e.g. "reported by Adam", "Eric/Adam Windows failure", "Michelle
  case" — across `tests/`, `src/`, `shared/`, `hooks/`, `scripts/`. Pseudonymize
  consistently (Eric→Alice, Adam→Bob, Phoebe→Carol, Michelle→Dana). Most are
  comments; a few are test labels/data (`tests/language-lint-v1193.test.js`
  `'Eric 跟 Phoebe 都同意'`, `tests/team-overview-api.test.js` `user_name:'Adam'`)
  — behavioral, safe to rename.
- **Project-name proper-noun whitelist** `shared/language-lint.js:97`
  (`'ima','asir','funit','majitreats'...`) — this is FUNCTIONAL (the lint's
  proper-noun allowlist). Decide: keep (these are just whitelist tokens, low
  exposure) or genericize. Needs care + test run.
- **`src/lib/llm-narrative.js:27-34`** prompt examples contain real names
  (Vin/Michelle/Adam/Eric) and `funit-v2`. Genericize the prompt examples.

Verification for this part: `grep -rnE '\b(Eric|Adam|Michelle|Phoebe)\b'` over
the repo (minus node_modules) returns only intended pseudonyms; `npm test` green.

## Out of scope

- Renaming/retiring the actual `kkvin.com` domain (it keeps running).
- The author's private friend-onboarding snippet (lives outside the repo).
- The remote-access incident data + FUNIT vault fixture (already scrubbed in v1.26.21).

## Verification

- `npm test` stays green (test fixtures behavioral; `example.com` is inert).
- After the change: `grep -rn 'kkvin' . --include=... | grep -v node_modules`
  returns **zero** outside the gitignored `.env` (which is untracked).
- Manual: on a host with `.env` set, `setup.html` and `me` render the real URL;
  with env unset, they show placeholder/generic without crashing.
- Quality gates: verification-before-completion + requesting/receiving review.

## Release

Separate release from v1.26.21 (this touches functional code: llm-narrative,
hooks, setup.html). Suggest its own version after v1.26.21 lands.
