# v1.19.14 — 錯誤回報工具規格（v4、三輪對抗審查後）

> 格式：GIVEN / WHEN / THEN。
> v4 變動：砍掉 confirm-window hook 場景、新增 spam 偵測場景、主機指紋取代裝置代號、通知洗版控制、聯合型別。

---

## 一、資料表

### 場景 1：migration 建立資料表

**GIVEN** v1.19.13 prod 資料庫、沒有相關表

**WHEN** 執行 `db/0016_create_bug_reports.sql`

**THEN**
- 建立 `bug_reports` 表
- 建立 `bug_report_declines` 表（冷靜期）
- 🆕 建立 `bug_report_spam_suspects` 表
- 🆕 建立 `bug_report_notification_mutes` 表
- 🆕 建立 `bug_report_spam_blocks` 表（封鎖期）
- 建立必要 index
- 可 idempotent 重跑

**`bug_reports` 主要欄位**：見 v3、加 `device_fingerprint`（取代 device_id）、加 `client_tool`（哪個 AI 工具報的、from MCP metadata）。

**🆕 `bug_report_spam_suspects` 欄位**：

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | bigserial PK | 是 | – |
| `user_id` | int FK | 是 | – |
| `triggered_at` | timestamptz | 是 | – |
| `trigger_rule` | enum | 是 | high_volume_1h / high_volume_24h / repeated_fingerprint / similar_content |
| `report_ids` | bigint[] | 是 | 觸發這次偵測的回報 id |
| `status` | enum | 是 | pending / confirmed_spam / dismissed |
| `reviewed_by` | int FK | 否 | 管理員 |
| `reviewed_at` | timestamptz | 否 | – |

**🆕 `bug_report_spam_blocks` 欄位**：

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | bigserial PK | 是 | – |
| `user_id` | int FK | 是 | – |
| `blocked_at` | timestamptz | 是 | – |
| `blocked_until` | timestamptz | 是 | 預設 +24h |
| `reason` | text | 否 | 管理員填 |
| `blocked_by` | int FK | 是 | 管理員 |

**🆕 `bug_report_notification_mutes` 欄位**：

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | bigserial PK | 是 | – |
| `user_id` | int FK | 是 | – |
| `mute_target` | enum | 是 | fingerprint / own_reports |
| `target_value` | varchar(64) | 否 | 例如某個 bug_fingerprint |
| `muted_until` | timestamptz | 是 | 預設 +30 天 |

---

## 二、後端 API

### 場景 2-14：建立、列出、權限、狀態流轉、通知、decline、頻率限制

維持 v3 場景 2-14、無變動。

### 🆕 場景 15：取得 spam suspect 列表（管理員）

**GIVEN** 管理員帶 `api_key`

**WHEN** GET `/api/bug-reports/spam-suspects?status=pending`

**THEN**
- HTTP 200、回傳 pending 的 spam suspect 列表
- 每筆含 user_id、trigger_rule、報告 id 陣列、觸發時間
- 依 triggered_at 倒序

### 🆕 場景 16：管理員確認 spam

**GIVEN** 管理員看完 suspect id=5、決定是 spam

**WHEN** POST `/api/bug-reports/spam-suspects/5/confirm` 帶 `{ reason: "AI 腦補垃圾" }`

**THEN**
- HTTP 200
- 更新 `bug_report_spam_suspects.status=confirmed_spam`、記 reviewed_by + reviewed_at
- 自動在 `bug_report_spam_blocks` 寫一筆：user_id + blocked_until=+24h + reason
- 該 user 之後 24 小時錯誤回應都不附 `suggest_report` 旗標

### 🆕 場景 17：管理員撤銷 spam suspect

**GIVEN** 管理員看完 suspect id=5、決定不是 spam

**WHEN** POST `/api/bug-reports/spam-suspects/5/dismiss`

**THEN**
- HTTP 200
- 更新 `bug_report_spam_suspects.status=dismissed`
- 不寫 `bug_report_spam_blocks`
- 該 user 行為照常

### 🆕 場景 18：spam 封鎖期內、錯誤回應不附旗標

**GIVEN** 某 user 在 `bug_report_spam_blocks` 表有未過期紀錄

**WHEN** 該 user 觸發任何錯誤（無論冷靜期狀態）

**THEN** 錯誤回應 JSON **不含** `suggest_report` 欄位（spam 封鎖優先於冷靜期判斷）

### 🆕 場景 19：spam 封鎖期過了、行為恢復

**GIVEN** 封鎖期 24 小時已過

**WHEN** 該 user 再次觸發明確訊號錯誤

**THEN** 錯誤回應依正常邏輯附旗標（受冷靜期影響）

### 🆕 場景 20：批量標已讀通知

**GIVEN** 使用者有 50 筆未讀通知

**WHEN** POST `/api/bug-reports/notifications/mark-all-read?role=reporter`

**THEN**
- HTTP 200
- 所有 `resolved_at IS NOT NULL AND notified_to_reporter=false` 的紀錄改成 true
- 回 `{ marked_count: 50 }`

### 🆕 場景 21：靜音某 fingerprint 的通知

**GIVEN** 使用者不想再收到 `mem_blocked_secret_keyword` 指紋的通知

**WHEN** POST `/api/bug-reports/notifications/mute` 帶 `{ mute_target: "fingerprint", target_value: "mem_blocked_secret_keyword" }`

**THEN**
- HTTP 201、`bug_report_notification_mutes` 新增一筆、`muted_until=+30 天`
- 之後 30 天內 GET notifications 不會回傳該 fingerprint 的處理通知

### 🆕 場景 22：管理員設定「不提醒自己送的回報」

**GIVEN** 管理員自己也送過很多回報、不想自己洗自己版

**WHEN** POST `/api/bug-reports/notifications/mute` 帶 `{ mute_target: "own_reports" }`

**THEN**
- HTTP 201、新增 mute 紀錄
- 之後管理員啟動時 admin 通知不含「自己送的」回報

---

## 三、🆕 後端 spam 偵測器

### 🆕 場景 23：1 小時內送 5 筆 + 3 筆內容相似 → 自動標 spam

**GIVEN** user A 過去 1 小時送了 5 筆回報、其中 3 筆 (title + description) Levenshtein 相似度 > 80%

**WHEN** 新一筆寫入後觸發偵測（背景 task 或 post-write hook）

**THEN**
- `bug_report_spam_suspects` 新增一筆、`trigger_rule="similar_content"`、`report_ids=[那 5 筆 id]`
- 後台首頁卡片數量 +1

### 🆕 場景 24：24 小時內送 30 筆 → 自動標 spam（v4.1 門檻從 10 提高）

**GIVEN** user A 過去 24 小時送了 30 筆回報

**WHEN** 第 30 筆寫入後

**THEN**
- 新增 spam suspect、`trigger_rule="high_volume_24h"`

### 🆕 場景 25：同 fingerprint 1 小時內 5 筆 → 自動標（v4.1 門檻從 3 提高、因介面層已硬擋 3）

**GIVEN** user A 過去 1 小時送了 5 筆指紋皆 `mem_blocked_secret_keyword`（注意：介面層會在第 3 筆 429 擋下、所以實際很難跑到 5 筆、但若繞過介面層仍會被偵測）

**WHEN** 第 5 筆寫入後

**THEN**
- 新增 spam suspect、`trigger_rule="repeated_fingerprint"`、`report_ids` 含這 5 筆

### 🆕 場景 25b：同 fingerprint 1 小時內第 3 筆直接 429（介面層硬擋、v4.1 新增）

**GIVEN** user A 過去 1 小時內已送 2 筆 fingerprint=`mem_blocked_secret_keyword`

**WHEN** 嘗試 POST 第 3 筆同 fingerprint

**THEN**
- HTTP 429、訊息「同類錯誤回報太頻繁、請稍後再試」
- **不寫入** `bug_reports` 表
- **不觸發** spam 偵測流程

### 🆕 場景 26：相似度計算

**GIVEN** 兩筆回報 A、B

**WHEN** 後端計算相似度

**THEN**
- 把 `title + " " + description` 串接、轉小寫、去除多餘空白
- 計算 Levenshtein 距離 / max(lenA, lenB) → 取 1 減去 → 相似度分數
- 分數 ≥ 0.8 視為相似

### 🆕 場景 27：偵測本身有頻率限制

**GIVEN** 偵測器是 post-write hook

**WHEN** 每筆新寫入觸發偵測

**THEN**
- 偵測邏輯本身 ≤ 50ms（不卡建立流程）
- 不在 critical path、寫入失敗不影響回報建立
- 計算密集任務（相似度）背景跑、結果寫 spam_suspects 表

---

## 四、🆕 主機指紋（v4.1：作業系統機器識別碼）

### 🆕 場景 28：每次啟動算出同樣的主機指紋

**GIVEN** 同一台機器、同一個 OwnMind 安裝路徑

**WHEN** OwnMind 客戶端啟動三次

**THEN**
- 每次都呼叫 `node-machine-id` 套件抓 OS 機器 ID：
  - macOS：`IOPlatformUUID`
  - Linux：`/etc/machine-id`
  - Windows：登錄檔 `MachineGuid`
- 串接「OS 機器 ID + OwnMind 安裝路徑」算 SHA-256、取前 16 字
- 三次都得到同一個指紋字串
- 不寫任何檔案

### 🆕 場景 29：不同機器算出不同指紋

**GIVEN** 兩台不同電腦、同一 OwnMind 帳號

**WHEN** 各自啟動

**THEN**
- 兩台機器 OS 機器 ID 不同 → 算出的指紋必不同
- 後台看回報時能分辨「Vin 從 Mac 報的」vs「Vin 從 Windows 報的」

### 🆕 場景 30：Docker / VPN / 虛擬機環境穩定（v4.1 重點）

**GIVEN** OwnMind 跑在 Docker 容器內、或啟用 Tailscale VPN（會塞虛擬網卡）、或在虛擬機裡

**WHEN** 客戶端啟動

**THEN**
- 由於用 OS 機器 ID（不靠主機名、不靠 MAC）、即使容器主機名變動或虛擬網卡進出、指紋仍穩定
- 兩次重啟（hostname 隨機變、MAC 順序不同）→ 仍同一個指紋

### 🆕 場景 31：OS 機器 ID 抓不到時的 fallback

**GIVEN** 容器特殊配置、`/etc/machine-id` 不存在、`node-machine-id` 套件回傳 error

**WHEN** 客戶端嘗試生指紋

**THEN**
- fallback 用「主機名 + 安裝路徑」算 SHA-256
- 帶 `fingerprint_source: "no_machine_id"` 標記
- 後台知道這台 OS 沒提供穩定 ID、可能不穩

### 🆕 場景 32：複製 OwnMind 安裝到新機器、指紋不同

**GIVEN** 把整個 OwnMind 安裝目錄複製到新機器

**WHEN** 新機器啟動

**THEN**
- OS 機器 ID 不同 → 指紋必不同
- 後台分得出兩台機器

---

## 五、MCP 工具 `ownmind_report_bug`

### 場景 32-35：見 v3 場景 19-23

包含建立、自動補環境、confirm_string 驗證、兩階段預覽、隱私強制遮蔽 fail-closed。

**🚫 v4 砍掉 v3 場景 24-30**（confirm-window hook 相關）：多客戶端做不到、整層拿掉。

---

## 六、錯誤回應整合 `suggest_report` 旗標

### 場景 36：被擋 + 冷靜期外 + 非 spam 封鎖期 → 附旗標

**GIVEN** 使用者寫入被擋、過去 24 小時沒拒絕過該指紋、不在 spam 封鎖期

**WHEN** 後端拋 400

**THEN** 回應 JSON 含 `suggest_report: true` + `bug_fingerprint`

### 場景 37：冷靜期內 → 不附旗標

**GIVEN** 過去 24 小時拒絕過該指紋

**WHEN** 後端拋 400

**THEN** 回應 JSON 不含 `suggest_report`

### 🆕 場景 38：spam 封鎖期內 → 不附旗標（優先於冷靜期）

**GIVEN** 該 user 在 `bug_report_spam_blocks` 有未過期紀錄

**WHEN** 後端拋 400 / 5xx

**THEN** 回應 JSON 不含 `suggest_report`、優先於冷靜期判斷

### 場景 39：2xx 正常 → 不附旗標

維持 v3。

---

## 七、AI 自動填欄位 + 對話片段截斷（聯合型別）

### 場景 40：AI 填得齊所有欄位

維持 v3。

### 場景 41：AI 抓不到某欄位 → 佔位

維持 v3。

### 🆕 場景 42：對話片段聯合型別（`string | TruncatedMessage`）

**GIVEN** 對話歷史含一條 100KB 的訊息

**WHEN** 客戶端準備 `context_blob.conversation_snippets`

**THEN** 該條變成：
```json
{
  "truncated": true,
  "original_size": 102400,
  "head": "前 2KB 內容...",
  "tail": "...後 2KB 內容"
}
```

而其他條短訊息保持為 `string` 型別。整個陣列型別為 `(string | TruncatedMessage)[]`、共用 schema 在 `shared/context-blob-schema.js`。

### 🆕 場景 43：後端解析聯合型別、不崩潰

**GIVEN** 後端接收的 `conversation_snippets` 含混合 string 與 TruncatedMessage

**WHEN** 後端中間層處理（隱私遮蔽、寫入 DB）

**THEN**
- 對每條訊息判斷型別
- string 直接套用 privacy-detect
- TruncatedMessage 對 head + tail 個別套用 privacy-detect
- 都不崩潰

### 🆕 場景 44：後台解析聯合型別、顯示給管理員

**GIVEN** 後台讀取一筆回報的 `conversation_snippets`

**WHEN** 後台介面渲染

**THEN**
- string 直接顯示
- TruncatedMessage 顯示為摺疊區塊：「訊息已截斷（原長 100KB）」+ 可展開看 head/tail

### 場景 45：50 條 + 1MB 上限

維持 v3。

---

## 八、後台介面

### 場景 46-49：列表頁、詳細頁、權限擋下

維持 v3 場景 41-44。

### 🆕 場景 50：管理員首頁 spam suspect 卡片

**GIVEN** 管理員開 `/admin`

**WHEN** 頁面載入

**THEN**
- 首頁多一張卡片：「疑似 spam：N 筆」
- 點擊跳 `/admin/bug-reports/spam-suspects?status=pending`

### 🆕 場景 51：spam suspect 列表頁

**GIVEN** 管理員開 `/admin/bug-reports/spam-suspects`

**WHEN** 頁面載入

**THEN**
- 表格顯示：user / triggered_at / trigger_rule / 報告數
- 點 user 跳該 user 所有回報的列表
- 每筆 suspect 兩個按鈕：「確認 spam」（紅）、「正常」（綠）

### 🆕 場景 52：管理員點「確認 spam」

**GIVEN** 管理員點 suspect id=5 的「確認 spam」按鈕

**WHEN** 跳出確認對話框、輸入封鎖理由、按確認

**THEN**
- 呼叫 POST `/api/bug-reports/spam-suspects/5/confirm`
- 列表刷新、id=5 從 pending 消失
- 該 user 被列入封鎖期

### 🆕 場景 53：通知列表加批量已讀 + 靜音

**GIVEN** 使用者啟動時看到通知列表

**WHEN** 通知區渲染

**THEN**
- 列表頂端有「全部標已讀」按鈕
- 每筆通知右側有「靜音同類」連結
- 管理員額外有「不提醒我自己」開關

---

## 九、啟動時通知整合

### 場景 54-57：見 v3 場景 45-48

雙軌通知顯示、沒有時不顯示。

---

## 十、降級與失敗模式

### 場景 58：連不上後端 → 顯示錯誤、不暫存

**GIVEN** 客戶端 AI 呼叫 `ownmind_report_bug`、後端 timeout / 5xx

**WHEN** 連線失敗

**THEN**
- 客戶端顯示：「目前連不到 OwnMind 後端、回報未送出、請稍後再試」
- **不寫**本地暫存、**不自動**重試
- AI 用文字提示使用者「需要時請說『再試一次回報』」（純文字、不依賴按鈕）

### 場景 59：通知 fetch 失敗 → 靜默略過

維持 v3。

### 🚫 v4 砍掉 v3 場景 51（confirm-window hook 攔截 AI 跳預覽）：hook 整層拿掉、不再相關

---

## 十一、隱私邊界

### 場景 60-62：強制中間層遮蔽、預覽全文、勾掉所有片段仍可送

維持 v3 場景 52-54。
