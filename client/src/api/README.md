# client/src/api/ — 前端 API 客戶端

統一封裝對後端 Express API 的呼叫，讓頁面元件不用自己處理 fetch、header、錯誤格式。

## 檔案

| File | 責任 |
|---|---|
| `auth.js` | localStorage 存取 `api_key`（get / set / clear） |
| `client.js` | fetch 封裝：自動帶 Bearer header、統一回傳 shape、401 自動清 token |
| `index.js` | barrel export |

## 回傳格式

所有請求都回相同 shape：

```js
{ ok: boolean, data?: any, error?: string, status: number }
```

- `ok=true`：HTTP 2xx，`data` 是 response JSON
- `ok=false`：HTTP 4xx/5xx 或網路錯，`error` 是訊息（優先取後端 `{ error: '...' }`，fallback `statusText`）
- 401 例外：自動 `clearApiKey()`，error 固定 `'unauthorized'`

## 用法

> 註：vite.config.js 目前沒設 `@` alias、所有引用走相對路徑。

```jsx
import { apiGet, apiPost, setApiKey } from '../api';

// 登入（不帶 Bearer）
const { ok, data, error } = await apiPost('/api/me/login', { email, password });
if (ok) {
  setApiKey(data.api_key);
} else {
  setErrorMsg(error);
}

// 後續請求（自動帶 Bearer）
const r = await apiGet('/api/me/profile');
```

## 設計取捨

- **不用 axios**：fetch 已夠用、bundle 小、零依賴
- **401 不自動 redirect**：交給 RequireAuth route guard（待 3.10 實作）— 避免 redirect 邏輯散落
- **無自動 retry**：用戶失敗就失敗，避免重複扣 API quota / 寫入兩次
- **`credentials: 'same-origin'`**：dashboard 跟 API 同 host，不需要跨域 cookie
