# v1.19.1 — 密碼/Token 不寫進記憶、AI 自動走 set_secret

- **Author**: Vin
- **Date**: 2026-05-18（提案）
- **Status**: 待 Vin 拍板
- **Worktree**: `confident-heyrovsky-db0eb2`
- **Branch**: `vin/confident-heyrovsky-db0eb2`

---

## 0. 一句話總結

讓 AI 在嘗試把密碼／token／API key 寫進 `ownmind_save` / `ownmind_update`（記憶）時，**靠程式擋下並引導去 `ownmind_set_secret`（密鑰管理）**，而不是讓 AI 自己「踩到 500 才知道走錯路」。

> 白話：把分流規則寫進 server 邏輯 + MCP 工具描述 + 鐵律，而不是只口頭提醒 AI。對應 IR-027「提醒無效，邏輯才有效」。

---

## 1. 設計緣由

### 1.1 真實事件（2026-05-18）

Vin 要 AI 存好好玩 FUNIT 的 WP Application Password。AI 走了 `ownmind_update` 想寫進記憶 → API 回 **500 「更新記憶失敗」**。Vin 看到錯誤訊息也不知道為什麼錯、AI 也不知道下一步該做什麼，只能憑經驗猜「換成 `ownmind_set_secret` 試試」。

實際過程的失敗模式：

1. AI **不知道**密碼類資料應該走 `ownmind_set_secret`（工具描述沒寫）
2. Server **沒有偵測**就嘗試寫入、最後在某個內部錯誤回了 500（generic catch-all）
3. **500 訊息**只說「更新記憶失敗」、沒告訴 caller 是因為什麼問題、也沒指引正確的工具
4. 沒有鐵律提示這條分流規則

### 1.2 為什麼這是 IR-027 的典型失效

IR-027「提醒無效、邏輯才有效」說的就是這種情況：

- 「請 AI 記得敏感資料用 set_secret」這種提醒——AI 看不到、看到也不一定遵守
- 「server 偵測到就直接擋並提示替代工具」這種邏輯——AI 連犯錯都犯不出來

這版要把「提醒層」全部升級為「邏輯層」。

### 1.3 為什麼是 v1.19.1 而不是等 v1.20

- v1.20 範圍是「Critical 鐵律卡控」、屬於通用機制
- 這版範圍很窄（單一 API + 單一工具描述 + 單一鐵律）、改動小、影響面清楚
- 真實事件已經發生、AI 已經寫錯一次、不應該再等下一個版本

---

## 2. 設計方案（三層防護）

| 層 | 做什麼 | 為什麼這層擋得住 |
|----|--------|------------------|
| **A. Server 邏輯卡控** | `PUT /api/memory/:id` 與 `POST /api/memory` 偵測 value 像密碼/token/API key → 回 400 + hint `{ error, hint: "請改用 /api/secret API（或 ownmind_set_secret 工具）", redirect_tool: "ownmind_set_secret" }` | 不管 AI 怎麼寫、都會被擋。對應 IR-027 |
| **B. MCP 工具描述警語** | `ownmind_save` / `ownmind_update` 的 description 開頭加「⚠️ 含密碼／token／API key 請改用 `ownmind_set_secret`，不要寫進記憶」 | AI 在挑工具的階段就看到、不需要踩 500 才知道 |
| **C. 新增 IR-XXX 鐵律** | 「敏感資料一律走 `ownmind_set_secret`、不寫進 memory／不寫進對話／不 commit」 | SessionStart 自動載入、做最後一層備援；也讓鐵律違反紀錄有對應條目可 attribute |

三層**任一層**單獨運作都能擋下這次的事件、合在一起就是 defense-in-depth。

### 2.1 偵測規則（A 層細節）

採**保守偵測**——寧可漏掉（false negative）也不要誤擋（false positive）。命中以下任一條件就視為敏感：

1. **value 長度 ≥ 20** 且**沒有空白以外的中日韓文字**——一般記憶 content 很少是純英數字長串
2. **description 或 title 含關鍵字**（不分大小寫）：`password`, `passwd`, `token`, `api[-_ ]?key`, `secret`, `credential`, `auth.*key`, `bearer`, `客戶端密鑰`, `存取金鑰`, `應用程式密碼`
3. **value 符合常見密鑰格式 regex**：
   - WP Application Password：`^[A-Za-z0-9]{4}(\s[A-Za-z0-9]{4}){5,}$`（4 字一組、≥6 組）
   - JWT：`^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`
   - GitHub PAT：`^gh[opsu]_[A-Za-z0-9]{36,}$`
   - AWS Access Key：`^AKIA[A-Z0-9]{16}$`
   - OpenAI API Key：`^sk-[A-Za-z0-9]{20,}$`

命中任一條件 → 回 400：

```json
{
  "error": "偵測到此內容看起來是敏感資料（密碼／token／API key）",
  "hint": "敏感資料請改用 ownmind_set_secret（MCP 工具）或 POST /api/secret（HTTP API）。記憶系統只應該存非敏感的 user/project/feedback/reference 等內容。",
  "redirect_tool": "ownmind_set_secret",
  "detected_by": "<哪個 rule 命中（regex_name / keyword / length_heuristic）>"
}
```

`detected_by` 給 AI 看、知道為什麼被擋；給未來除錯也用。

### 2.2 例外：bypass flag

極少數情況可能想記「我在 vault 存了 key=foo」這種**指向性記憶**、本身不是密碼。提供 opt-in bypass：

- 在 metadata 加 `"allow_secret_like": true` → server 跳過偵測、照寫
- 寫進 metadata.lint_warnings：`"bypass: allow_secret_like=true at <timestamp>"`、給 audit 用
- bypass 的記憶在 admin UI 顯示警告徽章「⚠️ 跳過敏感偵測」

設計理由：堵漏不是抓間諜、保留有意識的 opt-out 比把規則寫死好。

### 2.3 500 → 4xx 改造（A 層附帶修）

現況 `src/routes/memory.js:1255` 的 catch-all 把所有錯誤都回 500「更新記憶失敗」。
這次順手改：在 catch 內依錯誤類別分流：

| 錯誤類別 | HTTP 狀態 | 訊息 |
|---------|-----------|------|
| validation error（schema 不符、tier 不合法、本次新增的 secret-like detect） | **400** | 帶 hint 跟 detected_by |
| auth/permission error | **403** | 「無權限修改此記憶」 |
| not found | **404**（原本就有、檢查還在前面） | 「找不到該記憶」 |
| **真的內部錯誤**（DB、JSON parse、unhandled） | **500** | 保留「更新記憶失敗」但 log 帶 error.stack |

POST `/api/memory` 同步處理。

---

## 3. 範圍 vs 不範圍

### 3.1 範圍內（v1.19.1）

- ✅ Server `src/lib/secret-detect.js`（新檔）：偵測函式 + 單元測試
- ✅ Server `src/routes/memory.js`：POST + PUT 接 detector、catch 分流 4xx/5xx
- ✅ MCP `mcp/index.js`：`ownmind_save` / `ownmind_update` description 加警語
- ✅ 新鐵律：「敏感資料一律走 `ownmind_set_secret`、不寫進 memory／對話／commit」（透過 admin UI 或 ownmind_save 建立）
- ✅ Tests：新增 6~8 個測試覆蓋偵測、bypass、4xx 分流
- ✅ 同步更新：README（三語系）、FILELIST、CHANGELOG（IR-008、IR-032）

### 3.2 不範圍

- ❌ **Hook 端偵測**：reply-lint 偵測 AI 回話含密碼——範圍另開，這版只擋寫入記憶
- ❌ **Repo scan**：掃既有 memory DB 找有沒有已經寫進去的密碼——v1.19.2 處理（要小心、可能誤判很多）
- ❌ **Critical 鐵律卡控通用機制**：v1.20 處理；這版這條鐵律的「擋下」是 server API 層做的、不依賴 v1.20

---

## 4. 影響範圍

### 4.1 Server

| 檔案 | 改動 |
|------|------|
| `src/lib/secret-detect.js` | **新檔** — `detectSecretLike(value, { description, title }): { detected, reason, rule }` |
| `src/routes/memory.js` | POST + PUT 在寫入前呼叫 detector；500 catch 拆成 4xx/5xx |

### 4.2 MCP

| 檔案 | 改動 |
|------|------|
| `mcp/index.js` | `ownmind_save` 與 `ownmind_update` description 開頭加警語；不動 schema |

### 4.3 文件

| 檔案 | 改動 |
|------|------|
| `README.md` | 「Memory vs Secret」段落新增分流規則 |
| `docs/README.zh-TW.md` | 同上、繁中版 |
| `docs/README.ja.md` | 同上、日文版 |
| `CHANGELOG.md` | 加 v1.19.1 條目 |
| `FILELIST.md` | 加 `src/lib/secret-detect.js` 與新測試檔 |

### 4.4 鐵律

新增 1 條（透過 admin UI 或 `ownmind_save` 建立、不在 repo 內）：

- **標題**：敏感資料一律走 ownmind_set_secret，不寫進 memory／對話／commit
- **tier**：`critical`（IR-002「不要 commit .env 或密碼」的延伸場景）
- **觸發**：`trigger:credential`, `trigger:password`, `trigger:secret`
- **內容**：簡述失效模式（如本提案 1.1）+ 正確走法（`ownmind_set_secret`）

### 4.5 測試

| 檔案 | 覆蓋 |
|------|------|
| `tests/secret-detect-unit.test.js` | detector 各種輸入 → 期望輸出 |
| `tests/memory-api-secret-detect.test.js` | POST/PUT 命中 → 400；bypass flag → 跳過 |
| `tests/memory-api-error-codes.test.js` | 500 拆成 4xx/5xx 行為（validation→400、auth→403、internal→500） |

---

## 5. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|------|------|------|------|
| Detector 誤判（false positive）擋到正常記憶 | 中 | 中 | 規則設計偏保守、提供 `allow_secret_like` bypass、admin UI 顯示偵測命中徽章方便人工 review |
| Detector 漏判（false negative）密碼還是寫進去 | 中 | 大 | 三層防護中還有「MCP 描述警語」+「鐵律」兩層；不追求 100% 完美、追求事件不重演 |
| 舊客戶端不知道 4xx → 顯示「未知錯誤」 | 低 | 小 | hint 字串會直接 surface 給 AI；舊客戶端只是看不到分類、不會壞 |
| Bypass flag 被濫用 | 低 | 中 | bypass 寫進 audit log；admin UI 顯示警告徽章 |
| 既有 memory 已有密碼怎麼辦 | 高 | 大 | **不範圍內**——v1.19.2 補 scan + remediation；先停損未來新增 |

---

## 6. 拍板紀錄

| # | 議題 | 待拍板選項 |
|---|------|-----------|
| 1 | Detector regex 範圍 | A. 上述 5 種（保守） / B. 再加 Slack token / Stripe key / 等 |
| 2 | Bypass 設計 | A. metadata `allow_secret_like: true`（建議） / B. URL query `?allow_secret_like=1` / C. 不提供 bypass |
| 3 | 4xx 細分顆粒度 | A. validation 都用 400（建議） / B. 拆 secret-like → 422 / other validation → 400 |
| 4 | 鐵律是否走 admin UI 建 | A. 由 Vin admin UI 建（建議、有 audit）/ B. proposal 直接寫腳本帶建 |

---

## 7. 下一步

1. Vin 拍板上述 4 點
2. 寫 `spec.md`（GIVEN/WHEN/THEN 場景）
3. 寫 `tasks.md`（任務清單）
4. 走 TDD（IR-003）：先寫測試 → 跑紅 → 實作 → 跑綠
5. 品管三步驟（IR-012）：verification → request review → handle review
6. 同步 README / FILELIST / CHANGELOG（IR-008、IR-032）
7. 三處版號同步（IR-031）：package.json、SERVER_VERSION、git tag
8. 透過 admin UI 建立新鐵律
9. Tag v1.19.1、push、部署 prod
