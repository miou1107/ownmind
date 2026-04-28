# Dashboard 團隊一覽改造設計（v1.17.17）

- 日期：2026-04-28
- 版本目標：OwnMind v1.17.17
- 來源：session_log #248 suggestion + memory #281 backlog（E）
- 範圍：admin dashboard `src/public/index.html` + `src/routes/usage/*` + `src/routes/admin.js`

## 一、問題背景

### 1.1 使用者誤解（session #248 觀察）
「團隊用量」分頁裡的「Audit Log」區塊，user 直覺以為是「團隊成員 session 一覽」（誰用什麼工具/做什麼專案/鐵律遵守率），但實際內容是 `usage_audit_log` 表的 ingestion 異常事件（unknown_model / token_regression / fingerprint_collision 等）。命名不符合心智預期。

### 1.2 缺漏功能
admin 沒辦法在 dashboard 看到「最近 7 天，每位成員整體在做什麼、守鐵律守得如何」。所需資料其實已存在 `session_logs.details`（含 `project / duration_turns / rules_complied / rules_skipped / rules_triggered / friction_points / suggestions`），只缺：
- 後端彙總 API
- 前端對應欄位 / 流水帳區塊

### 1.3 UX 細節（memory #281 E）
collector heartbeat 顯示的機器名很短時（例如 Adam 的機器叫 `after`，4 個字母）會看起來像被截斷，需要副資訊（OS、scanner 版本）輔助判讀。

## 二、設計範圍與非目標

### 範圍
1. 把現有「團隊用量排行榜」擴充為**完整成績單**（加最近活動、最常做的專案、鐵律遵守率欄位，預設帶 7 天區間）。
2. 點開成員的「成員詳情」卡新增**對話流水分頁**（每場 session 一列，含機器副資訊）。
3. 「Audit Log」區塊**改名為「資料品質警示」**（只改前端文字、保留位置不動）。
4. 機器名旁加 OS + scanner 版本副資訊（在「對話流水」表呈現）。

### 非目標（明確排除）
- 不做 push 通知 / 警示信
- 不做跨成員的 friction / suggestion 聚合分析
- 不做歷史趨勢圖（成績單只顯示當下 7 天的彙總值）
- 不做 `usage_audit_log` 的 schema 變更（純前端改名）
- 不為「最常做的專案」處理 tiebreaker（票數相同照字典序）

## 三、資料來源與算法

### 3.1 來源資料表
- `session_logs`（已存在）
  - `user_id` / `tool` / `model` / `machine` / `summary` / `details` JSONB / `created_at`
  - `details` 內已有：`project / duration_turns / actions / rules_complied / rules_skipped / rules_triggered / friction_points / suggestions`
- `users`（取 `name`）

不需要 schema migration。

### 3.2 鐵律遵守率算法
```
complied  = details.rules_complied?.length ?? 0
skipped   = details.rules_skipped?.length ?? 0
triggered = complied + skipped

如果 triggered === 0 → 顯示「—」，不參與排名
否則 rate = complied / triggered  → 顯示為百分比（例：92%）
```

整段時間範圍內「成員的整體遵守率」= sum(complied) / sum(triggered)，分子分母分別累加後再除。

### 3.3 最近活動時間
```
max(session_logs.created_at) WHERE user_id = X AND created_at >= now() - interval '7 days'
```

### 3.4 場次
```
count(session_logs.id) WHERE user_id = X AND created_at >= ?
```

### 3.5 最常做的專案
```
SELECT details->>'project' AS project, count(*)
FROM session_logs
WHERE user_id = X AND created_at >= ? AND details->>'project' IS NOT NULL
GROUP BY project
ORDER BY count DESC, project ASC  -- count 相同時字典序
LIMIT 1
```

老 session 沒填 `project` 一律忽略不算（不顯示「未指定」）。完全沒任何 session 帶 `project` 時，欄位顯示「—」。

### 3.6 累計成本 / Token / 訊息數
沿用現有 `team_usage` 排行榜的 `usage_metrics_*` 視圖（不變動），在前端組裝成績單時把兩支查詢結果以 `user_id` join。

## 四、後端 API 設計

### 4.1 新增 `GET /api/usage/admin/team-overview`
**路徑**：`src/routes/usage/team-overview.js`（新檔）

**Auth**：`adminAuth`（admin+）

**Query 參數**：
- `from`（ISO date，預設 now - 7d）
- `to`（ISO date，預設 now）

**回應**：
```json
{
  "range": { "from": "...", "to": "..." },
  "members": [
    {
      "user_id": 1,
      "user_name": "Vin",
      "last_active_at": "2026-04-28T01:26:09Z",
      "session_count": 17,
      "top_project": "ownmind",
      "rule_compliance": {
        "complied": 92,
        "triggered": 100,
        "rate": 0.92
      },
      "cost_usd": 12.34,
      "message_count": 540
    }
  ]
}
```

`rule_compliance: null` 代表全段沒任何 session 觸發鐵律 → 前端顯示「—」。

**實作要點**：
- 一個 query 撈 `session_logs` 彙總（用 CTE：分別跑 last_active / session_count / project_mode / rule_aggregate），最後 join `users`
- 另一個 query 沿用 `team_usage` 邏輯撈 `cost_usd` / `message_count`
- 後端在 JS 層 join 兩份結果（避免單一 SQL 過於肥大）

### 4.2 新增 `GET /api/usage/admin/team-overview/:user_id/sessions`
**Auth**：`adminAuth`

**Query 參數**：`from`、`to`、`limit`（預設 100，上限 500）

**回應**：
```json
{
  "user_id": 1,
  "sessions": [
    {
      "id": 248,
      "created_at": "2026-04-28T01:26:09Z",
      "tool": "claude-code",
      "model": "claude-opus-4-7",
      "machine": "Vincent.local",
      "machine_meta": {
        "os": "macos",
        "scanner_version": "0.4.1"
      },
      "project": "ownmind",
      "duration_turns": 60,
      "rule_compliance": { "complied": 12, "triggered": 12, "rate": 1.0 },
      "summary": "OwnMind 連續發版兩個 patch（v1.17.15 + v1.17.16）...",
      "details": { /* friction_points / suggestions / actions */ }
    }
  ]
}
```

**`machine_meta` 來源**：
- 優先讀 `session_logs.details.machine_meta`（將來 client 主動上送）
- 過渡期：從 `usage_collector_heartbeat` 表用 `(user_id, machine)` 找最近一筆 heartbeat 拿 OS / scanner_version
- 都查不到時 `machine_meta: null`，前端不顯示副資訊

## 五、前端改動

### 5.1 「團隊用量排行榜」表格
**檔案**：`src/public/index.html`（搜「team-usage」相關 section）

**動作**：
- 表頭從「成員 / 成本 / Input / Output / Cache In / Cache Out / 訊息 / 活躍時長 / Session」
- 改為「成員 / 最近活動 / 對話場次 / 最常做的專案 / 鐵律遵守率 / 成本 / Input / Output / Cache In / Cache Out / 訊息 / 活躍時長 / Session」
- **對話場次（新欄，第 3 欄）**：來自 `session_logs` 的 count（AI 主動寫入的會話紀錄）
- **Session（現有欄，保留在最右）**：來自 `usage_metrics_daily.session_id` distinct count（collector 端觀察的對話）
- 兩者**不是同一個值**，hover 各自加 tooltip 解釋來源差異
- 日期篩選器 `teamUsageFrom` / `teamUsageTo` 載入時預設帶最近 7 天（目前進來空白）
- 載入邏輯：在原本 `loadTeamUsage()` 裡多打一次新 API（`/team-overview`），按 `user_id` 在 client 端 merge 兩份結果

**欄位顯示**：
- 最近活動：相對時間（「3 小時前」），hover 顯示完整 timestamp
- 鐵律遵守率：純百分比（「92%」），rate < 0.7 用紅字、>= 0.9 用綠字、其餘灰字
- 最常做的專案：純文字，超長截斷加 hover

### 5.2 「成員詳情」卡片下方新增「最近對話」區塊
**重要**：不動現有 `detailGroupBy` 下拉（避免跟「按 Session」混淆，那邊算的是用量端的 session_id）。

在 `memberDetailCard` 內、`memberDetailBars` 下方新增獨立區塊 `<div id="memberDetailSessionLogs">`：
- 預設摺疊一個展開鈕「查看最近對話 (n)」
- 展開後顯示新表格：時間 / 工具 / 模型 / 機器 / 專案 / 輪數 / 遵守% / 摘要
- 資料來源：`/api/usage/admin/team-overview/:user_id/sessions`（§4.2）
- 機器欄：主行黑字 `機器名`，下行 12px 灰字 `os · scanner_version`（沒副資訊就不顯示第二行）
- 摘要欄超過 60 字截斷，點列展開顯示 `details.friction_points` / `details.suggestions` / `details.actions`

### 5.3 「Audit Log」改名「資料品質警示」
**動作**：把 `<h3>Audit Log</h3>` 改成 `<h3>資料品質警示</h3>`，加說明列：
> 這裡記錄資料抓取時的異常事件（model 無法識別、token 數倒退、指紋衝突等），給管理員追問題用。不是團隊活動紀錄。

不動：API 路徑、表名、event_type 列表、JS function 名（`loadAuditLog`）。

## 六、權限模式

- 兩支新 API 都用既有 `adminAuth` middleware（admin / super_admin）
- 一般成員打 `/team-overview` 回 403
- 前端在 `tab-team-usage` 那塊本來就有 `hidden` class 控制顯示，不變動

## 七、相容性與容錯

- 老 session（v1.16 之前）`details` 沒 `project` / `rules_*` 欄位 → 個別 session 顯示「—」，不擋整個查詢
- `details` 是 NULL（極舊資料）→ 視同空物件處理
- 對話流水 `summary` 是 NULL → 顯示空字串
- collector_heartbeat 還沒 ingest 任何資料的 user → 排行榜不顯示該行，但仍會出現在「對話流水」（因為對話流水從 `session_logs` 撈，不是從 heartbeat 撈）

## 八、測試計畫

### 8.1 單元測試（新加）
- `tests/team-overview-api.test.js`
  - 鐵律遵守率算法（含 triggered=0 邊界、混合 complied+skipped）
  - top_project 票數相同走字典序
  - 老 session（缺 `details.project`）不爆炸、被忽略
  - 時間範圍邊界（`from` / `to` 都包含）
- `tests/team-overview-sessions-api.test.js`
  - limit 上限 500
  - machine_meta 走 fallback（heartbeat 沒資料時為 null）
  - admin 才能查、非 admin 回 403

### 8.2 手動驗證 checklist（IR-020）
1. macOS Chrome 開 dashboard，預設帶 7 天看排行榜：欄位齊全、最近活動相對時間正確
2. 鐵律遵守率紅綠灰三種色看得到（造資料測）
3. 點某成員 → 對話流水分頁出現 → 機器副資訊顯示 / 不顯示兩種狀態
4. 「資料品質警示」標題改了、說明列出現
5. 一般 admin（非 super_admin）打開能看；普通成員看不到 tab

## 九、風險與已知限制

| 風險 | 說明 | 緩解 |
|---|---|---|
| 老資料不齊 | v1.16 前 session 沒 `rules_*` / `project` | 前端顯示「—」、後端忽略；不做 backfill |
| top_project 失真 | 某人 5 場 ownmind / 5 場 ring，靠字典序選 ownmind | 接受。memory #281 等級的小問題，YAGNI |
| `team-usage` 既有 query 大 | 新 API 又 join 一次 session_logs | 每個成員 7 天 session 數通常 < 100，CTE 裡先 filter user_id 範圍 |
| machine_meta fallback 不準 | heartbeat 是「該機器的最新值」，不是 session 當下 | 接受。OS 不會變，scanner_version 滾版會落後幾天 |
| 改名造成英文 i18n 缺一塊 | OwnMind README 已三語系，但 dashboard 字串目前沒走 i18n | 接受。dashboard 短期內仍是繁中為主 |

## 十、版本與發版

- 版本號：`v1.17.17`
- IR-031：`package.json` / `SERVER_VERSION` / git tag 三處同步推
- IR-008 / IR-026：commit 同步更新 README、FILELIST、CHANGELOG
- IR-020：部署後瀏覽器實測上面 §8.2 五項
- IR-022：Server（routes/usage/team-overview.js）+ Client（public/index.html）兩端要同時改

## 十一、後續 follow-up（不在本 spec 範圍）

- memory #281 C / D / F 還在 backlog（mcp/index.js shell 沒 `set -e`、install.ps1 PowerShell 慣用法、P3 marker 字串）
- 「資料品質警示」未來如果完全無人看，可進一步移到「設定」分頁（本次只改名）
- session_logs 端可加觸發器自動寫 `details.machine_meta`，免 fallback heartbeat（下版考慮）
