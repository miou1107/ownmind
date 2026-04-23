# Design: 新用戶自動 Onboarding

**Date:** 2026-04-23
**Status:** Approved

---

## 問題

新用戶安裝 OwnMind 後，第一次呼叫 `ownmind_init` 時 profile/principles/iron_rules 全為空，API 只回傳版本資訊，沒有任何引導。使用者不知道下一步該做什麼。

---

## 目標

- 偵測到新用戶（profile=null + principles=[] + iron_rules=[]）時，自動啟動 onboarding 引導
- AI 主動問「名字 + 工作」，使用工具從 header 自動帶入，不需用戶回答
- 收集後呼叫 `ownmind_save` 建立 profile 記憶

---

## 設計

### 新用戶判斷條件

同時滿足以下三項：
- `profile === null`
- `principles.length === 0`
- `ironRules.length === 0`

---

### 變更一：MCP callApi 加入 `x-ownmind-tool` header

**File:** `mcp/index.js`

`callApi` 函式發送請求時，加入：
```
x-ownmind-tool: claude-code
```

固定字串，因為此 MCP 只服務 Claude Code。未來若有多 client 可改為 env var `OWNMIND_CLIENT_TOOL`（預設 `claude-code`）。

---

### 變更二：Server 偵測新用戶並回傳 `_onboarding`

**File:** `src/routes/memory.js`，在現有 `/api/memory/init` handler 的 `res.json(...)` 之前加入：

```js
const detectedTool = req.headers['x-ownmind-tool'] || 'AI 工具';
const isNewUser = !profile && principles.length === 0 && ironRules.length === 0;
const onboarding = isNewUser ? {
  is_new_user: true,
  detected_tool: detectedTool,
  question: '你好！我是 OwnMind，你的個人 AI 記憶系統。請問你叫什麼名字，主要做什麼工作？'
} : null;
```

在 `res.json(...)` 中加入 `_onboarding: onboarding`。

---

### 變更三：MCP handler 注入強制 onboarding 指令

**File:** `mcp/index.js`，`ownmind_init` handler 中（line ~583），在 `return data` 之前加入：

```js
if (data._onboarding?.is_new_user) {
  data._onboarding_instruction =
    `【OwnMind 新用戶初始化】偵測到這是全新帳號，尚無任何記憶。` +
    `使用工具：${data._onboarding.detected_tool}（已自動記錄）。` +
    `請立即向使用者提問：「${data._onboarding.question}」` +
    `收到回答後，呼叫 ownmind_save 建立 type=profile 記憶，` +
    `content 包含：名字、工作、使用工具。完成後告知用戶記憶已建立。`;
}
```

---

### 變更四：`configs/CLAUDE.md` 新增 onboarding 規則

```markdown
## 新用戶 Onboarding 規則

當 ownmind_init 回傳包含 `_onboarding_instruction` 時，必須：
1. 立即向使用者提出問題（問題文字在 `_onboarding_instruction` 中）
2. 收到回答後呼叫 `ownmind_save` 建立 profile 記憶
3. 完成後確認「已建立你的 OwnMind 個人記憶」
不可跳過、不可等使用者主動詢問。
```

---

## 不在範圍內

- Principles / iron_rules onboarding（第一步只建 profile，其他讓用戶之後自行建立）
- 用戶拒絕回答的處理（視為正常互動，下次 init 仍會觸發）
- 多語系支援

---

## 測試驗證方式

1. 建立一個無 memories 的測試用戶
2. 呼叫 `ownmind_init`
3. 確認回應包含 `_onboarding.is_new_user: true` 和 `_onboarding_instruction`
4. 確認有 memories 的用戶不觸發（`_onboarding: null`）
