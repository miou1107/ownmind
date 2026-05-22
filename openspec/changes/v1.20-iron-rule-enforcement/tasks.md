# Critical 鐵律卡控 — 漸進推 v1.19.6 → v1.19.10 任務清單

> 依 IR-003（TDD）：每個實作 task 前面先寫測試。
> 依 IR-012（品管三步驟）：驗證 → 請評審 → 處理回饋。
> 依 IR-008（commit 同步更新 README/FILELIST/CHANGELOG）。

---

## v1.19.6 — 共用判定核心 + 放行通道 + 審計擴充（本批次）

> 純基礎建設、不擋任何規則。目標是讓後續 v1.19.7~9 hook 層只需要組合。

- [ ] **A1. 寫測試** `tests/rule-enforcer-core.test.js`（預估 12+ case）
  - `enforceRule(ruleCode, context, options)` 各分支
  - 規則不在快取 → `action: 'allow'`、`reason: 'rule_not_in_cache'`
  - critical 規則違反 → `action: 'block'`
  - default 規則違反 → `action: 'warn'`
  - advisory 規則違反 → `action: 'log_only'`
  - critical 規則通過 → `action: 'allow'`
  - bypass 設定生效 → `action: 'bypass'`
  - bypass=all → 任何規則 `action: 'bypass'`
  - 鐵律沒 conditions → `action: 'allow'`、`reason: 'no_conditions'`
  - 批次 `enforceRules` 多條獨立判定
  - context 缺欄位 fallback（依 verification handler 行為）
  - hook_internal_error fallback：handler 拋例外 → fail-open + 標記
- [ ] **A2. 新檔** `hooks/lib/rule-enforcer.js`
  - 純函式入口 `enforceRule` / `enforceRules`
  - 內部包 `shared/verification.js` 的 `evaluateConditions`
  - 依 tier 決定 action：critical → block、default → warn、advisory → log_only
  - bypass set 取代 process.env 解析（測試友善）
- [ ] **B1. 寫測試** `tests/bypass-handler.test.js`（預估 8+ case）
  - `parseBypass(env)` 空 / 單條 / 多條 / `all`
  - `isBypassed` 命中 / 沒命中 / null
  - bypass=all 涵蓋所有規則
  - bypass scope 是 process（解析時不修改 env）
  - `logBypass` 寫 audit、action='bypass'
- [ ] **B2. 新檔** `hooks/lib/bypass-handler.js`
  - `parseBypass(env): Set<string>` 解析環境變數
  - `isBypassed(ruleCode, bypassSet): boolean`
  - `logBypass({ ruleCode, source, context })` 寫 audit
- [ ] **C1. 改 shared/compliance.js**
  - `appendCompliance` 接受 `action='block' | 'bypass' | 'hook_internal_error'` 新值
  - schema 不變（純新增合法值），不破壞既有測試
- [ ] **C2. 補測試** `tests/compliance.test.js`
  - 新 action 三個值都能寫入並讀回
- [ ] **D. 跑全測試 + 品管三步驟**
  - `npm test` 全綠
  - `superpowers:verification-before-completion`
  - `superpowers:requesting-code-review`
- [ ] **E. 文件 + 版號同步**
  - `README.md` Iron Rule Enforcement Engine 段加 v1.19.6 一段
  - `docs/README.zh-TW.md` / `docs/README.ja.md`（IR-032 三語系同步）
  - `CHANGELOG.md` v1.19.6 條目
  - `FILELIST.md` 加 `hooks/lib/rule-enforcer.js`、`hooks/lib/bypass-handler.js`、新測試檔
  - 三處版號同步（IR-031）：`package.json` 1.19.5 → 1.19.6
  - 預備打 tag `v1.19.6`

### v1.19.6 驗收

- [ ] `npm test` 0 failure
- [ ] `enforceRule('IR-002', { stagedFiles: ['.env'] }, { rules: [...] })` 回傳 `action: 'block'`
- [ ] `OWNMIND_BYPASS=IR-002 enforceRule(...)` 回傳 `action: 'bypass'`
- [ ] 鐵律 cache 為空時 `enforceRule` fail-open（action: 'allow'）
- [ ] 沒任何既有 hook 被破壞

---

## v1.19.7 — IR-041 + IR-002 + reply-lint 切擋下（下批次）

- [ ] 寫 IR-041 隱私 detector（身分證／信箱／電話樣式 + user prompt 例外）
- [ ] 寫 IR-002 pre-commit 整合（用 v1.19.1 secret-detect + 新 rule-enforcer）
- [ ] reply-lint hook 切擋下模式（exit 2）+ 連續 3 次降警告
- [ ] 兩週觀察期、根據誤判紀錄調規則

---

## v1.19.8 — 指令樣式類 5 條

- [ ] PreToolUse 整合 rule-enforcer
- [ ] IR-023 / IR-018 / IR-044 / IR-046 / IR-043 detector

---

## v1.19.9 — 靜態檢查收尾

- [ ] IR-009 git user.name 檢查
- [ ] IR-024 commit-msg Co-Authored-By 檢查
- [ ] IR-031 pre-tag 三處版號檢查

---

## v1.19.10 — 觀察期 + 調校

- [ ] 收集兩週誤判紀錄
- [ ] 根據 bypass audit log 調 detector 規則
- [ ] 評估是否需要 admin UI Bypass 紀錄分頁

---

## 非任務（明確不做）

- ❌ IR-005（blind edit）跨工具追蹤 — Gemini 對抗審查批：MCP 無狀態、user 手動點開檔案會大量誤判；維持警告
- ❌ IR-008（三文件同步）硬擋 — Gemini 批：改錯字也擋會逼人 bypass；維持警告
- ❌ IR-048（部署前 DB migration）硬擋 — Gemini 批：連外部狀態太脆；維持警告
- ❌ Advisory tier 邏輯（v1.21+）
- ❌ 動態升降級（v1.22+）
- ❌ AI 輔助分類
- ❌ per-user 客製分級
- ❌ Cursor PreToolUse 卡控（Cursor 沒 hook 點）

---

## 風險檢查點（每階段結束時 review）

- [ ] v1.19.6 結束：跑一次 dogfood、用 rule-enforcer 自己 commit v1.19.6 程式碼、確認沒卡死
- [ ] v1.19.7 結束：跑一次 reply-lint 硬擋、確認 AI 能正確重做
- [ ] v1.19.8 結束：在另一台機器跑 migrate-hooks、驗證升級流程
- [ ] v1.19.10 結束：發版前再跑一次完整 e2e、自己違反每條 critical、確認都被擋
