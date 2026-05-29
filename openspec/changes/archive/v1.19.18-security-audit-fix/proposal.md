# v1.19.18 — Patch three moderate security vulnerabilities (npm audit fix)

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: In progress
- **Estimated version**: v1.19.18 (hotfix-class patch, pure dependency upgrade)
- **Related GitHub issue**: [#43](https://github.com/miou1107/ownmind/issues/43)

---

## 0. One-line summary

Run `npm audit fix` to upgrade three dependencies with moderate security vulnerabilities (`ip-address`, `qs`, `express-rate-limit`), run the full test suite to confirm no regression, then release and deploy.

---

## 1. Design rationale

### 1.1 Vulnerabilities caught by Antigravity Code Review

Running `npm audit` in the Antigravity environment found 3 moderate vulnerabilities:

| Package | Current version | Vulnerability | Source |
|---|---|---|---|
| `ip-address` | <=10.1.0 | XSS cross-site scripting (Address6 HTML-emitting methods) | [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) |
| `qs` | 6.11.1-6.15.1 | DoS denial of service (when `encodeValuesOnly` is on, `qs.stringify` throws TypeError on null/undefined) | [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) |
| `express-rate-limit` | 8.0.1-8.5.0 | Transitive dependency: uses a vulnerable version of `ip-address` | — |

### 1.2 Why these three vulnerabilities must be fixed

**`qs` DoS (denial of service)**: remotely triggerable. Express 5 uses `qs` internally to parse the query string (the `?key=value` part after the URL); a malicious actor can send a specially crafted request to make the server throw a TypeError, causing response problems. **The OwnMind server, directly facing the public internet, has real risk.**

**`ip-address` XSS (cross-site scripting)**: only triggered when using HTML-output methods like `.toString()` on an `Address6` object. `express-rate-limit` uses `ip-address` to determine IPv6 address ranges and does not go through the HTML-output path, so the actual exploitability is low. But since there is a fix, upgrade it too.

**`express-rate-limit`**: has no vulnerability of its own; it needs upgrading because it depends on `ip-address`.

### 1.3 Why choose npm audit fix (instead of manually upgrading each package)

- `npm audit fix` only bumps minor / patch, not major automatically (no breaking changes introduced)
- dry-run preview: all three packages only bump minor (`qs` 6.15.0→6.15.2, `ip-address` 10.1.0→10.2.0, `express-rate-limit` 8.3.2→8.5.2)
- The full existing test suite (1825 last time) guards against regression

---

## 2. Design scope

### 2.1 In scope

- Run `npm audit fix`, let npm automatically handle the upgrade of the three packages
- Run the full `node --test`, confirm no regression (i.e. "things that used to work are now broken")
- Run `npm audit` to confirm 0 vulnerabilities
- Version 1.19.17 → 1.19.18 (pure security patch, patch level)
- Update CHANGELOG.md / FILELIST.md / tri-language README
- Deploy to example.com and test in the browser

### 2.2 Out of scope

- ❌ Upgrading major version packages (auto-skipped)
- ❌ Adding any feature or behavior
- ❌ Changing any business logic code
- ❌ Writing spec.md (pure dependency upgrade, no new behavior to define GIVEN/WHEN/THEN)

---

## 3. Effort

| Item | Lines |
|---|---|
| `npm audit fix` (produces the diff of `package.json` + `package-lock.json`) | Auto-generated |
| Version + CHANGELOG + FILELIST + tri-language README | 50 |
| **Total** | About 50 manual lines + auto lockfile diff |

Engineering time: about 15-30 minutes (including deploy + verification).

---

## 4. Risk checkpoints

- [ ] `npm audit fix` done, `npm audit` returns 0 vulnerabilities
- [ ] `node --test` all green (1825 or more)
- [ ] After the `express-rate-limit` upgrade, the existing rate-limit config still works (restart the server and check logs for no errors)
- [ ] After the `qs` upgrade, query string parsing works (endpoints like POST /api/bug-reports work normally)
- [ ] After deploy, https://example.com/ownmind/admin/ logs in normally
- [ ] After deploy, https://example.com/ownmind/api/clients/version returns v1.19.18
- [ ] Tri-language version 1.19.18

---

## 5. Post-upgrade follow-ups

- Close GitHub issue #43
- Move this folder to `openspec/changes/archive/`
- Does the client `~/.ownmind` need upgrading? **No** — this version only upgrades server-side dependencies, does not change MCP tools, does not change client scripts.
