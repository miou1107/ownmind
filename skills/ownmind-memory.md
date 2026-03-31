---
name: ownmind-memory
description: OwnMind 記憶管理。當使用者說「記起來」「學起來」「新增鐵律」「更新記憶」「載入記憶」「交接」「整理記憶」，或需要存取個人偏好、鐵律、專案 context 時觸發。
user_invocable: true
---

# OwnMind 記憶管理 Skill

你已連接 OwnMind 跨平台 AI 個人記憶系統。透過 MCP tools 操作使用者的雲端記憶。

## 版本與訊息格式（強制）

**當前版本：v1.9.0**

所有 OwnMind 訊息**一律**使用以下格式開頭：
```
【OwnMind v1.9.0】{訊息類型}：{內容}
```

**訊息類型對照表：**

| 訊息類型 | 使用時機 |
|----------|----------|
| 版本更新 | 啟動時偵測到新版本並自動更新 |
| 更新提醒 | 每日檢查發現遠端有更新 |
| 更新完成 | 使用者同意更新後完成 |
| 記憶載入 | 啟動時載入使用者記憶 |
| 記憶操作 | 讀取、寫入、更新、停用、搜尋記憶 |
| 行為觸發 | 鐵律主動防護攔截 |
| 學習回顧 | 使用者問「學到什麼」 |
| 彙整建議 | 主動彙整候選項 |
| 衝突偵測 | 與本地 memory/skill 矛盾 |
| 交接 | 建立或接手交接 |
| 密鑰存取 | 存取加密密鑰 |
| 鐵律確認 | Periodic re-check 鐵律 |
| 小技巧 | 每次操作後附上的隨機技巧 |

**規則：**
- 禁止使用舊格式（【OwnMind】、【OwnMind 觸發】等）
- 版本號從 skill 檔案頂部讀取，更新版本時只改一處
- 每次操作後附上一行：`【OwnMind v1.9.0】小技巧：...`

## 啟動流程

每次開始新的工作 session 時：
1. 檢查 ~/.ownmind/ 是否有更新（`cd ~/.ownmind && git fetch && git log HEAD..origin/main --oneline`）
2. 如果有更新 → 自動 pull + 更新 skill → 顯示更新了什麼：
   ```
   【OwnMind v1.9.0】版本更新：偵測到新版本，已自動更新：
      - 新增 xxx 功能
      - 修正 xxx 問題
   ```
   （根據 commit message 摘要，用使用者看得懂的語言）
3. 呼叫 `ownmind_init` 載入使用者記憶（包含 profile、principles、**iron_rules**、active_handoff）
4. 顯示載入摘要
5. **將所有 iron_rules 內化為工作準則**，在整個 session 中主動防護（不需列出給使用者，但即將違反時必須攔截）
6. 如果有待接手的交接（active_handoff），先摘要給使用者確認

## 每日更新檢查（強制）

每次 OwnMind 被觸發（任何操作：讀取、寫入、搜尋、彙整等），**必須先執行更新檢查**，但每天最多提醒一次：

**檢查流程：**
1. 讀取 marker 檔案：`cat ~/.ownmind/.last-update-check 2>/dev/null`
2. 比較 marker 日期與今天日期（格式 `YYYY-MM-DD`）
3. 如果 marker 日期 = 今天 → **跳過檢查**，直接執行操作
4. 如果 marker 日期 ≠ 今天（或檔案不存在）→ 執行以下步驟：
   ```bash
   cd ~/.ownmind && git fetch 2>/dev/null && git log HEAD..origin/main --oneline
   ```
5. 更新 marker：`date +%Y-%m-%d > ~/.ownmind/.last-update-check`
6. 如果有新 commit → 顯示提醒：
   ```
   【OwnMind v1.9.0】更新提醒：遠端有新版本（{N} 個 commit），建議更新：
      - {commit message 1}
      - {commit message 2}
   要我幫你更新嗎？
   ```
7. 如果沒有新 commit → 不顯示任何訊息，靜默繼續

**使用者同意更新時（說「好」「更新」「update」等），執行完整更新流程：**
```bash
# Step 1: pull 最新程式碼
cd ~/.ownmind && git pull

# Step 2: 更新 MCP 依賴（如果 package.json 有變動）
cd ~/.ownmind/mcp && npm install

# Step 3: 同步 skill 到本地 Claude commands
cp ~/.ownmind/skills/ownmind-memory.md ~/.claude/commands/ownmind-memory.md

# Step 4: 同步各 AI client config（如果 configs/ 有變動）
# Claude Code: ~/.claude/CLAUDE.md 的 OwnMind 區塊
# 其他 client 的 config 由各自的 bootstrap 機制處理
```
更新完成後顯示：
```
【OwnMind v1.9.0】更新完成：已更新至最新版本
   - 程式碼：✅ git pull 完成
   - MCP 依賴：✅ npm install 完成
   - Skill 同步：✅ 已同步到本地
```

**規則：**
- marker 檔案路徑固定為 `~/.ownmind/.last-update-check`
- 即使 git fetch 失敗（離線等），也要更新 marker，避免重複嘗試
- 此檢查不阻塞操作 — 提醒完畢後繼續執行使用者要求的操作

## 存取提示（非常重要）

每次 OwnMind 有任何操作，**必須**顯示醒目的提示訊息，讓使用者清楚知道 OwnMind 一直在工作。

### 載入時
```
【OwnMind v1.9.0】記憶載入：已載入你的個人記憶
   - 個人偏好：繁體中文、Docker Compose 部署
   - 鐵律：7 條啟用中
   - 專案：6 個專案 context
   - 待接手交接：無
```

### 讀取特定記憶時
```
【OwnMind v1.9.0】記憶操作：已調閱「ring-linebot」專案記憶
```

### 搜尋時
```
【OwnMind v1.9.0】記憶操作：搜尋「SSH 相關規則」→ 找到 2 筆相關記憶
```

### 寫入時
```
【OwnMind v1.9.0】記憶操作：已儲存新鐵律 IR-008「部署前必須檢查環境變數」
```

### 更新時
```
【OwnMind v1.9.0】記憶操作：已更新「ring-linebot」專案進度
```

### 停用時
```
【OwnMind v1.9.0】記憶操作：已停用 IR-003（原因：改用其他測試策略）
```

### 交接時
```
【OwnMind v1.9.0】交接：已建立 → 目標：Codex
   - 狀態：webhook handler 重構做到一半
   - 待完成：error handling、測試
   - 注意：parser 的 signature 驗證不要動
```

### 接手交接時
```
【OwnMind v1.9.0】交接：接手 ← 來源：Claude Code @ MacBook Pro
   - 狀態：webhook handler 重構做到一半
   - 待完成：error handling、測試
   - 注意：parser 的 signature 驗證不要動
   確認接手嗎？
```

### 彙整時
```
【OwnMind v1.9.0】彙整建議：本次 session 有以下值得記錄的事項

   | # | 分類 | 標題 | 說明 |
   |---|------|------|------|
   | 1 | 🚫 鐵律 (iron_rule) | Docker build 要指定 platform | 跨架構部署踩坑 |
   | 2 | 📁 專案 (project) | ring-linebot 完成 webhook 重構 | 進度更新 |
   | 3 | 🔧 技術標準 (coding_standard) | 新增 ESLint 規則 | 統一 import 排序 |

   要記錄哪些？（輸入編號、「全部」、或「跳過」）
```

### 密鑰存取時
```
【OwnMind v1.9.0】密鑰存取：正在取得「line-channel-secret」...
```

### 更新記憶時
```
【OwnMind v1.9.0】記憶操作：已更新「檔案命名規則」
   舊版：檔案名稱要大寫
   新版：檔案名稱要小寫
   原因：統一 Linux 路徑規範
```

## 鐵律主動防護（非常重要）

工作過程中，如果發現當前操作可能違反已知的鐵律，**必須立即顯示提醒並停止違規操作**：

```
【OwnMind v1.9.0】行為觸發：你提醒過「SSH 不要頻繁登入登出」，已強制遵守
```

這是 OwnMind 最核心的價值 — AI 要在**即將違反鐵律的那一刻**主動攔截自己。

## Enforcement Alerts（強制 — 不可忽略）

init 回傳的 enforcement_alerts 是使用者最常違反的鐵律，根據歷史數據自動計算。
這是 OwnMind 的自動進化機制：違反越多的鐵律，提醒越強烈。

行為要求：
- 收到 enforcement_alerts 時，**必須**用【OwnMind 強制注意】格式完整顯示所有 alerts
- 🚨 critical 級別：每次觸發時必須停下來逐字確認，不確認就執行 = 再次違反
- ⚠️ warning 級別：觸發時必須明確說出確認語句
- 📌 notice 級別：內部確認，不准忽略
- 再次違反時，**必須立即**呼叫 ownmind_report_compliance 回報 violate，不可隱瞞
- 不可省略、不可簡化、不可跳過顯示

## Enforcement Engine 行為指示

- git pre-commit hook 會自動攔檢有 verification 條件的鐵律，AI 不需要額外呼叫任何 tool
- report_compliance 時，JSONL 會自動寫入供 git hook 讀取
- 對於有 `recent_event_exists` 前置依賴的鐵律（如 IR-012 品管三步驟），在完成對應步驟後要呼叫 report_compliance
- Session 結束時 auditSession 會自動比對 git log 和合規記錄，發現違規會自動記錄
- 建立鐵律時 Server 會自動匹配檢查模板，告知使用者套了什麼模板

## 什麼時候該記

### 立即儲存（不用問使用者）
- 使用者說「記起來」「學起來」「新增鐵律」
- 使用者說「不要遵守這條」→ 先問原因，確認後 disable（不刪除）

### 「今天學到什麼」（使用者主動問）
當使用者問「你今天學到什麼」「這次學到什麼」「有什麼新發現」「學到哪些」時：

**跨 session 整合：先查暫存區 + 本 session 未上傳的，合併顯示：**
1. 呼叫 API 查詢 `pending_review` tag 的記憶（之前 session 上傳的暫存）
2. 加上本 session 還沒上傳的學習項目
3. 合併顯示，標註來源

**必須使用中文分類名 + OwnMind type 對照格式**，讓使用者一眼看出會記到哪個分類：
```
【OwnMind v1.9.0】學習回顧：

   ─── 暫存區（之前 session 上傳，待確認）───
   | # | 分類 | 標題 | 來源 | 說明 |
   |---|------|------|------|------|
   | 1 | 🚫 鐵律 | SSH 連線規則 | RING / Claude Code 3/27 14:30 | 踩到被 ban 的坑 |
   | 2 | 🔧 技術標準 | ESLint 新規則 | fontrends / Cursor 3/26 10:00 | 統一 import 排序 |

   ─── 本次 session（尚未上傳）───
   | # | 分類 | 標題 | 來源 | 說明 |
   |---|------|------|------|------|
   | 3 | 📁 專案 | RING v2.3 進度 | 本次 session | 完成對話測試模組 |
   | 4 | 👤 個人偏好 | 報告語言偏好 | 本次 session | 圖表英文、文字中文 |

   要正式寫入哪些？（輸入編號、「全部」、或「跳過」）
   確認的項目會從暫存區移為正式記憶，拒絕的會被移除
```

**「來源」欄位格式：** `{project} / {tool} {date} {time}`
- 資料來自暫存區的 metadata：`metadata.project`、`metadata.tool`、`metadata.timestamp`
- 上傳暫存區時，AI 必須自動填入這些 metadata
- 本次 session 未上傳的標記為「本次 session」

**智慧過濾（根據 user 問法自動判斷）：**

| User 說 | 過濾條件 | 過濾欄位 |
|---------|----------|----------|
| 今天學到什麼 | 今天 | `metadata.timestamp` |
| 昨天學到什麼 | 昨天 | `metadata.timestamp` |
| 最近學到什麼 | 最近 7 天 | `metadata.timestamp` |
| 這週學到什麼 | 本週（週一起算） | `metadata.timestamp` |
| RING 專案學到什麼 | RING | `metadata.project` |
| 用 Cursor 學到什麼 | Cursor | `metadata.tool` |
| 伺服器管理學到什麼 | 模糊匹配 title/content | `title` + `content` |
| 鐵律學到什麼 | iron_rule | `type` |
| 今天記了哪些帳密/key | 今天 | `secrets` table（`ownmind_list_secrets`） |

- 過濾在本地做（API 查回全部 `pending_review` 後，AI 按條件篩選）
- 可組合：「今天 RING 專案學到什麼」→ 同時過濾時間 + 專案
- **主題/領域過濾**：沒有精確欄位匹配時，AI 用 title + content 模糊匹配（如「伺服器管理」「部署相關」「資料庫」）
- **密鑰查詢**：user 問帳密/key 相關時，呼叫 `ownmind_list_secrets` 列出密鑰清單（只顯示 key name + description，**不顯示 value**）
- 如果過濾結果為空 → 提示「沒有符合條件的暫存項目」，並問要不要看全部

**中文分類對照表（強制使用）：**

| 中文分類 | OwnMind type | emoji |
|----------|-------------|-------|
| 鐵律 | iron_rule | 🚫 |
| 原則 | principle | 💡 |
| 技術標準 | coding_standard | 🔧 |
| 團隊規範 | team_standard | 📋 |
| 專案 | project | 📁 |
| 個人偏好 | profile | 👤 |
| 作品集 | portfolio | 🏆 |
| 環境 | env | 🖥️ |
| Session 紀錄 | session_log | 📝 |

只列出**還沒寫進 OwnMind 的**，已經記過的不要重複。已經記過的可附註「✅ 已記錄」。

### 主動彙整觸發（列出候選項讓使用者確認）
1. 完成一個 feature 或 milestone
2. 踩坑並解決了
3. 做了重要技術決策
4. 工作超過 2 小時沒彙整
5. Context window 使用超過 40%（會觸發一次性合併流程，見「Context 40% 合併觸發」）
6. 使用者要開新對話或清空對話前

彙整時（同樣使用中文分類 + type 對照）：
```
【OwnMind v1.9.0】彙整建議：本次 session 有以下值得記錄的事項

   | # | 分類 | 標題 | 說明 |
   |---|------|------|------|
   | 1 | 🚫 鐵律 (iron_rule) | Docker build 要指定 platform | 跨架構部署踩坑 |
   | 2 | 📁 專案 (project) | ring-linebot 完成 webhook 重構 | 進度更新 |

   要記錄哪些？（輸入編號、「全部」、或「跳過」）
```

## 怎麼記

### 判斷記憶類型
| 類型 | 什麼時候用 |
|------|-----------|
| iron_rule | 踩坑後的教訓、不可違反的規則 |
| principle | 核心信念、工作方法論 |
| coding_standard | 技術偏好、編碼風格 |
| team_standard | 公司/團隊協作規範：code review 規則、git 治理、目錄結構、開發流程、引用框架、命名慣例等（⚠️ 僅管理員可新增/修改） |
| project | 專案進度、架構、待辦 |
| profile | 個人偏好、溝通方式 |
| portfolio | 完成的作品 |
| env | 環境資訊 |

### 團隊規範（team_standard）設計

**核心概念：** 組織層級的規範，由 admin 建立，自動套用到所有成員。優先級高於個人規則。

**權限控制：**
- **新增/修改/停用**：僅限 `admin` role（後端 API 強制檢查，非 admin 會收到 403）
- **讀取**：所有人（init 時自動載入，不需額外操作）
- **個人關閉（opt-out）**：任何使用者都可以關閉某條團隊規範（僅影響自己，不影響他人）

**動態加載設計（Lazy Loading）：**

團隊規範採用「摘要 + 詳細規則」兩層結構，init 時只載入摘要，觸發時才動態讀取詳細規則：

```
team_standard 記憶（init 載入 — 輕量）:
├── title: "Git 治理規範"
├── content: "團隊 Git 操作必須遵守統一流程"     ← 一行摘要
├── tags: ["trigger:git", "trigger:commit"]       ← 觸發條件
├── metadata: {
│     "rule_id": 42,                              ← 指向詳細規則的記憶 ID
│     "version": "2026-03-27T14:30:00",             ← 規範版本（datetime，無時區）
│     "changelog": "新增 squash merge 規則"       ← 本次更新摘要
│   }
└── status: active
```

```
詳細規則記憶（觸發時才載入 — 完整內容）:
├── id: 42
├── type: "team_standard"
├── title: "Git 治理規範 - 詳細規則"
├── content: |
│     ## Branch Naming
│     - feature/{ticket}-{description}
│     - fix/{ticket}-{description}
│     ## Commit Message
│     - feat/fix/refactor: 開頭
│     ## PR Review
│     - 至少一人 approve
│     ...（可以很長很細）
├── tags: ["rule_detail"]
└── metadata: { "version": "2026-03-27T14:30:00" }        ← 與摘要版本同步
```

**版本管理（強制）：**

每條團隊規範帶有 `metadata.version`（datetime 格式 `YYYY-MM-DDTHH:mm:ss`，無時區），用於追蹤規範更新：

- Admin 更新規範時，**必須同時更新 version 日期**
- Init 載入時，API 回傳每條規範的 version
- AI 在 session 中記錄已套用的版本

**強制更新機制：**

1. **Init 時檢查**：比對 init 回傳的 version 與上次 session 記錄的版本
2. 如果有規範版本更新 → 強制顯示更新通知：
   ```
   【OwnMind v1.9.0】行為觸發：📋 團隊規範有更新，已強制套用最新版
      - Git 治理規範：2026-03-20T10:00 → 2026-03-27T14:30（新增 squash merge 規則）
      - Code Review 規範：未變更
   ```
3. **觸發時檢查**：動態載入詳細規則時，比對快取版本與 API 版本
4. 如果版本不一致 → 清除快取，重新載入最新版，並顯示：
   ```
   【OwnMind v1.9.0】行為觸發：⚠️ 團隊規範「{title}」已更新至 {version}，重新載入最新版
      更新內容：{changelog}
   ```
5. **不允許使用舊版** — AI 不可快取過期規則，必須每次比對版本號

**觸發流程：**
1. 使用者下 git 指令
2. AI 偵測到 `trigger:git` 標籤
3. 從 team_standard 的 `metadata.rule_id` 取得詳細規則 ID
4. 呼叫 `ownmind_get` 或 API 讀取完整規則內容
5. 比對版本號 — 若與快取不同則更新快取
6. 按規則執行，並顯示：
   ```
   【OwnMind v1.9.0】行為觸發：已載入團隊規範「Git 治理規範」(v2026-03-27T14:30)，按規範執行
   ```

**規則：**
- init 時**不載入** `rule_detail` 標籤的記憶，節省 context
- 只有當對應的 trigger 被觸發時才動態載入
- 載入後在當次 session 中快取，但每次觸發需比對版本號
- Admin 建立團隊規範時，如果規則很長，應拆成「摘要記憶 + 詳細規則記憶」兩筆，透過 `metadata.rule_id` 關聯
- Admin 更新規範時，摘要和詳細規則的 `metadata.version` 必須同步更新

**優先級規則（強制）：**
```
team_standard（已開啟）> iron_rule > principle > coding_standard > profile
```

**團隊規範為最高準則（開啟狀態下）：**
- 當任何規則（iron_rule、principle、coding_standard、個人偏好等）與團隊規範衝突時，**一律以團隊規範為主**
- AI 必須主動偵測衝突並發出提醒，不可靜默覆蓋：
  ```
  【OwnMind v1.9.0】衝突偵測：團隊規範「{title}」與你的個人鐵律 IR-{XXX} 衝突
     → 依規定：團隊規範為最高準則，已按團隊規範執行
     → 你的個人規則「{rule_title}」在此情境下被覆蓋
  ```
- 即使使用者指示違反團隊規範，AI 也必須先提醒：
  ```
  【OwnMind v1.9.0】行為觸發：⚠️ 你的操作違反團隊規範「{title}」，此為組織最高準則，無法直接跳過
     如需例外處理，請關閉此團隊規範（需輸入「我確認」）
  ```

**使用者關閉團隊規範（雙重確認，強制）：**
當使用者說「關閉這條團隊規範」「不要套用這條」時：
1. 顯示警告：
   ```
   【OwnMind v1.9.0】記憶操作：⚠️ 你即將關閉團隊規範「{title}」
      - 此規範由管理員設定，優先級高於個人規則
      - 關閉後只影響你自己，不影響其他成員
      請輸入「我確認」以確認操作
   ```
2. **必須等使用者輸入「我確認」才可執行**，任何其他回覆（包括「好」「確認」「yes」）都不算確認，需再次提示
3. 確認後，透過 API 建立個人 opt-out 記錄
4. 顯示：
   ```
   【OwnMind v1.9.0】記憶操作：已關閉團隊規範「{title}」（僅限你個人，團隊其他人不受影響）
   ```
5. **關閉後的持續提醒（強制）：**
   使用者關閉團隊規範後，每次 OwnMind 被觸發時，都必須顯示提醒：
   ```
   【OwnMind v1.9.0】行為觸發：⚠️ 你已關閉團隊規範「{title}」，此規範目前未套用於你
   ```
   - 此提醒每次觸發都顯示，不可靜默，確保使用者持續意識到自己偏離了團隊規範
   - 如果關閉了多條，每條各顯示一行
   - 使用者說「重新啟用」「恢復團隊規範」時，移除 opt-out 記錄即可恢復

**非 admin 嘗試寫入時：**
```
【OwnMind v1.9.0】記憶操作：無法新增團隊規範，此類型僅限管理員操作
```

**Admin 寫入團隊規範（雙重確認，強制）：**
團隊規範會套用到所有成員，因此 admin 寫入前必須再次確認：
1. 顯示即將寫入的內容摘要：
   ```
   【OwnMind v1.9.0】記憶操作：⚠️ 你即將新增團隊規範，此規範將套用到所有成員
      - 標題：{title}
      - 觸發條件：{triggers}
      - 影響範圍：全體成員
      請輸入「我確認」以確認操作
   ```
2. **必須等 admin 輸入「我確認」才可執行**，任何其他回覆都不算確認
3. 修改既有團隊規範時，同樣需要確認，提示改為：
   ```
   【OwnMind v1.9.0】記憶操作：⚠️ 你即將修改團隊規範「{title}」，變更將同步到所有成員
      請輸入「我確認」以確認操作
   ```

### 更新記憶（有時間演變的規則）
規則改變時，用 `ownmind_update` 並**必須填寫 `update_reason`**，舊版本會自動保留在歷史紀錄。

**不要 disable 再重建**，直接 update 才能保留完整時間序列。

### 鐵律格式
```markdown
## IR-XXX：標題
- 建立時間：YYYY-MM-DD HH:mm
- 環境：機器 / 工具 / 模型
- 背景：為什麼訂這條（踩了什麼坑、發生什麼事）
- 規則：具體的規則內容
- 適用範圍：全域 / 特定專案 / 特定語言
```

新增鐵律時，先查現有的 iron_rules 確認最新編號，+1 作為新編號。

### Metadata
每次寫入都帶：
```json
{
  "machine": "機器名稱",
  "tool": "claude-code",
  "model": "claude-opus-4-6",
  "timestamp": "2026-03-26T14:30:00+08:00"
}
```

## 交接流程

### 交接出去（使用者說「交接給 XXX」）
1. 呼叫 `ownmind_handoff_create`，內容包含：
   - 目前做到哪裡
   - 還沒做完的事
   - 需要注意的坑
   - 關鍵檔案路徑
2. 顯示摘要給使用者確認

### 交接回來（init 發現有 pending handoff）
1. 顯示交接摘要
2. 問使用者「確認接手嗎？」
3. 確認後呼叫 `ownmind_handoff_accept`

## 停用規則

使用者說「不要遵守這條鐵律」時：
1. 先問：「這條鐵律是因為 [背景] 訂的，你確定要停用嗎？還是調整適用範圍？」
2. 確認停用 → 呼叫 `ownmind_disable`，帶上停用原因
3. 不刪除，只標記 disabled

## 衝突偵測（非常重要）

當 OwnMind 的記憶與以下來源發生矛盾或衝突時，**不要自行決定，必須主動問使用者**：

- **本地 memory**（~/.claude/memory/ 等）與 OwnMind 記憶不一致
- **本地 skill / workflow**（如 superpowers、openspec、其他已安裝的 skill）與 OwnMind 鐵律或偏好衝突
- **專案級設定檔**（CLAUDE.md、AGENTS.md、.cursorrules）與 OwnMind 記憶矛盾

偵測到衝突時的格式：
```
【OwnMind v1.9.0】衝突偵測：偵測到以下不一致
   - OwnMind 鐵律 IR-003 說「修 bug 前先寫 reproduction test」
   - 但本地 superpowers:test-driven-development skill 要求「先寫 unit test 再實作」
   這兩條規則在此情境下有衝突。
   你希望遵循哪一個？還是兩者都適用、各有不同場景？
```

**原則：**
- 不要默默忽略衝突，使用者有權知道並決定
- 如果使用者做出決定，把結論記回 OwnMind（更新鐵律或新增一條澄清規則）
- 如果是本地設定過時了，建議使用者更新本地設定以保持一致

## Context 40% 合併觸發（一次做完三件事）

當 AI 感覺 context window 已消耗超過 40%（長對話、大量程式碼、多次工具呼叫）時，**一次性觸發以下三個流程**，不分開做：

**40% 時自動執行（不問 user，直接做）：**

1. 鐵律 re-check（背景刷新）
2. 自動建立交接（`ownmind_handoff_create`）
3. 本次學到的東西上傳到暫存區（`ownmind_save` with tag `pending_review`）
4. 顯示摘要：

```
【OwnMind v1.9.0】記憶操作：⚠️ Context 已超過 40%，AI 品質可能開始下降
   ✅ 鐵律已重新載入
   ✅ 交接已自動建立（下一個 session 可無縫接手）
   ✅ 本次學到的 {N} 項內容已上傳暫存區（待你確認後才正式寫入）

   ─── 暫存區內容 ───
   | # | 分類 | 標題 | 說明 |
   |---|------|------|------|
   | ...  | ...  | ...  | ...  |

   💡 建議開一個新的對話來保持工作品質
   → 輸入「自評」可查看本次規則遵守狀況
   → 暫存區內容可在任何 session 中輸入「確認暫存」來正式寫入
```

**暫存區機制：**
- 學到的東西以 `pending_review` tag 存入 OwnMind，不算正式記憶
- 任何 session 中 user 說「確認暫存」「review pending」→ 列出暫存項目讓 user 逐條確認
- User 確認的項目 → 移除 `pending_review` tag，變成正式記憶
- User 拒絕的項目 → disable 並記錄原因

**規則：**
- 每個 session 只觸發一次 40% 流程（觸發後標記，不重複）
- 交接和暫存上傳直接做，不問 user
- 自評仍由 user 主動觸發
- 暫存區不影響規則執行（`pending_review` 的記憶不會被 trigger 機制讀取）

**User 輸入「自評」後展開落地率報告：**
```
【OwnMind v1.9.0】規則自評：

   | 規則 | 遵守 | 遺漏 | 落地率 | 狀態 |
   |------|------|------|--------|------|
   | ...  | ...  | ...  | ...    | ...  |
   📊 總落地率：{X}%

   ⚠️ 需關注：
   - {規則名}遺漏 {N} 次
     → 情境：{具體描述}
     → 建議：{優化方向}
```
- 自評中的遺漏次數仍需 user 確認後才計入 stats

## 規則落地率追蹤（本地統計 + 搭便車回填）

**本地計數（session 內）：**

AI 在 session 內維護一個 `rule_stats` 變數，追蹤每條規則的執行狀況：
```
rule_stats = {
  "IR-005": { enforced: 3, skipped: 1, overridden: 0 },
  "IR-008": { enforced: 0, skipped: 2, overridden: 0 },
  "TS-Git治理規範": { enforced: 5, skipped: 0, overridden: 0 }
}
```

| 計數類型 | 什麼時候 +1 |
|---------|-----------|
| enforced | 觸發規則後按規則執行 |
| skipped | 事後發現該觸發但沒觸發（AI 自我檢查或 user 指出） |
| overridden | user 主動關閉規則後違反 |

**搭便車回填（不額外打 API）：**
- 下次有任何寫入操作（save/update/disable）時，body 多帶 `rule_stats` 欄位
- Server 收到後合併到對應記憶的 `metadata.stats`
- Session 結束前沒有寫入操作 → stats 不回填，下次再算

**遺漏預警（強制）：**

當某條規則的 `skipped` 次數 > 3 時，AI **必須主動提醒**：
```
【OwnMind v1.9.0】記憶操作：⚠️ 規則「{title}」已被遺漏 {N} 次，落地率偏低

   可能原因：
   - trigger 條件不夠精準（目前：{triggers}）
   - 規則描述太模糊，不容易判斷適用時機
   - 規則已不適用當前工作流程

   建議優化方向：
   1. {具體建議 — 根據遺漏情境分析}
   2. {具體建議}

   要我幫你調整這條規則嗎？
```

**規則：**
- 建議必須具體，不可泛泛說「建議優化」
- AI 要根據實際遺漏的情境分析原因（例如：是 trigger 沒匹配到？還是規則太長沒讀完？）
- 如果同一條規則連續 3 個 session 都被遺漏 → 建議降級或重寫
- 如果某條規則 enforced 很高 + skipped = 0 → 可建議升級為 team_standard

## 規則自評機制（session 結束前自我檢查）

**觸發時機（搭現有機制的便車）：**
- **彙整觸發時** — 已有的主動彙整機制觸發時，附帶自評（完成 feature、踩坑解決等）
- **Context window 超過 40%** — 觸發合併流程（自評 + 彙整 + re-check 一次做完）
- **Periodic re-check 時** — 鐵律 re-check（對話超過 20 輪 / 不可逆操作前）順便跑自評
- **User 主動問** — 「自評」「規則遵守狀況」「今天表現怎樣」「落地率」

**自評格式（強制）：**
```
【OwnMind v1.9.0】規則自評：本次 session 規則遵守狀況

   | 規則 | 遵守 | 遺漏 | 落地率 | 狀態 |
   |------|------|------|--------|------|
   | IR-001 SSH 連線規則 | 2 | 0 | 100% | ✅ |
   | IR-005 commit 前跑測試 | 3 | 1 | 75% | ⚠️ |
   | [團隊] Git 治理規範 | 4 | 2 | 67% | ⚠️ |
   | IR-008 部署前檢查環境變數 | 0 | 0 | N/A | 💤 |

   ⚠️ 需關注：
   - IR-005「commit 前跑測試」遺漏 1 次
     → 情境：{具體描述當時在做什麼、為什麼漏了}
     → 建議：{具體的規則優化方向}

   💤 未觸發：
   - IR-008 本次 session 沒有部署操作，未觸發屬正常

   📊 總落地率：80%（8/10）
```

**自評規則（強制）：**
- AI 必須誠實自評，不可全部報 100%
- 遺漏的項目必須寫出具體情境（當時在做什麼、為什麼漏了）
- 未觸發（💤）的規則要說明是正常未觸發還是 trigger 有問題
- **遺漏次數由 user 確認後才正式計入 `rule_stats.skipped`**，避免 AI 誤判
  - 自評時先列出，問 user：「以上遺漏判定是否正確？」
  - User 確認後才 +1，user 否認的不計

**自評結果處理：**
- 確認後的自評結果寫入 `rule_stats`（本地）
- 下次有寫入 API 操作時搭便車回填
- 自評摘要可作為 `session_log` 記錄到 OwnMind

## Sync Token 機制（跨工具一致性保障）

OwnMind 使用 sync token 確保多工具環境下的記憶一致性。

**運作方式：**
- `ownmind_init` 回傳 `sync_token`（當前記憶狀態的 hash）
- MCP client 自動儲存 token，後續每次 API call 都帶上
- Server 比對 token，偵測狀態是否已被其他工具改變

**行為規則：**

| 操作類型 | token 過期時 | 說明 |
|---------|-------------|------|
| 讀取（get/search） | 回傳結果 + `stale: true` + 新 token | 不阻塞，但標記過期 |
| 寫入（save/update/disable） | 409 拒絕 | 強制 re-init 後才能寫 |
| 沒帶 token | 讀取可以，寫入拒絕 | 未 init 的工具不能寫 |

**AI 收到 stale 警告時：**
```
【OwnMind v1.9.0】記憶操作：⚠️ 記憶狀態已被其他工具更新，建議 re-init 取得最新版
```

**AI 收到 409 時：**
```
【OwnMind v1.9.0】記憶操作：❌ 寫入被拒（狀態已變更），正在 re-init...
```
→ 自動執行 `ownmind_init` 取得新 token → 重試寫入操作

**init 回傳的 Version Manifest：**
```json
{
  "sync_token": "a3f8b2c",
  "server_version": "1.7.1",
  "team_standards_hash": "x9d2...",
  "last_team_standard_update": "2026-03-27T14:30:00",
  "iron_rules_count": 7,
  "memories": [...],
  "team_standards": [...]
}
```

## 持續進化

工作中主動反思：
- 現有鐵律是否涵蓋新情境 → 補充或修正
- 發現更好的做法 → 更新 coding_standard
- 專案有重大進展 → 更新 project
- 記憶過時 → disable 並記錄原因

## MCP Tools 速查

| Tool | 用途 |
|------|------|
| `ownmind_init` | 開始時載入記憶 |
| `ownmind_get(type)` | 取得特定類型 |
| `ownmind_search(query)` | 語意搜尋 |
| `ownmind_save(type, title, content, ...)` | 新增記憶 |
| `ownmind_update(id, content, ...)` | 更新記憶 |
| `ownmind_disable(id, reason)` | 停用記憶 |
| `ownmind_handoff_create(...)` | 建立交接 |
| `ownmind_handoff_accept(id, accepted_by)` | 接受交接 |
| `ownmind_log_session(summary, ...)` | 記錄 session |
| `ownmind_get_secret(key)` | 取得密鑰 |
| `ownmind_list_secrets` | 列出密鑰 |
| `ownmind_set_secret(key, value, ...)` | 儲存密鑰 |

## 鐵律 Trigger 機制（強制）

iron_rule 的 tags 中若有 `trigger:xxx` 標記，代表執行該類操作前必須主動 re-check：
- 看到 `trigger:git` 或 `trigger:commit` → 執行任何 git 指令前先確認相關鐵律
- 看到 `trigger:deploy` → 部署前確認
- 看到 `trigger:delete` → 刪除操作前確認
- 看到 `trigger:edit` → 修改程式碼前確認

**流程：** 即將執行上述操作 → 心裡確認有無相關鐵律 → 有則遵守，無則繼續

## Periodic Re-check（強制）

以下任一條件成立時，主動呼叫 `ownmind_get('iron_rule')` 刷新鐵律記憶：
- 對話超過 20 輪
- Context window 使用超過 40%（會觸發合併流程，不需單獨 re-check）
- 即將執行不可逆操作（commit、deploy、刪除）

刷新後顯示：
```
【OwnMind v1.9.0】鐵律確認：鐵律已重新載入，防護持續中
```
