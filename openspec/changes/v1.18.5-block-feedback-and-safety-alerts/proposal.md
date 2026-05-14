# v1.18.9 — 4 種安全告警偵測 + latency_ms 埋點

> **🚫 block_feedback 功能棄用（2026-05-14 part 2）：** 拍板時設計成「訊息流 markdown 連結 → 開瀏覽器確認頁」、實作時撞牆：
> - reply-lint hook 沒辦法在 client 端簽 sig（沒 server secret 也沒 user_id）
> - OwnMind 沒 cookie/session 機制（純 Bearer api_key），網頁端要 POST 必須先登入
> - 「網頁需登入」徹底違反拍板「按一次 1 秒完成」的 UX 目標
>
> 三個替代方案（純 CLI / 連結+登入 / hook 等 server 簽 sig）Vin 都拒絕，整個 block_feedback 功能棄用。已 commit 8bcfc69 的 server 端程式（feedback-sig / block-feedback handler / 兩個 route / 兩個 test）下個 commit 全部刪除。git 歷史保留作為「曾嘗試」紀錄。
>
> **本提案剩餘範圍：** 4 種安全告警 + 健康度分頁 + latency_ms 埋點。誤殺率指標卡（C6）也跟著移除（沒 block_feedback event 來源）。
>
> ---
>
> **版號修正（2026-05-14）：** 原本以 v1.18.5 命名，但 v1.18.5/.6/.7/.8 已被前面 4 次 hotfix / 觀測補丁占用，本提案實際發版號為 **v1.18.9**。worktree 目錄名保留不變（`v1.18.5-block-feedback-and-safety-alerts`）以避免 git 路徑變動。
>
> **範圍擴充（2026-05-14）：** 合併原規劃 v1.18.6 才做的 `latency_ms` 埋點（漏作項）一併在本版發。

- **Author**: Vin
- **Date**: 2026-05-13（提案）/ 2026-05-14（拍板、part 2 棄用 block_feedback）
- **Status**: 範圍縮減，4 種安全告警 + 健康度分頁 + latency 埋點實作中
- **Worktree**: `determined-bouman-20c22a`
- **Branch**: `vin/determined-bouman-20c22a`

---

## 0. 設計緣由

v1.18.4 落地產品健康度日報雛形（路線 C 階段 A、只看絕對數字）。下一步要補 Phase 1 MVP 缺的兩個指標：

| Phase 1 MVP 指標 | 現況 | 缺什麼 |
|---|---|---|
| 24h 違反率（B2） | ✅ 已有 `iron_rule_compliance` event | — |
| MCP API p95（C4） | ⚠️ 部分有 | 補 `latency_ms` 埋點（v1.18.6 處理） |
| **規則阻擋誤殺率（C6）** | ❌ 完全沒收 | **新增「擋錯了」回饋機制** |
| 阻擋後修正成功率（C8） | ⚠️ SQL 太難 | Phase 2 處理 |
| WAU/MAU | ✅ 已有 activity_logs | — |
| **4 種安全告警** | ❌ `usage_audit_log` 機制有但 0 偵測規則 | **新增 4 種偵測規則** |

這份 proposal 處理「規則阻擋誤殺率」+「4 種安全告警」兩件事。

---

## 1. 為什麼要做

### 1.1 規則誤殺率：沒有回饋管道、規則設計無法演進

現況：reply-lint Stop hook（v1.17.96 起）或鐵律阻擋觸發時、AI 只看到警告、user 沒辦法說「擋錯了」。

問題：
- 規則太嚴 → user 默默 disable 鐵律或忽略警告、產品端看不到
- Gemini r3 review 警告：誤殺率 > 30% 是 UX Score 紅燈閾值、現在連量都沒在量

設計目標：
- 阻擋發生時、客戶端顯示「擋錯了 👎」按鈕（reply-lint 警告 + 鐵律阻擋兩個來源）
- 客戶端送 false positive 紀錄到 `block_feedback` 事件（用 `activity_logs.event='block_feedback'`、不新建表）
- 管理員儀表板看誤殺率：`(擋錯了次數 / 總阻擋次數) × 100%`

### 1.2 安全告警：機制有、偵測規則 0 條

現況：
- `usage_audit_log` 表已存在（007 migration）
- `event_type` 欄位可承載任何告警類型
- 但目前**只有 `unknown_model` 一種事件**（token pricing 對不上時寫的）
- 真實安全告警（記憶誤同步、密鑰洩漏、越權存取）**從沒被偵測過**

設計目標：4 種告警偵測規則、在現有 server 端加 hook：

| 告警 | 偵測時機 | 觸發條件 |
|---|---|---|
| 私人記憶誤同步 | `GET /api/memory/sync` | 回傳 memory 的 `user_id` ≠ 請求者 `user_id` |
| 密鑰洩漏 | response body 寫入 logs 時 | logs 內容 regex 比對 secrets 表 value |
| 跨使用者越權存取 | 所有 `/api/memory/*` 回傳 | 回傳 memory.user_id ≠ req.user.id |
| 大量資料外洩 | rate limit 中介層 | **單 user_id / api_key**（不用 IP、避免 NAT 共用誤殺）1h 內讀取 > 1000 筆 |

按 Gemini r2 / r3 三輪 review 建議：
- ✅ 用 user_id / api_key 維度、不用 IP（NAT 盲點）
- ✅ 4 種都是 `Fatal` 級、觸發即立即暫停受影響帳號
- ✅ 不顯示告警細節給管理員（只顯示 user_id + 告警類型、防隱私反查）

---

## 2. 範圍 vs 不範圍

### 範圍內
- ✅ `block_feedback` event 寫入 + 客戶端按鈕（reply-lint hook + Claude Code 阻擋 UI）
- ✅ 4 種安全告警偵測規則（server 端 middleware）
- ✅ 管理員儀表板加「健康度」分頁、顯示誤殺率 + 安全告警件數
- ✅ 安全告警觸發後的自動暫停帳號邏輯

### 範圍擴充（2026-05-14 合併進 v1.18.9）
- ✅ MCP API 延遲埋點（mcp/index.js 加 `latency_ms`）— 原規劃 v1.18.6 處理但漏作

### 不範圍（v1.19.x+ 處理）
- ❌ Phase 2 阻擋後修正成功率（SQL 需要關聯兩個 event、太難）
- ❌ Phase 3 凍結 100 條鐵律 benchmark
- ❌ 規則生效覆蓋率 < 10% 強制紅燈（依賴 Veto 機制、Gemini r3 警告 Veto 太嚴、設計層議題）

---

## 3. 拍板決策（2026-05-14 完成）

| # | 議題 | 拍板結果 | 備註 |
|---|---|---|---|
| 1 | 「擋錯了」按鈕怎麼顯示 | **訊息流裡的 markdown 連結 → 開瀏覽器確認頁** | 原本 Vin 選「IDE 渲染按鈕」，但 [project_326](memory) 已驗證 Claude Code 架構不允許 MCP server 渲染按鈕，改成等價的「藍色 markdown 連結」方案。Cursor/Gemini/Codex 直接看得到、Claude Code 摺疊卡片時 user 可手動展開 |
| 2 | false positive 回饋形式 | **網頁確認頁面（按一次確認、不要表單）+ CLI 並存** | 主管道是連結 → 確認頁，「按一次確認 1 秒完成」把多話降到最低；CLI `ownmind report-false-positive --event-id=xxx` 保留給 power user / AI agent |
| 3 | 4 種告警觸發後 | **只通知 super_admin、不自動暫停帳號** | 自動暫停風險高、誤判封自己 user。一個月後看資料再決定要不要加自動暫停 |
| 4 | 暫停閾值（大量資料外洩） | **單 user / api_key 1h 內讀取 > 1000 筆** | 合理上限，避免 AI agent 腳本誤觸 |
| 5 | 規則阻擋誤殺率紅燈閾值 | **> 30%** | 先寬鬆、跑 1 個月看趨勢再調 |

**衍生設計決定（基於拍板結果）：**

- 連結 URL 帶 HMAC 簽名（防 URL 被盜用）：`https://kkvin.com/ownmind/feedback/block?event_id=xxx&sig=abc123`
- 確認頁面只顯示一個 `[確認擋錯了]` 按鈕、按下 POST → 顯示「已回報」、1 秒後自動關閉。不要表單、不要原因欄位
- CLI 通道（決策 2 並存）走同一個 server endpoint `POST /api/feedback/block`，但用 `Authorization: Bearer ${OWNMIND_API_KEY}` 而不是 sig query param

---

## 4. 影響範圍

### 4.1 客戶端
- `hooks/ownmind-reply-lint.js` 加「擋錯了」CLI 提示文字
- 新增 mcp tool：`ownmind_report_false_positive(event_id, reason?)`

### 4.2 Server
- 新增 `src/middleware/safety-alerts.js`：4 種告警偵測規則
- 新增 `src/routes/block-feedback.js`：接 false positive 回報
- 新增 `src/routes/admin-health.js`：管理員儀表板 endpoint
- 改 `src/routes/memory.js`：sync endpoint 加 user_id 比對
- 改 `src/public/index.html`：admin 網頁加「健康度」分頁

### 4.3 資料庫
- **不新增表**（用既有 activity_logs + usage_audit_log）
- 不需要 migration

---

## 5. 風險

| 風險 | 機率 | 影響 | 緩解 |
|---|---|---|---|
| 「擋錯了」按鈕誤點率高、誤殺率假升 | 中 | 看板誤導 | 增加 reason 欄位、強制填短說明 |
| 4 種告警誤判封 user 帳號 | 中 | user 被誤封 | 採用「只通知、人工決定」（決策 3 選 B）|
| 安全告警 SQL 拖慢 API 回應 | 低 | API p95 上升 | 用 async 寫入 audit log、不擋主流程 |
| user 看到「擋錯了」按鈕就一直點 | 低 | 數據污染 | 同 user 同 event 5 分鐘內只記一次 |

---

## 6. 跟 v1.18.4 / 路線 C 的關係

| 階段 | 落地版本 | 內容 |
|---|---|---|
| 路線 C 階段 A | **v1.18.4 已完成** | 健康度日報 SQL 雛形、4 個絕對數字 |
| 路線 C 階段 A+ | v1.18.5 / .6 / .7 / .8 | sync hotfix + 錯誤觀測 enrichErrorDetails + 健康度日報 launchd 排程 |
| 路線 C 階段 B | **本 proposal v1.18.9** | 阻擋誤殺回饋 + 4 種安全告警 + latency_ms 埋點（合併原 v1.18.6 漏作項） |
| 路線 C 階段 C | v1.19.x | 等 user > 10、樣本 > 1000 後、再實作 v3 spec 完整綜合指標 |

---

## 7. 拍板後下一步（執行中）

1. ✅ Vin 對 5 個決策議題拍板（2026-05-14）
2. ✅ 更新 proposal.md / spec.md / tasks.md 反映拍板結果
3. 走 TDD（按 IR-003）寫 reproduction test → 實作 → 測試
4. browser 實測（按 IR-020）— 連結方案的網頁確認頁、安全告警觸發
5. 走品管三步驟（按 IR-012/045）+ 同步 README/FILELIST/CHANGELOG（按 IR-008）
6. Tag v1.18.9、push、提醒 Vin 部署 prod、跑兩週看資料
