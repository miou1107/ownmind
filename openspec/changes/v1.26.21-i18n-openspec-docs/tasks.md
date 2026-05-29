# Tasks — v1.26.21 i18n openspec docs (Track B)

## Safety constraints (apply to EVERY edit)

- Translate ONLY explanatory prose. PRESERVE quoted iron-rule content/titles,
  code-fence product artifacts, matcher/regex/assertion tokens, IR-NNN numbers,
  Author/date/branch/version metadata.
- Edit in place, surgically; never full-file rewrites.
- After each batch: `git diff` self-check — every removed Chinese line is prose.
- Docs only — `npm test` must stay 2012 / 0 / 0 (no code touched).

## Phase 0: Baseline

- [x] `npm test` fail 0 recorded (baseline 2012/0/0).
- [x] Survey: 93 files / 5549 Chinese lines; CONVENTIONS.md 54, archive 5485.

## Phase 1: CONVENTIONS.md (living doc)

- [ ] Translate CONVENTIONS.md prose → English; preserve quoted tokens.
- [ ] `git diff` self-check.

## Phase 2: archive batches (prose only, preserve quoted content)

- [ ] Batch 1 — heavy files: v1.19.14-bug-report-tool, v1.18.0-iron-rule-schema,
      v1.17.66-windows-hardening, v1.19.20-iron-rule-enforcement-finishing.
- [ ] Batch 2 — v1.18.9-mcp-latency-tracking, v1.19-iron-rule-tier,
      v1.19.1-secret-tool-routing, v1.19.3-reply-lint-progressive-block.
- [ ] Batch 3 — v1.19.13, v1.19.2-auto-migration, v1.19.9-password-recovery,
      v1.19.8-setup-wizard, v1.19.11-lint-ux-improvements.
- [ ] Batch 4 — v1.20.1-portal-pages, v1.21.0-lint-validator-architecture,
      v1.20.0-frontend-foundation, v1.19.19-require-fields-helper,
      v1.20.2-fix-hint, v1.20.3-session-toggle, v1.20.4-lint-rule-neutralize.
- [ ] Batch 5 — remaining smaller dirs (v1.19.18, v1.19.10, v1.19.15,
      v1.20.1-db-healthcheck, v1.22.0, v1.20.2-admin-pages, v1.20.4-legacy-retire,
      v1.20.3-super-pages, and all single-digit-line dirs).
- [ ] Per-batch `git diff` audit after each.

## Phase 3: Verify

- [ ] Full `npm test` matches baseline (2012/0/0).
- [ ] Final `git diff` scan: only prose changed; quoted content preserved.

## Phase 3b: Sensitive-data scrub (added at Vin's request)

- [x] Audit openspec for PII / secrets / personal-rule prefs (no real secrets found;
      the ghp_/JWT/sk-proj fixtures are fake detector samples).
- [x] ③ Real names → consistent pseudonyms (full real name removed), local path
      → `~/...`, sample email → `user@example.com`. (Mapping not recorded here on
      purpose — recording real→alias would defeat the pseudonymization.)
- [x] ④ Internal ecosystem names neutralized in openspec (client project name → ExampleClient,
      internal project names → "other internal projects", whitelist example list genericized,
      vault-name tokens neutralized).
- [x] Verify: only openspec .md changed; npm test 2012/0/0; ①/② left untouched.
- [x] ① remote-access incident data scrubbed across openspec + tests + shared +
      FILELIST + CHANGELOG: internal hostnames, the AnyDesk connection id, and the
      Tailscale address were all replaced with neutral placeholder values. (The
      real→placeholder mapping is intentionally NOT recorded here.) Behavioral
      test fixtures only; npm test stays 2012/0/0.
- [ ] DEFERRED (Vin still deciding):
      ② `example.com` bare public install endpoint (README / .mcp.json) — it is the
         published service URL, not a leak; global de-brand would be a separate
         product decision.

## Phase 4: Quality gates + release

- [ ] verification-before-completion.
- [ ] requesting-code-review (reviewer on the diff).
- [ ] receiving-code-review.
- [ ] Version sync: package.json 1.26.20 -> 1.26.21, CHANGELOG, FILELIST, tag.
- [ ] Commit (no Co-Authored-By). Push when user approves.
