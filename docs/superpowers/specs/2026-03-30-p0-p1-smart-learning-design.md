# OwnMind P0+P1 設計文件：越用越聰明 + 數據驅動進化

- 日期：2026-03-30
- 版本：v1.10.0（目標）
- 作者：Vin

---

## 背景

OwnMind v1.9.1 完成了資料收集基礎設施（activity log、session log、friction/suggestions 收集、compliance reporting）。
P0+P1 目標是把這些**原始資料變成實際行動**，讓系統「越用越聰明」。

語意搜尋（embedding）本次跳過，維持現有 ILIKE 搜尋。

---

## 範圍

### 包含
- AI client 對話中自動偵測重複模式，主動詢問是否記起來
- AI client 自動把有價值內容存入 `pending_review` 暫存區
- SessionStart 顯示上週摘要（若有）
- Server 週/月報定時 job
- Server friction 頻率統計 → 高頻自動建 project 記憶
- 新增 report API
- init API 擴充回傳 `weekly_summary`
- Admin dashboard 新增「週/月報」頁籤 + suggestions 列表

### 不包含
- 語意搜尋（embedding）
- Suggestions 自動執行（只顯示，不做 auto-action）
- 跨工具即時同步

---

## 架構

```
AI Client (Claude/Cursor 等)
  ├── 對話中偵測重複/有價值 → ownmind_save(pending_review)
  ├── session 結束 → 列出 pending 讓使用者確認
  └── SessionStart → 接收 weekly_summary 並顯示

OwnMind Server
  ├── GET /session/report?period=week|month&offset=N → 週/月報 API
  ├── Scheduled Job（每週一 00:00 Asia/Taipei）
  │   ├── 統計上週 friction_points 頻率
  │   ├── 高頻（>= 3 次）→ 自動建 project 記憶
  │   └── 生成週報快照存入 session_logs
  └── init API 擴充 → 帶 weekly_summary

DB
  └── 不新增表（週/月報存 session_log，friction issue 存 project）
```

---

## 詳細規格

### 1. AI Client：模式偵測（A）

**觸發條件：**
- 同一個問題在本 session 被問第 2 次（AI 判斷語意相似）
- 踩到坑並解決，但沒有對應 iron_rule
- 做了重要技術決策但沒有記錄

**行為：**
```
【OwnMind v1.9.x】行為觸發：偵測到重複模式「{摘要}」
   這是本次 session 第 2 次遇到類似情況，要記起來嗎？
   → 輸入「記」或「跳過」
```

使用者說「記」→ 呼叫 `ownmind_save`，type 由 AI 判斷
使用者說「跳過」→ 不儲存，不再提示同一模式

### 2. AI Client：有價值內容存暫存區（B）

**觸發條件（AI 判斷值得記但不確定）：**
- 解決了一個 bug
- 完成一個 feature 或 milestone
- 學到新的工具用法或指令
- 發現重要的環境/設定資訊

**行為：**
直接呼叫 `ownmind_save(type, title, content, tags=["pending_review"])` 靜默儲存，不打擾使用者。
Session 結束時（現有彙整機制）統一列出待確認項目。

**確認/拒絕流程：**
- 使用者確認 → AI 呼叫 `ownmind_update(id, tags=[...移除 pending_review...])` 使其成為正式記憶
- 使用者拒絕 → AI 呼叫 `ownmind_disable(id, reason="使用者在 session 結束時拒絕")` 停用（不刪除，保留歷史）
- 整合點：ownmind-memory skill 的「主動彙整觸發」區段，session 結束時列出 `tags=pending_review` 的記憶

**不觸發：**
- 純聊天、查詢類問答
- 臨時指令（單次用途）
- 已經明確記錄過的內容

### 3. AI Client：SessionStart 週摘要

init API 若回傳 `weekly_summary`（非 null），SessionStart hook 顯示：
```
【OwnMind v1.9.x】學習回顧：上週摘要（{period}）
   - 新增記憶：{new_memories} 筆
   - 自動建立 friction issue：{friction_issues_created} 個
   - 最常遇到的 friction：{top_frictions[0]}、{top_frictions[1]}、{top_frictions[2]}
```
若 `weekly_summary: null` → 靜默跳過，不顯示任何訊息。

### 4. Server：Scheduled Job

**執行時間：** 每週一 00:00:00 Asia/Taipei（cron: `0 0 * * 1`，UTC 換算 `0 16 * * 0`）
**月報額外執行：** 每月 1 號 00:00:00 Asia/Taipei（cron: `0 16 1 * *` UTC）

**friction_points 格式：** session_logs.details.friction_points 為純文字字串（AI 自由撰寫）。

**分詞策略（刻意保持簡單）：**
- 不用 NLP 套件，改用「整句比對」：把每筆 friction_points 視為一個單位
- 相似度判斷：兩筆 friction 文字的前 20 字元相同 → 視為同一類
- 大小寫統一轉小寫，去除前後空白
- 承認這是 heuristic，精度有限，但避免過度工程化

**週報 job 流程：**
```javascript
// 1. 取上週 session_logs 的所有 details.friction_points（非 null）
// 2. 正規化：toLowerCase().trim()，取前 20 字元為 key
// 3. 統計各 key 出現次數
// 4. >= 3 次的 key → 建 project 記憶（每個 key 只建一筆，避免重複）
//    先查是否已存在 tags 含 friction-issue + title 包含該 key → 存在則跳過
//    title: "⚠️ 高頻 friction：{原始第一筆文字前 50 字}"
//    content: "上週出現 {N} 次。範例：{前 3 筆原文}"
//    tags: ["friction-issue", "auto-generated"]
// 5. 統計上週新增記憶數（memories.created_at 在該 period 內，status=active，排除 pending_review tag）
// 6. 建週報快照存 session_logs
//    title: "週報 {YYYY}-W{WW}"
//    type: session_log
//    details: { period, new_memories, friction_issues_created, top_frictions, top_suggestions }
```

**月報 job 流程：**
- 聚合當月所有週報快照的數據加總
- 存成 `月報 {YYYY}-{MM}` title 的 session_log
- 月報 details 格式與週報相同，只是 period 跨度不同
- 邊界條件：若當月尚無任何週報快照（例如月初 1 號 job 執行時當月第一個週一還沒到），仍建立月報快照（`new_memories: 0`，其他欄位空陣列），避免重複執行

### 5. Server：Report API

```
GET /session/report?period=week&offset=0
GET /session/report?period=month&offset=0
```

**參數：**
- `period`: `week` | `month`
- `offset`: 0 = 本週/月，1 = 上週/月，以此類推

**回應：**
```json
{
  "period": "2026-03-23 ~ 2026-03-29",
  "new_memories": 12,
  "friction_issues_created": 2,
  "top_frictions": [
    { "text": "SSH timeout 連不上", "count": 5 },
    { "text": "Docker cache 沒更新", "count": 4 }
  ],
  "top_suggestions": [
    { "text": "考慮加 retry 機制", "count": 3 }
  ],
  "generated_at": "2026-03-30T00:00:00+08:00"
}
```

**`new_memories` 定義：** 該 period 內 `memories.created_at` 落在範圍內，`status=active`，且 tags 不含 `pending_review`。

**`top_suggestions` 的 tool 欄位：** 目前 session_logs 的 suggestions 欄位是純文字，不帶 tool 來源，暫時省略 tool 欄位。等 session_logs 收集端補上 tool 資訊後再加。

若該週/月尚無快照（job 還沒跑）→ 即時計算回傳（不快取）。

### 6. Server：init API 擴充

`GET /memory/init` 回應新增欄位：
```json
{
  "sync_token": "...",
  "memories": [...],
  "weekly_summary": {
    "period": "2026-03-23 ~ 2026-03-29",
    "new_memories": 12,
    "friction_issues_created": 2,
    "top_frictions": ["SSH timeout", "Docker cache", "git conflict"]
  }
}
```

**weekly_summary marker 機制：**
- marker 存在 DB（user settings 或獨立 table）：`weekly_summary_sent_at`（datetime）
- init 時，若 `weekly_summary_sent_at` 的日期是本週內（週一~週日）→ 回傳 `weekly_summary: null`
- 若不是本週 → 查詢並回傳 weekly_summary，同時更新 marker 為現在時間
- 跨裝置共用：marker 存 server 端（per user），Claude Code 和 Cursor 都 init 時，第一個 init 的裝置拿到摘要，後續同週其他裝置 init 都靜默
- 這表示同一週只有第一次開 session（任何工具）會看到上週摘要

### 7. Admin Dashboard：週/月報頁籤

現有頁籤：`[概覽] [活動] [合規]`
新增：`[概覽] [活動] [合規] [週/月報]`

**週/月報頁內容：**
- 日期選擇器（切換週/月，offset 控制）
- 統計卡：新增記憶數、friction issue 數
- Top Friction 列表
  - 點擊某個 friction → 以 `friction-issue` + 關鍵字前 20 字 搜尋 memories，若找到跳至該記憶的 detail modal（現有 dashboard 已有 modal）；若找不到（job 還沒跑或 count < 3）則不可點擊，顯示為純文字
- Top Suggestions 列表：
  ```
  💡 {N} 次提及：{suggestion 內容}
  ```
  （tool 欄位等 session_logs 補上來源後再加）

---

## GIVEN/WHEN/THEN Scenarios

### Scenario 1：模式偵測
```
GIVEN 使用者在 session 中第二次遇到語意相似的問題
WHEN AI 偵測到重複（純靠 AI context 判斷，為 heuristic，非確定性）
THEN AI 顯示提醒並詢問是否記起來
AND 使用者回答「記」後，ownmind_save 被呼叫，存入正式記憶
AND 使用者回答「跳過」後，AI 在本 session context 內記住不再提示
  （「不再提示」是 in-memory 行為，不寫入 DB，下個 session 重置）
```

### Scenario 2：週報 job
```
GIVEN 每週一 00:00 Asia/Taipei
WHEN job 執行
THEN 統計上週 friction_points
AND 高頻（>= 3次）關鍵詞自動建 project 記憶，tagged friction-issue
AND 週報快照存入 session_logs
```

### Scenario 3：SessionStart 顯示週摘要
```
GIVEN 使用者本週第一次開 session
WHEN SessionStart hook 呼叫 init API
THEN init 回傳 weekly_summary（非 null）
AND SessionStart 顯示上週摘要
AND 下次同週 init 回傳 weekly_summary: null（靜默）
```

### Scenario 4：Report API 即時計算
```
GIVEN job 還未執行（本週剛開始）
WHEN 呼叫 GET /session/report?period=week&offset=0
THEN 即時計算回傳本週至今的資料
AND 不快取
```

### Scenario 5：Dashboard 週報頁
```
GIVEN 管理員開啟 dashboard 週/月報頁
WHEN 選擇上週
THEN 顯示 top friction、top suggestions
AND 點擊可點擊的 friction 項目 → 跳到對應 project 記憶 detail modal
AND 若 friction 記憶尚未生成（count < 3 或 job 未跑）→ 顯示為純文字，不可點擊
```

---

## 實作順序

1. Server：report API + 即時計算邏輯
2. Server：Scheduled Job（friction → project 記憶 + 週報快照）
3. Server：init API 擴充（weekly_summary + marker 機制）
4. Dashboard：週/月報頁籤
5. AI Client：ownmind-memory skill 更新（模式偵測 A + 暫存區 B + SessionStart 週摘要）

---

## 不做的事

- 語意搜尋（embedding）
- Suggestions 自動執行
- 跨工具即時同步
- 記憶自動刪除/合併（由使用者手動管理）
