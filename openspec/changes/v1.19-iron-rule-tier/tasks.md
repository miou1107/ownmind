# v1.19 — 鐵律分級 任務清單

> 依 IR-003（TDD）原則：每個實作 task 前面都先寫測試。
> 依 IR-012（品管三步驟）：驗證 → 請評審 → 處理回饋。
> 依 IR-008（commit 同步更新 README/FILELIST/CHANGELOG）。

> **執行紀錄（2026-05-14）：** 階段 A~F 已完成、code review 已收回饋並修補（I-1 ~ I-4、M-1、M-2、M-5）。實際完成的檔名與原規劃略有調整、以下清單已對齊最終實作。

## 階段 A：資料庫層 ✅

- [x] A1. 寫 `db/014_iron_rule_tier.sql`
  - ADD COLUMN tier VARCHAR(20) DEFAULT 'default' + CHECK ('critical', 'default', 'advisory')
  - CREATE INDEX idx_memories_iron_rule_tier ON memories(tier) WHERE type='iron_rule'
  - 重跑安全（IF NOT EXISTS）、CHECK constraint 用 DO $$ block 補
- [x] A2. migration 驗收 SQL 寫在 SQL 檔尾註解（手動跑、沒寫自動化測試、跟既有 db/*.sql 慣例對齊）

## 階段 B：Server API ✅

- [x] B1. 寫測試 `tests/iron-rule-tier-validator.test.js`（10 case）
  - 沒帶 tier ok（向後相容）
  - 合法 tier ok
  - 非法 tier 回 400 + 列出合法選項
  - 非 iron_rule 設 tier 回 400
  - applyTierDefault 兜底邏輯
- [x] B2. 新檔 `src/utils/iron-rule-tier-validator.js`（純函式）
- [x] B3. 改 `src/routes/memory.js`
  - POST 接收 tier、跑 validateTierRequest、寫進 INSERT
  - PUT 接收 tier、用 `oldMemory.type` 防繞過、寫進 UPDATE
  - PUT memory_history 帶 `tier_change: { from, to }`（review I-1 補）
  - GET (SELECT *) 自動帶 tier
  - /init 回傳 `iron_rules_tier_counts` 結構化計數

## 階段 C：MCP 工具 ✅

- [x] C1. 寫測試 `tests/iron-rule-tier-mcp.test.js`（7 case、source-level）
  - 註：mcp/index.js 載入會自動連 stdio MCP server、無法直接 import、改用 regex 驗證 source
- [x] C2. 改 `mcp/index.js`
  - ownmind_save inputSchema 加 tier
  - ownmind_update inputSchema 加 tier
  - 兩個 case handler `if (args.tier !== undefined) body.tier = args.tier`

## 階段 D：共用 helper ✅

- [x] D1. 寫測試 `tests/iron-rule-tier-helper.test.js`（21 case）
- [x] D2. 新檔 `shared/iron-rule-tier.js`（純函式）
  - VALID_TIERS / TIER_EMOJI / TIER_LABEL_ZH / TIER_ORDER 常數
  - isValidTier / normalizeTier / getTierFromRules / getTierEmoji / compareTier / groupByTier
  - 註：原規劃放在 `shared/verification.js`、實作上獨立成新檔避免 verification 模組變肥
- [x] D3. 改 `shared/compliance.js`
  - appendCompliance 接受 entry.tier（用 isValidTier 過濾、非法值丟棄）
- [x] D4. 加 3 條 tier 測試到 `tests/compliance.test.js`

## 階段 E：Hook 整合 ✅

- [x] E1. 加 3 條測試到 `tests/session-start-render.test.js`
  - 有 tier_counts 時鐵律段標題加分佈
  - 沒有 tier_counts（舊 server）回到舊版格式
  - total 為 0 不顯示假計數
- [x] E2. 新檔 `src/utils/iron-rule-digest.js`（buildIronRulesDigest + countByTier、共 12 case 測試）
- [x] E3. 改 `hooks/lib/render-session-context.js` 鐵律段標題加 tier summary
- [x] E4. 改 `src/routes/memory.js` /init 用 buildIronRulesDigest 取代 inline 組裝
- [x] E5. 新檔 `hooks/lib/build-compliance-events.js` + 9 case 測試
- [x] E6. 改 `hooks/ownmind-reply-lint.js`
  - dynamic import getTierFromRules + buildComplianceEvents
  - readIronRulesCache helper（best-effort）
  - review M-2 後：dynamic import 失敗統一 exit 0、不再 inline fallback
- [x] E7. 改 `hooks/ownmind-git-post-commit.js`
  - appendCompliance 帶 tier 欄位（從 rule.tier 取）
- [ ] ~~E8. 改 git-pre-commit~~ — 該 hook 沒呼叫 appendCompliance（只用 blockFailures + console.error）、跳過

## 階段 F：Admin UI ✅

- [x] F1. 改 `src/routes/admin-iron-rule-upgrade.js`
  - /upgrade-status SELECT 加 tier 欄位、回傳給 client
- [x] F2. 改 `src/public/index.html`
  - 鐵律升級助手列表加 Tier 欄
  - dropdown（🔴 Critical / 🟡 Default / ⚪ Advisory）背景色區分
  - dropdown change → iruUpdateTier()
  - iruUpdateTier 帶 prevTier 進 update_reason（review I-3 補）
- [ ] ~~F3. browser 實測~~ — 留給 Vin 部署 prod 後手動跑（IR-020），不在這次對話範圍

## 階段 G：文件同步（IR-008、IR-032）

- [ ] G1. README.md（英文）「Iron Rule Enforcement Engine」段落加 tier 系統說明
- [ ] G2. docs/README.zh-TW.md 同步
- [ ] G3. docs/README.ja.md 同步
- [ ] G4. CHANGELOG.md 加 v1.19.0 條目
- [ ] G5. FILELIST.md 加 014 migration 與新測試檔
- [ ] G6. 跑 grep 確認三語系文件 tier 敘述一致

## 階段 H：版號同步（IR-031）

- [ ] H1. package.json 改 version 為 1.19.0
- [ ] H2. SERVER_VERSION 改為 1.19.0
- [ ] H3. 跑 `node scripts/check-sync.sh` 確認三處一致

## 階段 I：品管三步驟（IR-012、IR-045）

- [ ] I1. 調用 superpowers:verification-before-completion
  - 跑全部測試（npm test）
  - browser 實測 admin UI 編輯流程
  - 跑 migration on dev DB、確認 41 條鐵律 tier 都是 default
  - SQL 驗收：`SELECT tier, COUNT(*) FROM memories WHERE type='iron_rule' GROUP BY tier`
- [ ] I2. 調用 superpowers:requesting-code-review
  - 整理變動清單給 reviewer agent（白話：另一個 AI 幫忙審查）
  - 確認所有場景（spec.md 12 個場景）都有對應測試
- [ ] I3. 處理 review 回饋（superpowers:receiving-code-review）
  - 對每個 critical issue 寫測試重現
  - 對每個 important issue 評估是否在本版處理
  - 對 minor issue 開 TODO 留下次

## 階段 J：發版

- [ ] J1. Tag v1.19.0
- [ ] J2. push origin（等 Vin 拍板）
- [ ] J3. 部署 prod（IR-018: docker compose build、--no-cache；IR-023）
- [ ] J4. 部署後 browser 實測（IR-020）
- [ ] J5. Vin 在 admin UI 手動把 10 條 Critical 鐵律升級
- [ ] J6. 跑 SQL 驗收：`SELECT tier, COUNT(*)`，確認 critical=10、default≈30

## 階段 K：發版後追蹤（v1.19.1 預備）

- [ ] K1. 跑 7 天觀察 compliance event 分佈
- [ ] K2. 找出「7 天內違反 0 次、且只是溝通風格類」的鐵律候選 Advisory 名單
- [ ] K3. v1.19.1 hotfix 把候選名單批次降為 advisory
- [ ] K4. 把 v1.19-iron-rule-tier proposal 搬到 `openspec/changes/archive/`（按 CONVENTIONS.md 第 3 條規則用 git mv）

## 階段 L：搬入 archive（發版完成後）

- [ ] L1. 確認 CHANGELOG.md 已有 v1.19.0 條目
- [ ] L2. 用 `git mv openspec/changes/v1.19-iron-rule-tier openspec/changes/archive/`
- [ ] L3. 跑 grep 確認外部引用更新（CONVENTIONS.md 第 5 條驗證流程）
- [ ] L4. commit

---

## 預估規模

| 階段 | 預估 PR 數 | 預估時間 |
|------|------------|----------|
| A~D 資料層 + API + MCP + helper | 1 | 半天 |
| E hook 整合 | 1 | 半天 |
| F admin UI | 1 | 半天 |
| G~H 文件 + 版號 | 1 | 1~2 小時 |
| I 品管 | （隨上面 PR） | 1~2 小時 |
| J 發版 | — | 30 分鐘 |
| K 追蹤 + L archive | 1（v1.19.1） | 1 週後 |

**總計：** 4 個 PR、約 2~3 個工作天（不含 K 階段的 7 天觀察期）。
