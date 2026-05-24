# v1.19.13 — 任務清單

## Phase 0：對齊（已完成）

- [x] T0.1 釐清根本原因（value-side keyword 含 password 字樣命中）
- [x] T0.2 Vin 拍板修法方向（只改 keyword 邏輯、走根本解）
- [x] T0.3 寫 proposal.md / spec.md / tasks.md

## Phase 1：紅燈（TDD red）

- [ ] T1.1 加新測試到 `tests/secret-detect-unit.test.js`
  - S1.1～S1.9（value-side keyword 新邏輯）
  - S2.1～S2.4（matched_text）
  - S5.1～S5.5（既有行為 regression check、應自動通過）
- [ ] T1.2 加新測試到 `tests/memory-secret-guard.test.js`
  - S3.1～S3.2（400 回應含 matched_text）
  - S4.1（完整 bot.kkvin.com 案例 regression）
- [ ] T1.3 `node --test tests/secret-detect-unit.test.js tests/memory-secret-guard.test.js`、確認新測試紅燈、舊測試仍綠

## Phase 2：實作（TDD green）

- [ ] T2.1 改 `shared/secret-detect.js`
  - 加 `KEYWORD_ASSIGNMENT_REGEX` 常數
  - value-side keyword 段從 `includes()` 迴圈改成 regex match
  - regex/keyword/heuristic 三種命中都回傳 `matched_text`（截 80 字）
  - 更新 JSDoc：說明 v1.19.13 改變、為什麼這樣寫
- [ ] T2.2 改 `src/utils/memory-secret-guard.js`
  - 400 body 加 `matched_text: detection.matched_text`
- [ ] T2.3 跑全部測試直到全綠

## Phase 3：手動驗證（verification-before-completion）

- [ ] T3.1 起本地 server、用 curl 或 admin UI 試存 bot.kkvin.com 那段內容、確認成功
- [ ] T3.2 用 curl 試存「password: MyP@ssw0rd123」、確認被擋且 400 body 含 matched_text
- [ ] T3.3 grep 所有 `detectSecretLike` 呼叫點、確認沒有 caller 假設舊回傳格式（不含 matched_text）

## Phase 4：同步文件 + 版號（IR-008 / IR-026 / IR-031 / IR-032）

- [ ] T4.1 `package.json` version：1.19.12 → 1.19.13
- [ ] T4.2 `CHANGELOG.md` 加 v1.19.13 條目
- [ ] T4.3 `README.md` 加 v1.19.13 變更說明
- [ ] T4.4 `docs/README.zh-TW.md` 加對應段
- [ ] T4.5 `docs/README.ja.md` 加對應段
- [ ] T4.6 `FILELIST.md`：不變（沒新增檔）— 仍要 git diff 確認

## Phase 5：Code review + commit（IR-045）

- [ ] T5.1 跑 superpowers:requesting-code-review skill
- [ ] T5.2 處理 review 回饋
- [ ] T5.3 commit（IR-009 / IR-024：作者 Vin、不加 Co-Authored-By）
- [ ] T5.4 `git tag v1.19.13`
- [ ] T5.5 `git push origin main && git push --tags`
- [ ] T5.6 同步更新專案 469（標 done）+ 寫 session_log 記錄這次踩坑與修法

## Phase 6：歸檔（release 後）

- [ ] T6.1 `git mv openspec/changes/v1.19.13-secret-detect-keyword-tighten openspec/changes/archive/`
- [ ] T6.2 部署 prod？（看 Vin 決定）

---

## 暫不做（記下來）

- Pre-commit hook 內 `checkStagedDiffForSecrets` 用 `skip_keyword: true`、所以本次邏輯改動對它無影響。如果之後 hook 想用新 keyword 邏輯（賦值樣式才擋）、再開新提案。
- Admin UI 顯示 matched_text 的 UX 設計（先讓 API 回、UI 之後再決定要不要顯示）。
