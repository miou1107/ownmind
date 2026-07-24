# Tasks — v1.26.31 translate bug-reports.js error strings

## Phase 1: Implement (done)

- [x] 需要管理員權限 → "Admin permission required" (5×).
- [x] 權限不足 → "Insufficient permissions" (2×; plural per review).
- [x] Confirmed no Chinese error literals remain in the file (left the
      送出 comment + 超過 compat regex, both intentional/out of scope).

## Phase 2: Quality gates (done)

- [x] verification-before-completion — full suite 2052 pass / 0 fail (string
      -only change; no test asserts these bodies, so green proves no regression).
- [x] requesting-code-review — verdict merge: behavior-safe (verified no
      consumer matches the strings; adminAuth.js + test mocks are independent
      copies), all 7 translated, scope respected. 1 Minor.
- [x] receiving-code-review — Minor applied: "Insufficient permission" →
      "Insufficient permissions" (idiomatic plural).

## Phase 3: Release

- [x] package.json 1.26.30 → 1.26.31; CHANGELOG; FILELIST; trilingual README
      version lines; commit; tag; push.
- [x] Deploy server + verify live (non-admin hit → English message).
