# v1.19.14 — 錯誤回報工具（使用者 ⇄ 開發者雙向通知）

- **Author**: Vin
- **Date**: 2026-05-24（v1 → v4，經三輪 Gemini 對抗審查）
- **Status**: v4 拍板、等動工
- **預估版次**: v1.19.14

---

## 0. 一句話總結

讓使用者在 OwnMind 出狀況或設計不合理時、能用一致的方式回報給開發者；開發者拿到回報處理完、回報者也會收到通知。

> 白話：以前使用者覺得「OwnMind 怎麼擋了我不該擋的東西」時沒地方反映、只能口頭跟 Vin 講；這版做一個正式管道、AI 主動偵測 + 雙向通知。

---

## 1. 設計緣由

### 1.1 現況缺口

OwnMind 目前**沒有**專門用來「使用者回報程式錯誤或設計問題」的管道：

| 現有機制 | 用途 | 為什麼不夠 |
|---|---|---|
| `ownmind_report_compliance` | 記鐵律遵守狀況 | 語意不對、不是錯誤回報 |
| `ownmind_save` type=project | 記專案待辦 | 語意混雜 |
| 口頭跟 Vin 講 | – | 跨多人時不可擴展、無紀錄、無進度追蹤 |
| GitHub Issues | – | 沒設使用者帳號、外部使用者沒辦法直接報 |

實際踩坑案例：使用者寫專案記憶被擋「掃密誤判」、目前是 Vin 自己記 + 開 patch 處理、其他使用者沒這條路。

### 1.2 為什麼現在做

- v1.19.11 落地的 `reply-lint-events.jsonl` 是錯誤回報的資料根基、但缺「使用者明確說『這是 bug』」這層
- OwnMind 倉庫已公開、未來會有更多使用者、口頭管道擴展不起來

---

## 2. 設計範圍（v4 — 經三輪對抗審查重定）

### 2.1 主動偵測範圍

**第一階段只做明確訊號**：

- 工具呼叫被擋（例如 `ownmind_save` 回 400「敏感資料」）
- 工具呼叫報錯（例如 5xx、連線失敗、逾時）

**下一階段做**：

- 語意偵測（從使用者抱怨的語氣判斷）→ 容易誤判、本版不做

### 2.2 儲存位置

**送中央伺服器**、送之前讓使用者預覽確認。

### 2.3 附帶資料與查詢權限

**回報資料預設附**：

- 觸發回報的前後對話片段（強制經中間層遮蔽、見 2.10）
- 環境資訊（作業系統、AI 工具版本、OwnMind 版本）
- 當前專案路徑（不含內容、只含路徑）
- 觸發時間 + 回報者識別碼 + 來源機器指紋（見 2.6）

**查詢權限**：

- 一般使用者：只看自己的回報
- 管理員（後台 admin 以上）：看全部回報

### 2.4 跟回話品質紀錄檔的關係

兩套保留、用 id 引用、不重複存。回報資料帶 `related_lint_event_ids`（陣列）。

### 2.5 跨多 AI 工具的觸發機制（v4：接受不完美 + 後台 spam 防護）

**v3 設計缺陷（第三輪 Gemini 指出）**：客戶端 `confirm-window hook` 需要 transcript 監聽 + pre-tool 攔截、只在 Claude Code 完整可用；OwnMind 同時支援 Cursor、Codex、Windsurf、Copilot、OpenCode、Gemini CLI 等、其他客戶端做不到。

**v4 改成「接受不完美 + 後台 spam 防護」**：

#### 第一層（後端 `confirm_string` 守門）

- AI 呼叫 `ownmind_report_bug` 必填 `confirm_string="送出"`
- 沒帶或不等於「送出」一律 400 拒絕
- **承認** AI 可能腦補填上「送出」、不指望這層 100% 防

#### 第二層（介面層硬擋同指紋連送）— v4.1 新增

- POST `/api/bug-reports` 加入「同 user + 同 bug_fingerprint 過去 1 小時內 ≥ 3 筆」→ 直接 HTTP 429
- 不寫紀錄、不啟動 spam 偵測流程、直接拒絕
- 擋掉「AI 腦補同樣的錯誤狂送」99% 情況

#### 第三層（後端 spam 偵測 + 自動降級）— v4.1 提高門檻

後端持續分析每個使用者的回報模式、自動標 spam suspect：

| 觸發條件 | 動作 |
|---|---|
| 同 user 過去 1 小時送 ≥ 5 筆、其中 ≥ 3 筆內容相似度 > 80% | 標 `spam_suspect_auto` |
| 同 user 過去 24 小時送 ≥ **30 筆**（v4.1 從 10 提高、原值會誤判正常開發者）| 標 `spam_suspect_auto` |
| 同 user + 同 bug_fingerprint 1 小時內送 ≥ **5 筆**（v4.1 從 3 提高，因介面層已硬擋 3 筆）| 標 `spam_suspect_auto` |

**相似度算法**：title + description 串接後做 Levenshtein 距離、轉成 0-1 相似度分數。

**spam suspect 後果**：

- 後台首頁顯示「N 筆疑似 spam」、管理員可點進去看
- 管理員一鍵「確認 spam」→ 後端對該 user 啟用 24 小時 `suggest_report` 旗標封鎖、客戶端錯誤回應不再附旗標
- 管理員一鍵「正常」→ 撤銷 spam_suspect 標記、繼續看

#### 顯式手動入口（始終保留）

使用者隨時可以打 `/ownmind report` 主動回報、繞過自動偵測、繞過冷靜期。

### 2.6 回報者身分識別（v4.1：改用作業系統機器識別碼）

**v3 設計缺陷**：device-id 寫到 tmpdir 會被清。
**v4 設計缺陷（第四輪 Gemini 指出）**：用主機名 + 主網卡 MAC 在 Docker / VPN / 虛擬機環境會頻繁變動（容器內主機名是隨機 container ID、虛擬網卡讓 MAC 順序不穩）、指紋天天變、通知靜音跟冷靜期失效。

**v4.1 改成「作業系統層級機器識別碼」**：

- 用 npm 套件 `node-machine-id` 抓 OS 提供的穩定 ID：
  - macOS：`IOPlatformUUID`（系統永久 ID）
  - Linux：`/etc/machine-id`（首次開機時設定、之後不變）
  - Windows：登錄檔 `MachineGuid`
- 這些值由作業系統管理、跨重啟穩定、不受網卡或主機名變動影響
- 再串上「OwnMind 安裝路徑」算 SHA-256 → 同機器不同安裝可分辨
- 取 SHA-256 前 16 字當 `device_fingerprint`
- 每次啟動即時算、不寫檔
- 抓不到 OS ID 時（極罕見、容器特殊配置）→ fallback 用主機名 + 安裝路徑 + `fingerprint_source: "no_machine_id"` 標記

`api_key` 識別「是誰」、`device_fingerprint` 識別「來源機器」。

**需要新增 npm 依賴 `node-machine-id`**、依鐵律加同步更新 install/update 腳本（IR-042）。

### 2.7 冷靜期（整合到原始錯誤回應、後端內聯查詢）

維持 v3 的設計：

1. 後端在拋 400 / 5xx 時、內聯查 `bug_report_declines` 表
2. 該使用者過去 24 小時對該指紋的拒絕記錄存在 → **不附** `suggest_report` 旗標
3. 不存在且不在 spam 封鎖期 → 附 `suggest_report: true` + `bug_fingerprint`

拒絕寫入仍是獨立 API：`POST /api/bug-reports/decline`。

### 2.8 通知堆積與洗版控制（v4 新增控制機制）

**v3 設計缺陷（第三輪 Gemini 指出）**：管理員兼回報者時通知無限堆積會洗版、缺乏批量處理機制。

**v4 改成**：

- 管理員啟動：「有 N 筆未處理回報」+ 最近 10 筆列表 + **「全部標為查看過」按鈕**
- 回報者啟動：「有 M 筆你的回報已處理」+ 最近 10 筆 + **「全部標已讀」按鈕**
- 通知列表每筆加「靜音此類」連結（針對 bug_fingerprint）：
  - 點下 → 該使用者 30 天內不再收到「同指紋」的通知
  - 寫到 `bug_report_notification_mutes` 表
- **管理員額外設定**：「不要提醒我自己送的回報」開關（avoid 自製洗版）

### 2.9 錯誤指紋生成（後端統一）

維持 v3：後端列舉表程式碼層級維護、客戶端不參與解析。

| 來源 | 格式 | 範例 |
|---|---|---|
| 業務邏輯擋下 | `<業務代碼>_<情境>` | `mem_blocked_secret_keyword` |
| 5xx | `srv_err_<錯誤類別>` | `srv_err_db_connection` |
| 客戶端錯誤 | `clt_<情境>` | `clt_invalid_payload` |

### 2.10 隱私強制遮蔽（後端做、fail-closed）

維持 v3：

- `shared/privacy-detect.js` 中間層強制執行
- 信箱／身分證／手機 → 代稱
- **fail-closed**：遮蔽崩潰 → 500、不寫 DB

### 2.11 必填欄位 + 對話片段大小上限 + JSON 聯合型別（v4 補完、v4.1 強化文件）

**v3 設計缺陷（第三輪 Gemini 指出）**：JSON 結構截斷會讓單條訊息從 `string` 變 `object`、前後端不一致會崩潰。

**v4 解法**：

- `context_blob.conversation_snippets` 欄位明定為「`(string | TruncatedMessage)[]`」聯合型別
- `TruncatedMessage` schema：`{ truncated: true, original_size: number, head: string, tail: string }`
- 後端與後台解析器都明確處理兩種型別
- 客戶端、後端、後台共用一份 schema 定義（`shared/context-blob-schema.js`）

**v4.1 補強**：要寫客製 MCP 客戶端的進階使用者（特別是用 Go / Rust 等強型別語言對接的）需要在 README API 串接段明白告知聯合型別、否則反序列化會失敗：

- README 加一段「API 串接注意事項」、明寫 `conversation_snippets` 是 `(string | TruncatedMessage)[]` 聯合型別
- 附 JSON Schema 範例
- 三語系同步

**大小上限**：

- 客戶端先截斷：50 條訊息、每條 5KB、總計 1MB
- 超過條數：保留「最後 49 條 + 第 1 條」、中間用 `{ truncated_messages: N, summary: "已省略 N 條" }` 取代
- 超過單條：用 `{ truncated: true, original_size, head, tail }` 包
- 後端再驗一次 1MB（雙重保險）

### 2.12 API 頻率限制

維持 v3：

| API | 限制 |
|---|---|
| POST `/api/bug-reports` | 20 筆 / 小時 / 使用者 |
| POST `/api/bug-reports/decline` | 50 筆 / 小時 / 使用者 |
| GET `/api/bug-reports/notifications` | 30 筆 / 小時 / 使用者 |
| PATCH `/api/bug-reports/:id/status` | 100 筆 / 小時 / 管理員 |
| POST `/api/bug-reports/notifications/mark-all-read` | 10 筆 / 小時 / 使用者 |
| POST `/api/bug-reports/notifications/mute` | 30 筆 / 小時 / 使用者 |

### 2.13 不做

- ❌ 本地持久化 retry queue（v3 砍掉）
- ❌ should-prompt 獨立 API（v3 砍掉）
- ❌ 客戶端 confirm-window hook（v4 砍掉、多客戶端做不到）
- ❌ device-id 檔案持久化（v4 改主機指紋、即時算）
- ❌ 自動回填修復建議（v2.0+）
- ❌ 跟 GitHub Issues 雙向同步（v2.0+）
- ❌ 自動截圖（隱私風險）

---

## 3. 工作量估計（v4）

| 項目 | v3 | v4 |
|---|---|---|
| 資料表 + migration（含 mutes 表）| 80 | 100 |
| 後端 API（含 spam suspect API）| 280 | 350 |
| MCP 工具 | 80 | 80 |
| 錯誤回應整合（含 spam 封鎖 + 冷靜期內聯）| 80 | 100 |
| 後端指紋生成器 | 60 | 60 |
| **🆕 後端 spam 偵測器** | – | 150 |
| 後端隱私強制遮蔽（含 fail-closed）| 70 | 70 |
| 客戶端 hook：通知 fetch（含批量讀 + 靜音）| 100 | 130 |
| 客戶端主機指紋（取代裝置代號）| 60 | 30 |
| **🚫 客戶端 confirm-window hook（v4 砍掉）**| 150 | 0 |
| 客戶端兩階段確認預覽 | 80 | 80 |
| **共用 context_blob schema（v4 新加）** | – | 30 |
| 後台介面（含 spam suspect 頁 + 靜音管理）| 600 | 750 |
| 啟動通知（含批量已讀按鈕）| 100 | 130 |
| 後端測試（含 spam 偵測 + 聯合型別）| 350 | 450 |
| 客戶端測試（不含 confirm-window）| 280 | 200 |
| 文件 | 150 | 150 |
| openspec | 400 | 400 |
| **總計** | **2,920** | **約 3,260** |

工程時間：**約 3.5-4 個工作天**。

> v4 比 v3 略多：砍掉 confirm-window hook（-150）但加 spam 防護（+150）+ 後台 spam 頁（+150）+ 靜音控制（+80）+ 聯合型別共用 schema（+30）+ 測試強化（+100），淨 +340。

---

## 4. 風險檢查點

- [ ] migration 可 idempotent 重跑
- [ ] 後端 API 全套測試綠
- [ ] MCP 工具 `ownmind_report_bug` 可從 Claude Code、Cursor、Codex 各自呼叫成功
- [ ] 一般使用者用自己金鑰看不到別人的回報
- [ ] 管理員看得到全部回報
- [ ] `suggest_report` 旗標：冷靜期外附、冷靜期內不附
- [ ] `suggest_report` 旗標：spam 封鎖期內不附
- [ ] 跨裝置冷靜期同步
- [ ] 啟動通知雙軌（admin + reporter）
- [ ] **🆕 spam 偵測**：1 小時 5 筆 + 3 筆相似度 > 80% 自動標 suspect
- [ ] **🆕 spam 確認**：管理員點「確認 spam」後該 user 24h 不附旗標
- [ ] **🆕 通知批量已讀**：點按鈕後該 user 通知全清
- [ ] **🆕 通知靜音**：點靜音後同 fingerprint 30 天內不再通知
- [ ] **🆕 管理員「不提醒自己」**：管理員開關後不收自己送的回報通知
- [ ] **🆕 主機指紋穩定**：同機器多次啟動算出同一個值
- [ ] **🆕 主機指紋差異**：不同機器算出不同值
- [ ] **🆕 context_blob 聯合型別**：後端與後台都能解析 `string` 跟 `TruncatedMessage`
- [ ] 對話片段超過 1MB 被 413 擋下
- [ ] 對話片段個資寫入前已遮蔽
- [ ] 隱私遮蔽崩潰時 fail-closed（500、不寫 DB）
- [ ] 沒帶 `confirm_string="送出"` 一律被 400 擋下
- [ ] 跟 `reply-lint-events.jsonl` 用 id 關聯
- [ ] 連不上後端：不寫暫存、顯示「稍後重試」訊息
- [ ] 三語系文件同步更新
