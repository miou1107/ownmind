# v1.19.1 — 密碼/Token 不寫進記憶 規格（GIVEN / WHEN / THEN）

> BDD 三段式描述（前提 / 動作 / 預期結果），對應 OpenSpec CONVENTIONS.md。
> Detector 規則與分流邏輯定義在 proposal §2，本檔只描述外部可觀察行為。

---

## 場景 1：偵測到 WP Application Password 格式 → 擋下

**GIVEN（前提）**

- API server 已部署 v1.19.1
- 已登入的使用者帳號

**WHEN（動作）**

```http
POST /api/memory
Content-Type: application/json

{
  "type": "reference",
  "title": "好好玩 FUNIT WP password",
  "content": "iXEN ops5 pJcy 8PJI lVFM heaH",
  "description": "WordPress Application Password"
}
```

**THEN（預期結果）**

- 回應 **400 Bad Request**
- body：
  ```json
  {
    "error": "偵測到此內容看起來是敏感資料（密碼／token／API key）",
    "hint": "敏感資料請改用 ownmind_set_secret（MCP 工具）或 POST /api/secret（HTTP API）。",
    "redirect_tool": "ownmind_set_secret",
    "detected_by": "regex:wp_application_password"
  }
  ```
- `memories` 表**沒**寫入新列
- 不寫 history 紀錄

---

## 場景 2：偵測到 JWT 格式 → 擋下

**GIVEN**

- API server 已部署 v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "API token",
  "content": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
}
```

**THEN**

- 400 + `detected_by: "regex:jwt"`
- 同場景 1 結構

---

## 場景 3：keyword 命中（title/description 含 "password"）→ 擋下

**GIVEN**

- API server 已部署 v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "Stripe production password",
  "content": "abc123XYZ789longRandomString"
}
```

**THEN**

- 400 + `detected_by: "keyword:password"`
- 即使 content 不符任何 regex、只要 title/description 含敏感關鍵字仍擋

---

## 場景 4：長度啟發式（length ≥ 20 純英數字、無中文）→ 擋下

**GIVEN**

- API server 已部署 v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "key for service",
  "content": "abcDEF1234567890XYZ9876543210"
}
```

**THEN**

- 400 + `detected_by: "heuristic:long_alnum"`

---

## 場景 5：正常記憶（含中文）→ 不擋

**GIVEN**

- API server 已部署 v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "project",
  "title": "好好玩 FUNIT 接手後緊急事項",
  "content": "2026-05-07 接手後第一週需要處理的緊急事項清單：1. WP backup ..."
}
```

**THEN**

- 回應 **201 Created**
- detector 因為 content 含 CJK 字元、不進入長度啟發式判定
- 也沒有命中任何 regex 或 keyword
- 正常寫入 `memories` + `memory_history`

---

## 場景 6：bypass flag → 允許寫入但記 audit

**GIVEN**

- API server 已部署 v1.19.1
- 使用者明確要記「我把 key 存在 vault 了」這種指向性記憶

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "FUNIT WP password 存放位置",
  "content": "存在 1Password 的 'FUNIT-prod' vault、entry name='wp-vin'",
  "metadata": { "allow_secret_like": true }
}
```

**THEN**

- 回應 201
- `memories.metadata.lint_warnings` 含一筆：
  ```json
  { "type": "bypass_secret_detect", "ts": "<ISO timestamp>" }
  ```
- 即使 content 命中 keyword "password"（標題出現）也照寫
- admin UI 列表頁顯示警告徽章「⚠️ 跳過敏感偵測」

---

## 場景 7：PUT（update）也走相同 detector

**GIVEN**

- 既有記憶 id=200、type=`reference`、content=「研究 OAuth 流程」
- API server 已部署 v1.19.1

**WHEN**

```http
PUT /api/memory/200
{
  "content": "client_secret: sk-proj-1234567890abcdefghij1234567890",
  "update_reason": "補上實際密鑰"
}
```

**THEN**

- 回應 **400**、`detected_by: "regex:openai_api_key"`
- 既有 id=200 的 content **沒被改動**（仍為「研究 OAuth 流程」）
- 不寫 history（因為 update 失敗）

---

## 場景 8：MCP 工具描述含警語

**GIVEN**

- AI 透過 OwnMind MCP 連線、查可用工具

**WHEN**

- AI 呼叫 `tools/list`

**THEN**

- `ownmind_save` 的 description 開頭含「⚠️ 含密碼／token／API key 請改用 `ownmind_set_secret`，不要寫進記憶」
- `ownmind_update` 同上
- `ownmind_set_secret` 的 description 不變
- AI 在挑工具前就讀到警語、優先選對工具

---

## 場景 9：500 → 4xx 改造（validation error）

**GIVEN**

- API server 已部署 v1.19.1

**WHEN**

```http
PUT /api/memory/123
{ "tier": "invalid_value" }
```

**THEN**

- 回應 **400**（之前是「驗證早返回」、本來就是 400；本場景驗證 catch-all 改造**不退化**）
- 既有的 tier validation 400 行為維持

---

## 場景 10：500 → 4xx 改造（內部 DB error）

**GIVEN**

- API server 已部署 v1.19.1
- DB 暫時掛掉、PUT 觸發 query 拋 `DatabaseConnectionError`

**WHEN**

```http
PUT /api/memory/123
{ "content": "正常內容", "update_reason": "正常更新" }
```

**THEN**

- 回應 **500** + body `{ "error": "更新記憶失敗" }`
- server log 寫 error.stack（便於除錯）
- **不退化**到把 DB 錯誤誤判為 400

---

## 場景 11：500 → 4xx 改造（auth error）

**GIVEN**

- API server 已部署 v1.19.1
- 使用者試圖修改不屬於自己的記憶 id=999

**WHEN**

```http
PUT /api/memory/999
{ "content": "...", "update_reason": "..." }
```

**THEN**

- 回應 **404 「找不到該記憶」**（既有行為、本提案不動）
- 或 403（若是 team_standard 非 admin）（既有行為、本提案不動）
- 本提案的 catch-all 改造不影響這兩個既有的 early-return 路徑

---

## 場景 12：新鐵律生效

**GIVEN**

- v1.19.1 已部署
- 新鐵律「敏感資料一律走 ownmind_set_secret、不寫進 memory／對話／commit」已透過 admin UI 建立、`tier='critical'`

**WHEN**

- AI 在新 session 啟動、SessionStart hook 跑 `ownmind_init`

**THEN**

- 鐵律出現在 Critical 分組底下
- 含明確觸發場景描述、IR-002 的延伸關係
- AI 後續呼叫 `ownmind_save`/`update` 試圖寫密碼時、被 server 擋下、同時鐵律提醒它走 `ownmind_set_secret`

---

## 場景 13：偵測規則對 secret API 本身不生效

**GIVEN**

- API server 已部署 v1.19.1

**WHEN**

```http
POST /api/secret
{
  "key": "gofunit_wp_app_password",
  "value": "iXEN ops5 pJcy 8PJI lVFM heaH"
}
```

**THEN**

- 回應 200
- secret 正常存入
- detector **不適用** `/api/secret` 路由（這就是「正確的工具」、本來就是用來存敏感資料的）

---

## 非場景（明確不做）

- ❌ **AI 回話偵測**：reply-lint 掃 AI 回應含密碼——v1.19.2 另開
- ❌ **既有記憶 DB scan**：找出已經寫進去的密碼並 redact——v1.19.2 處理
- ❌ **加密儲存**：secret API 仍走既有儲存路徑（明文+RLS）——加密是另一個專案
- ❌ **Detector 100% 完美**：本提案接受 false negative；目標是「本次事件不重演 + 大多數常見格式擋下」
