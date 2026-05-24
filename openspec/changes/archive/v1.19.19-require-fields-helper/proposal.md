# v1.19.19 — 全站 requireFields helper（API 必填欄位錯誤訊息可偵錯化）

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: 動工中
- **預估版次**: v1.19.19（內部重構 + DX 改善、patch 級）

---

## 0. 一句話總結

把全站 6 個 endpoint 各自手寫的「必填欄位：x, y, z」400 樣板抽成共用 `requireFields()` helper、回的錯誤 payload 含 `missing` / `received` / `expected`、AI 跟其他客戶端踩到時能立刻知道哪邊掉了。

---

## 1. 設計緣由

### 1.1 v1.19.18 release 後的踩坑

v1.19.18 release 完想跑 `ownmind_log_session` 記錄、connect 兩次都收到：

```
API 400: 必填欄位：tool, model, summary
```

但實際傳了三個欄位。debug 後發現是 AI 寫 tool call 時把 `antml:parameter` 寫成 `parameter`（少了命名空間前綴）、MCP server 解析時只認得第一個欄位、其他三個被丟掉、client send 出去缺欄位的 body、server 正確回 400。

問題：**錯誤訊息無法 self-correct**。AI 看到「必填欄位：tool, model, summary」、會覺得「我明明三個都填了啊」、無從判斷是 args parse 階段就掉了、還是 transport 階段、還是 server 端的問題。

### 1.2 為什麼長久應該做、不是只 patch session.js 一個 endpoint

盤點全站、共有 **6 個 endpoint** 用同樣的「必填欄位：x, y, z」generic 樣板（[grep 結果](#42-涵蓋範圍盤點)）。每一個都會踩同樣的坑、AI 換到另一個 endpoint 又要重新猜。

長久解法：寫個 `requireFields()` helper、全站套用、錯誤格式統一、客戶端能可靠地解析跟回應。

### 1.3 為什麼選 server-side helper 而非 client-side schema validation

兩條腿都應該做（見 [§5 後續腿 B](#5-腿-b-mcp-客戶端-schema-pre-validation已記成-backlog)）。本版先做 server-side 因為：

- **影響面廣**：server-side fix 對所有客戶端都生效（MCP / admin UI / 第三方腳本）、不只 MCP
- **改動小**：6 個 endpoint 改一行、加一個共用 helper、~150 行
- **不依賴 client 升級**：客戶端 v1.19.x 都還在現場、不用所有人重新 update.sh
- **腿 B（MCP client schema validate）規模較大**：要動 MCP framework 跟 tool dispatch 層、估 3-5 天、先列 backlog

---

## 2. 設計

### 2.1 Helper 簽名

```js
// src/utils/require-fields.js
export function requireFields(body, required, options = {}) {
  const received = body || {};
  const missing = required.filter(f => {
    const v = received[f];
    return v === undefined || v === null || v === '';
  });

  if (missing.length === 0) return null; // 通過

  return {
    error: '必填欄位缺少',
    missing,
    expected: required,
    received: redactSensitive(received, options.sensitiveKeys),
  };
}
```

### 2.2 Endpoint 用法

舊：

```js
const { tool, model, summary } = req.body;
if (!tool || !model || !summary) {
  return res.status(400).json({ error: '必填欄位：tool, model, summary' });
}
```

新：

```js
const validation = requireFields(req.body, ['tool', 'model', 'summary']);
if (validation) return res.status(400).json(validation);
const { tool, model, summary } = req.body;
```

### 2.3 錯誤 payload 範例

舊（前一版）：
```json
{ "error": "必填欄位：tool, model, summary" }
```

新（v1.19.19）：
```json
{
  "error": "必填欄位缺少",
  "missing": ["tool", "model"],
  "expected": ["tool", "model", "summary"],
  "received": { "summary": "test summary" }
}
```

AI / 客戶端看到 `missing` + `received` 就立刻知道：
- 我傳了 summary、但 tool / model 不見了
- → args parse 階段就掉了、不是 server 端 bug

### 2.4 安全：received 自動遮蔽敏感欄位

`received` 中的 password / token / api_key / secret 等欄位自動遮蔽成 `<REDACTED>`、避免錯誤回應洩漏敏感資料。`options.sensitiveKeys` 可加客製欄位。

---

## 3. 涵蓋範圍盤點

### 3.1 要移植的 6 個 endpoint

| 檔案 | 行 | 必填欄位 |
|---|---|---|
| `src/routes/session.js` | 44 | tool, model, summary |
| `src/routes/admin.js` | 147 | email |
| `src/routes/handoff.js` | 17 | project, from_tool, from_model, content |
| `src/routes/memory.js` | 899 | type, title, content |
| `src/routes/memory.js` | 1688 | parent_title, chunks (array) |
| `src/routes/secret.js` | 79 | key, value（**敏感**、value 要遮蔽） |

### 3.2 已有部分 self-correct 但格式不一致的

| 檔案 | 行 | 現況 |
|---|---|---|
| `src/routes/usage/pricing.js` | 62 | 用 `必填欄位缺少：${missing.join(',')}` — 已說缺哪個、但格式 unstructured、本版統一過去 |

### 3.3 範圍外（本版不動）

- 約 80 個其他 400 回應（業務邏輯各自 inline、不是必填欄位 generic 樣板）
- MCP client-side schema pre-validation（→ backlog 腿 B）
- 既有客戶端對舊錯誤格式的解析（**Breaking change 評估**：MCP client / admin UI 都只看 res.ok 跟 res.status、不解析錯誤 payload 內容、本版屬於 **backward-compatible 強化**、不會打破現有 client）

---

## 4. 工作量

| 項目 | 行數 |
|---|---|
| `src/utils/require-fields.js`（含 sensitive key 遮蔽） | 50 |
| `tests/require-fields.test.js`（unit tests、~10 cases） | 100 |
| 6 個 endpoint 移植（每個 ~3 行 diff） | 18 |
| pricing.js 統一過去（順手） | 5 |
| reproduction test：session.js 缺欄位回新格式 | 30 |
| 版號 + CHANGELOG + FILELIST + 三語系 README | 50 |
| **總計** | 約 250 行 |

工程時間：約 1-2 小時（含部署 + 驗證）。

---

## 5. 腿 B（MCP 客戶端 schema pre-validation）已記成 backlog

本版只做腿 A（server-side helper）。腿 B（MCP client 用 inputSchema 強制 validate args、缺欄位直接 client-side throw）規模較大、列為獨立 backlog 項目：

- 觸發信號：v1.19.19 release 後追蹤 generic 400 是否仍頻繁發生；若 AI 仍頻繁踩到（即使新訊息已含 missing），就動工腿 B
- 估時：3-5 天
- 範圍：mcp/index.js 的 dispatch 層加 schema validator、所有 tool call 進入 case 前驗、缺則 throw 含 args dump

→ 寫入 OwnMind project 記憶（待辦清單偏好慣例）。

---

## 6. 風險檢查點

- [ ] `requireFields()` 對 `body=null` / `body=undefined` 安全處理（不會 throw）
- [ ] 對 `body={}` 回所有 missing
- [ ] 對 array required 欄位（如 chunks）正確驗（陣列空字串、空陣列怎麼判？）
- [ ] `secret.js` 的 value 在 received 中被遮蔽（**最關鍵的安全檢查**）
- [ ] 全套既有 1827 個測試綠
- [ ] 新增 unit tests + reproduction test 綠
- [ ] 部署後 MCP `ownmind_log_session` 用缺欄位的 body 打去、回新格式（含 missing/received/expected）
- [ ] 部署後 admin UI 既有功能不受影響（用 admin UI 跑一次新增記憶、看不會壞）
- [ ] 三語系版號 1.19.19
