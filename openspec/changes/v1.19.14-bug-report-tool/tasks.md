# v1.19.14 — 錯誤回報工具任務清單（v4、三輪對抗審查後）

## 範圍

### 資料表與 migration
- [ ] 寫 `db/0016_create_bug_reports.sql`
  - [ ] `bug_reports` 表（含 device_fingerprint、client_tool 欄位）
  - [ ] `bug_report_declines` 表（冷靜期）
  - [ ] 🆕 `bug_report_spam_suspects` 表
  - [ ] 🆕 `bug_report_spam_blocks` 表（封鎖期）
  - [ ] 🆕 `bug_report_notification_mutes` 表
- [ ] 5+ 個 index
- [ ] 寫 down migration
- [ ] migration idempotent

### 共用 schema 🆕
- [ ] `shared/context-blob-schema.js`（聯合型別定義 `string | TruncatedMessage`）
- [ ] 後端、後台、客戶端共用
- [ ] schema 測試

### 後端錯誤指紋系統
- [ ] `shared/bug-fingerprints.js`（程式碼層級的列舉表）
- [ ] 業務邏輯擋下處統一引用
- [ ] 全域 5xx handler 用 `srv_err_<class>` 模板
- [ ] 測試：同錯誤生同指紋

### 🆕 後端 spam 偵測器（v4.1 門檻提高）
- [ ] `src/services/bug-report-spam-detector.js`
  - [ ] Levenshtein 距離計算（用既有 lib 或自寫）
  - [ ] 規則 1：1h 5 筆 + 3 筆相似度 > 80%
  - [ ] 規則 2：24h **30 筆**（v4.1 提高）
  - [ ] 規則 3：1h 內同 fingerprint **5 筆**（v4.1 提高、因介面層擋 3 筆）
  - [ ] post-write hook 觸發、背景跑、不卡建立
  - [ ] 寫入 `bug_report_spam_suspects` 表
- [ ] 測試：三條規則各自觸發、相似度算法正確
- [ ] **v4.1 新增**：POST `/api/bug-reports` 中介層加「同 fingerprint 1h 3 筆直接 429」

### 後端 API
- [ ] `src/routes/bug-reports.js` 新增端點：
  - [ ] POST `/api/bug-reports`（建立、頻率限制 + 413 + confirm_string 驗證）
  - [ ] GET `/api/bug-reports`（使用者列表）
  - [ ] GET `/api/bug-reports?scope=all`（管理員）
  - [ ] GET `/api/bug-reports/:id`
  - [ ] PATCH `/api/bug-reports/:id/status`
  - [ ] GET `/api/bug-reports/notifications`
  - [ ] POST `/api/bug-reports/:id/mark-notified`
  - [ ] POST `/api/bug-reports/decline`
  - [ ] 🆕 GET `/api/bug-reports/spam-suspects?status=`
  - [ ] 🆕 POST `/api/bug-reports/spam-suspects/:id/confirm`
  - [ ] 🆕 POST `/api/bug-reports/spam-suspects/:id/dismiss`
  - [ ] 🆕 POST `/api/bug-reports/notifications/mark-all-read`
  - [ ] 🆕 POST `/api/bug-reports/notifications/mute`
- [ ] 中介層：
  - [ ] `bug-report-privacy.js`（強制遮蔽 + fail-closed）
  - [ ] `bug-report-size-limit.js`（1MB）
  - [ ] `bug-report-confirm-string.js`（confirm_string="送出"）
  - [ ] 🆕 `bug-report-spam-block-check.js`（封鎖期內不附 suggest_report）
- [ ] 在 `app.js` 註冊
- [ ] **🚫 v3 設計的 should-prompt API 不做**

### 錯誤回應整合
- [ ] `src/utils/error-response.js` helper：`withReportSuggestion(err, fingerprint, userId)`
  - [ ] 查 `bug_report_spam_blocks`：封鎖期內不附旗標
  - [ ] 查 `bug_report_declines`：冷靜期內不附旗標
  - [ ] 都通過才附 `suggest_report: true`
- [ ] `src/routes/memory.js` 寫入被擋的回應加旗標
- [ ] 全域 5xx handler 加旗標
- [ ] 測試：spam 封鎖、冷靜期、正常三種情況

### MCP 工具
- [ ] `src/mcp-server.js` 新增 `ownmind_report_bug`
- [ ] schema：title / description / severity / component / reproduce_input / context_summary / confirm_string
- [ ] 後端自動補 `context_blob`（OS、Node、client version、client_tool）
- [ ] 文件：確認字串必填提示

### 客戶端 hook
- [ ] **🆕 `hooks/lib/device-fingerprint.js`**（v4.1：用 node-machine-id）
  - [ ] 新增 npm 依賴 `node-machine-id`
  - [ ] 同步更新 install/update 腳本（IR-042）
  - [ ] 呼叫 `node-machine-id` 抓 OS 機器 ID
  - [ ] 串「OS ID + 安裝路徑」算 SHA-256、取前 16 字
  - [ ] 每次啟動算、不寫檔
  - [ ] OS ID 抓不到 fallback：主機名 + 安裝路徑 + `fingerprint_source: "no_machine_id"`
  - [ ] **🚫 砍掉** v3 跨平台路徑 + tmpdir fallback 邏輯
  - [ ] **🚫 砍掉** v4 主機名 + MAC 邏輯（Docker / VPN 不穩）
- [ ] `hooks/lib/bug-report-cooldown-client.js`（呼叫後端 decline）
- [ ] `hooks/lib/bug-report-notifications.js`
  - [ ] fetch admin/reporter/both notifications
  - [ ] mark-notified（單筆）
  - [ ] 🆕 mark-all-read（批量）
  - [ ] 🆕 mute（按 fingerprint 或 own_reports）
- [ ] `hooks/lib/conversation-snippet-truncator.js`
  - [ ] 50 條 / 5KB / 1MB 上限
  - [ ] 用共用 `shared/context-blob-schema.js`
  - [ ] 超過用聯合型別包裝
- [ ] SessionStart hook 整合通知顯示（雙軌）
- [ ] **🚫 砍掉** v3 設計的 `confirm-window.js` hook（多客戶端做不到）
- [ ] **🚫 砍掉** v3 設計的 `bug-report-retry-queue.js`

### 連線失敗 UI
- [ ] AI 提示文字模板：「連不上後端、稍後請說『再試一次回報』」
- [ ] **不依賴**按鈕、不寫暫存檔

### 後台介面
- [ ] `src/public/admin/bug-reports/list.html`
- [ ] `src/public/admin/bug-reports/detail.html`
- [ ] 首頁 `/admin` 加「未處理回報」卡片
- [ ] 🆕 首頁加「疑似 spam」卡片
- [ ] 🆕 `src/public/admin/bug-reports/spam-suspects.html` 列表頁
- [ ] 🆕 spam 確認 / 撤銷對話框
- [ ] 篩選 / 排序 / 分頁
- [ ] 處理狀態編輯區
- [ ] 🆕 通知列表批量已讀按鈕
- [ ] 🆕 通知靜音管理頁 `/admin/notifications/mutes`
- [ ] 關聯的 `reply-lint-events.jsonl` 事件顯示
- [ ] **🆕** `context_blob` 聯合型別渲染（string vs TruncatedMessage 可摺疊區塊）

### 文件
- [ ] `package.json` 版號 1.19.13 → 1.19.14
- [ ] `src/utils/version.js` `SERVER_VERSION` 同步
- [ ] CHANGELOG.md 加 v1.19.14 段
- [ ] FILELIST.md 加新檔
- [ ] 三語系 README（zh-TW / en / ja）
  - [ ] **v4.1 新增**：「API 串接注意事項」段、明寫 `conversation_snippets` 是聯合型別、附 JSON Schema 範例
- [ ] MCP 工具列表文件更新

### 測試
- [ ] 後端 API（`tests/routes/bug-reports.test.js`）
  - [ ] POST / GET / PATCH 全套
  - [ ] 權限、頻率限制、413
  - [ ] notifications 三種 role
  - [ ] decline + mark-all-read + mute
  - [ ] 🆕 spam-suspects 三支端點
  - [ ] 🆕 spam 封鎖期內錯誤回應不附旗標
- [ ] 後端錯誤回應整合（`tests/utils/error-response.test.js`）
  - [ ] 冷靜期內不附
  - [ ] spam 封鎖期內不附
  - [ ] 兩者都過才附
- [ ] 後端指紋（`tests/shared/bug-fingerprints.test.js`）
- [ ] 後端隱私遮蔽（`tests/middleware/bug-report-privacy.test.js`）
  - [ ] fail-closed
- [ ] 後端 confirm_string（`tests/middleware/bug-report-confirm-string.test.js`）
- [ ] 🆕 後端 spam 偵測（`tests/services/bug-report-spam-detector.test.js`）
  - [ ] 規則 1：1h 5 筆 + 相似度 > 80%
  - [ ] 規則 2：24h 10 筆
  - [ ] 規則 3：同 fingerprint 1h 3 筆
  - [ ] Levenshtein 算法正確
  - [ ] 不卡建立流程（背景跑）
- [ ] 🆕 後端聯合型別解析（`tests/shared/context-blob-schema.test.js`）
- [ ] MCP 工具（`tests/mcp/bug-report-tool.test.js`）
- [ ] 🆕 客戶端主機指紋（`tests/hooks/device-fingerprint.test.js`）
  - [ ] 同機器同指紋（多次啟動）
  - [ ] 不同 OS 機器 ID 不同指紋
  - [ ] OS ID 抓不到時 fallback、帶 `fingerprint_source` 標記
  - [ ] Docker / VPN 環境穩定（mock node-machine-id）
- [ ] 客戶端冷靜期（`tests/hooks/bug-report-cooldown-client.test.js`）
- [ ] 客戶端通知 fetch（`tests/hooks/bug-report-notifications.test.js`）
  - [ ] 🆕 mark-all-read
  - [ ] 🆕 mute
- [ ] 客戶端對話截斷（`tests/hooks/conversation-snippet-truncator.test.js`）
  - [ ] 聯合型別正確產出
- [ ] **🚫 砍掉** v3 設計的 confirm-window 測試
- [ ] **🚫 砍掉** v3 設計的 retry queue 測試
- [ ] 整合測試
  - [ ] 全流程：擋下 → 旗標 → 詢問 → 預覽 → 使用者確認 → MCP 呼叫 → 後端遮蔽 → 寫 DB → 後台看到 → 處理 → 通知
  - [ ] 🆕 spam 流程：連送 5 筆相似 → 自動標 suspect → 管理員確認 → 該 user 24h 無旗標
  - [ ] 🆕 靜音流程：使用者靜音 fingerprint → 之後該 fingerprint 處理通知不顯示

### 部署
- [ ] 走 `superpowers:verification-before-completion`
- [ ] 走 `superpowers:requesting-code-review`
- [ ] 跑 prod migration
- [ ] `docker compose build --no-cache` 重建
- [ ] 部署後瀏覽器實測
- [ ] 確認跨工具：用 Claude Code、Cursor 各送一筆、後台都看得到

## 風險檢查點

- [ ] 一般使用者打 `?scope=all` 拿不到別人的資料
- [ ] migration 跑兩次第二次不爆炸
- [ ] 頻率限制：建立 20/h、decline 50/h、notifications 30/h、PATCH 100/h、mark-all 10/h、mute 30/h
- [ ] 對話片段套用 `privacy-detect` 後個資被代稱
- [ ] fail-closed：隱私遮蔽崩潰時 500、不寫 DB
- [ ] 對話片段超過 1MB 被 413 擋下
- [ ] 對話片段截斷時用聯合型別、後端 + 後台都能解析
- [ ] 沒帶 `confirm_string="送出"` 一律被 400 擋下
- [ ] 🆕 spam 偵測：1h 5 筆相似自動標 suspect
- [ ] 🆕 spam 偵測：24h 10 筆自動標 suspect
- [ ] 🆕 spam 確認後該 user 24h 錯誤回應不附旗標
- [ ] 🆕 spam 偵測背景跑、不卡建立 API
- [ ] 🆕 主機指紋：同機器多次啟動同值
- [ ] 🆕 主機指紋：不同機器不同值
- [ ] 🆕 主機指紋 MAC 失敗 fallback、帶標記
- [ ] 🆕 批量已讀：一次清完所有通知
- [ ] 🆕 靜音 fingerprint：30 天內不再收同類通知
- [ ] 🆕 管理員「不提醒自己」開關生效
- [ ] 連不上後端：不寫暫存、AI 用文字提示
- [ ] 跟 `reply-lint-events.jsonl` 用 id 關聯
- [ ] 三語系文件同步更新

## 非任務

- ❌ 語意偵測 → 下一版
- ❌ ML 錯誤分類 → v2.0+
- ❌ 主動回填修復建議 → v2.0+
- ❌ 跟 GitHub Issues 雙向同步 → v2.0+
- ❌ 自動截圖 → 隱私風險
- ❌ 後端自動建草稿 → 會洗髒 DB
- ❌ 本地持久化 retry queue（v3 砍掉）
- ❌ should-prompt 獨立 API（v3 砍掉）
- ❌ **🆕 客戶端 confirm-window hook**（v4 砍掉、多客戶端做不到）
- ❌ **🆕 device-id 檔案持久化**（v4 改主機指紋、即時算）

## 工作量估計（v4）

| 項目 | v3 | v4 |
|---|---|---|
| 資料表 + migration（含 spam suspects + spam blocks + mutes）| 80 | 100 |
| 後端 API（含 spam suspect 3 支 + notifications mark-all/mute）| 280 | 350 |
| MCP 工具 | 80 | 80 |
| 錯誤回應整合（spam 封鎖 + 冷靜期）| 80 | 100 |
| 後端指紋生成器 | 60 | 60 |
| **🆕 後端 spam 偵測器** | – | 150 |
| 後端隱私強制遮蔽 | 70 | 70 |
| 客戶端 hook：通知 fetch（批量已讀 + 靜音）| 100 | 130 |
| 客戶端主機指紋 | 60 | 30 |
| **🚫 confirm-window hook（砍掉）**| 150 | 0 |
| 客戶端兩階段確認預覽 | 80 | 80 |
| **共用 schema** | – | 30 |
| 後台介面（含 spam 頁 + 靜音管理）| 600 | 750 |
| 啟動通知（含批量已讀）| 100 | 130 |
| 後端測試（含 spam + 聯合型別）| 350 | 450 |
| 客戶端測試（不含 confirm-window）| 280 | 200 |
| 文件 | 150 | 150 |
| openspec | 400 | 400 |
| **總計** | **2,920** | **約 3,260** |

工程時間：**約 3.5-4 個工作天**。
