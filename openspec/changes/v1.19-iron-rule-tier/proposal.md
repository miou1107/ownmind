# v1.19 — 鐵律分級（3 級制：Critical / Default / Advisory）

- **Author**: Vin
- **Date**: 2026-05-14（提案）
- **Status**: 設計拍板完成（2026-05-14），待實作
- **Worktree**: `stupefied-vaughan-4650ee`
- **Branch**: `vin/stupefied-vaughan-4650ee`

---

## 0. 一句話總結

把目前 41 條鐵律分成 **Critical（核心硬規則，10 條）/ Default（預設規則，約 20 條）/ Advisory（純參考提示，約 10 條）** 三級。本版只做**標籤層**——加 `tier` 欄位、改 admin UI、改 SessionStart 顯示分組，**不動執行邏輯**。執行邏輯（卡控）由 v1.20 接手。

> 白話：這版只是給每條鐵律掛個「重要程度」標籤，AI 還是照舊照所有規則跑、只是知道哪些是死線、哪些是建議。

---

## 1. 設計緣由

### 1.1 規則數量已逼近認知極限

當前狀態（2026-05-14 / SessionStart 載入）：

- 鐵律數量：**41 條**（IR-002 ~ IR-042，跳號為棄用過的）
- 每次 session 啟動全部載入記憶
- 新成員（包括新接手的 AI 工具）難以全部吸收
- 重要規則被次要規則稀釋

### 1.2 告警疲勞已經發生

本次 session 啟動時跳了 **13 條** 回話品質警告（IR-036、IR-037）。
反覆觸發同一條警告 = 提醒機制失靈，這正是 IR-027（提醒無效、邏輯才有效）警告的失效模式。

### 1.3 v1.20 卡控需要分級當前置

若無分級就做卡控，會兩種失敗模式擇一：

- **無差別嚴格** → 所有規則都擋 → 工作流被擋到沒人用
- **無差別寬鬆** → 沒有實質卡控 → 等於沒做

只有「Critical 才卡控、其他維持提醒」這條路走得通，前提是要先分級。

---

## 2. 分級設計

### 2.1 三級定義

| 級別 | 中文 | 違反處理（本版） | 違反處理（v1.20 後） |
|------|------|------------------|----------------------|
| `critical` | 核心硬規則 | 跟 default 相同（**本版不動執行邏輯**） | 直接卡控：pre-commit 擋 commit、PreToolUse 擋工具呼叫、reply-lint 中斷回應 |
| `default` | 預設規則 | 跳警告 + 寫違反紀錄 | 跳警告 + 寫違反紀錄（不變） |
| `advisory` | 純參考提示 | 跟 default 相同（**本版不動執行邏輯**） | 只寫紀錄、不跳警告 |

> 本版只是**埋下分級的種子**。AI 行為、hook 行為、回報行為全部**跟 v1.18.9 一模一樣**，差別只在「資料層多了一個欄位 + admin UI 多了一個欄位」。

### 2.2 Critical 名單（10 條，已拍板）

| 編號 | 標題 | 為何 Critical |
|------|------|----------|
| IR-002 | 不要 commit .env 或密碼 | 資安：密碼外洩無法回收 |
| IR-005 | 不要不確認就改（不要 blind edit） | 品質：改錯地方破壞功能 |
| IR-008 | commit 同步更新 README/FILELIST/CHANGELOG | 一致性：文件跟程式對不上等於沒文件 |
| IR-009 | Git contributors 一律顯示 Vin | 身份：跟 IR-024 一組、商業需求 |
| IR-012 | 品管三步驟（驗證、請評審、處理回饋） | 流程：跳過 = 半成品 |
| IR-024 | Git commit 絕對不加 Co-Authored-By | 身份：商業需求 |
| IR-027 | 提醒無效，邏輯才有效 | 後設規則：v1.20 卡控的設計指導原則 |
| IR-031 | 發版時 package.json / SERVER_VERSION / git tag 三處版號同步 | 發版：版號錯了用戶會看到舊版本 |
| IR-038 | 修 bug 前必須先確保有觀測資料 | 品質：沒觀測等於盲修 |
| IR-041 | 不收集使用者隱私 | 隱私：個資外洩無法回收 |

選擇標準：**違反會造成實際損失**（資料洩漏、版本錯亂、品質倒退、發版失敗、身份冒名、隱私違反）。

### 2.3 Default 預設

migration 時 **全部 41 條鐵律預設為 `default`**，發版後**透過 admin UI 手動把這 10 條升為 `critical`**。

理由：

- 不自動分類，避免機器分錯
- Critical 改動視為高風險、要走 admin audit log
- 跑一週看穩定度，再評估 Advisory 名單

### 2.4 Advisory 名單（v1.19.1 處理）

本版 release 後**先讓所有非 Critical 維持 default**，跑一週實際觀察哪些規則確實只是「參考用」。v1.19.1 hotfix 再把它們手動降為 advisory。

理由：分級錯誤的成本不對稱——把 Critical 標成 Default 會少一條防線、但把 Default 標成 Advisory 等於關掉防線。寧可慢一週、別誤降。

---

## 3. 範圍 vs 不範圍

### 3.1 範圍內（v1.19）

- ✅ DB migration：`memories` 表加 `tier` 欄位（default: 'default'）
- ✅ Server API：`GET/POST/PUT/PATCH /memory` 支援 tier 欄位讀寫
- ✅ MCP 工具：`ownmind_save` / `ownmind_update` 接受可選 `tier` 參數
- ✅ Admin UI：鐵律列表顯示 tier、可編輯（單選 dropdown）
- ✅ SessionStart 顯示：按 tier 分組（Critical 加粗放最上、Default 中間、Advisory 摺疊）
- ✅ Compliance event：違反紀錄帶 `tier` 欄位（給 v1.20 用）
- ✅ 共用 helper：`shared/verification.js` 加 `getTier(ruleCode)` 函式
- ✅ Tests：新增 5~8 個測試覆蓋上述變動
- ✅ 同步更新：README（三語系）、FILELIST、CHANGELOG（IR-008、IR-032）

### 3.2 不範圍（v1.20 處理）

- ❌ **告警卡控**：Critical 違反時真的擋下 commit / tool call / reply
- ❌ **動態調整**：例如「Default 連續違反 N 次自動升 Critical」
- ❌ **AI 輔助分類**：用 LLM 自動建議分級
- ❌ **per-user 客製分級**：每個使用者可以覆寫團隊預設

### 3.3 不範圍（v1.21 處理）

- ❌ **拆 memory.js / mcp/index.js**（純重構）

### 3.4 不範圍（永遠不做）

- ❌ **跨平台 tier 差異化**：例如「在 Cursor 上 tier=critical 但在 Claude Code 上 tier=advisory」——複雜度爆炸、跟 OwnMind「跨工具一致記憶」的核心願景矛盾

---

## 4. 影響範圍

### 4.1 資料庫

| 檔案 | 內容 |
|------|------|
| `db/014_iron_rule_tier.sql` | 新增 migration（ADD COLUMN + INDEX） |

### 4.2 Server

| 檔案 | 改動 |
|------|------|
| `src/routes/memory.js` | POST/PUT/PATCH 接受 tier 欄位；GET 回傳 tier；type='iron_rule' 才允許設 tier |
| `src/public/index.html` | 鐵律列表加 tier 欄位顯示 + 編輯 dropdown |
| `mcp/index.js` | `ownmind_save` / `ownmind_update` schema 加 tier 參數 |

### 4.3 Hook / Client

| 檔案 | 改動 |
|------|------|
| `hooks/ownmind-session-start.js` | 鐵律按 tier 分組顯示 |
| `hooks/ownmind-reply-lint.js` | compliance event 帶 `tier` 欄位 |
| `shared/verification.js` | 新增 `getTier(ruleCode)` helper |
| `shared/compliance.js` | violation 物件加 `tier` 欄位 |

### 4.4 測試

新增測試（預估 5~8 個檔）：

- `tests/iron-rule-tier-migration.test.js` — migration 不會壞既有資料
- `tests/iron-rule-tier-api.test.js` — 讀寫 tier 走 API
- `tests/iron-rule-tier-mcp.test.js` — MCP 工具支援 tier 參數
- `tests/iron-rule-tier-session-start.test.js` — SessionStart 分組顯示
- `tests/iron-rule-tier-compliance.test.js` — violation event 帶 tier
- `tests/iron-rule-tier-validation.test.js` — 非 iron_rule type 不准設 tier
- `tests/iron-rule-tier-default.test.js` — migration 既有資料預設為 default

### 4.5 文件

| 檔案 | 改動 |
|------|------|
| `README.md` | 「Iron Rule Enforcement Engine」段落加 tier 系統說明 |
| `docs/README.zh-TW.md` | 同上、繁中版 |
| `docs/README.ja.md` | 同上、日文版 |
| `CHANGELOG.md` | 加 v1.19 條目 |
| `FILELIST.md` | 加 014 migration 與新測試檔 |

---

## 5. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|------|------|------|------|
| migration 影響既有 41 條鐵律 | 極低 | 大 | 純 ADD COLUMN 預設值、不改既有資料、純 reversible |
| 跨工具不同步（舊客戶端讀不到 tier） | 中 | 小 | API 回傳 tier 缺失時用 `default` fallback、hook 也用 fallback |
| Admin UI 手動分級時誤選 | 中 | 中 | 編輯 tier 寫 audit log（誰、何時、從什麼改成什麼）；previous_content 機制已存在 |
| Critical 數量太少、防護網太薄 | 低 | 中 | v1.19.1 hotfix 補；本版設計就是「先嚴後鬆」 |
| 使用者覺得分級沒用、繼續所有規則一樣對待 | 中 | 小 | 本版只是埋種子，v1.20 才會看到真效果；先收資料 |

---

## 6. 跟既有專案的關係

| 項目 | 關係 |
|------|------|
| project_373（OwnMind v3 spec 路線 C） | 本版屬於「路線 C 階段 C」的前置工作——分級資料是 100 條鐵律 benchmark 的前提 |
| project_342（鐵律品質 lint 升級到 LLM 語意評分） | 不衝突，本版只動 tier、不動內容品質 lint |
| IR-027（提醒無效、邏輯才有效） | 本版是 IR-027 的長期解法第一步 |
| v1.18.9（latency 埋點） | 完全獨立、無相依 |

---

## 7. 拍板紀錄

| # | 議題 | 拍板（2026-05-14） |
|---|------|--------------------|
| 1 | 幾級分類 | **3 級**：Critical / Default / Advisory |
| 2 | Critical 名單 | **10 條**：IR-002 / 005 / 008 / 009 / 012 / 024 / 027 / 031 / 038 / 041 |
| 3 | migration 預設值 | **全部設為 `default`**、發版後 admin 手動升 Critical |
| 4 | Advisory 名單時機 | **v1.19.1 hotfix 處理**、本版先讓所有非 Critical 維持 default |
| 5 | 本版是否包含執行邏輯卡控 | **否**、純資料層 + UI、卡控等 v1.20 |

---

## 8. 下一步

1. 寫 `spec.md`（GIVEN/WHEN/THEN 場景）
2. 寫 `tasks.md`（任務清單）
3. 走 TDD（IR-003）：先寫測試 → 跑紅 → 實作 → 跑綠
4. 品管三步驟（IR-012）：verification → request review → handle review
5. 同步 README / FILELIST / CHANGELOG（IR-008、IR-032）
6. browser 實測（IR-020）：admin UI 編輯 tier 流程
7. 三處版號同步（IR-031）：package.json、SERVER_VERSION、git tag
8. Tag v1.19.0、push（Vin 拍板）、提醒部署 prod、跑一週看分級穩定度
9. v1.19.1：根據觀察補 Advisory 名單
