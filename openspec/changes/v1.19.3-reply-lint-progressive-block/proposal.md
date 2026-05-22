# v1.19.3 — Reply-lint 漸進式 block + 白名單擴充 + threshold 分情境

- **Author**: Vin
- **Date**: 2026-05-22
- **Status**: 動工中
- **Worktree**: 無（main、改動可控）
- **Branch**: `main`

---

## 0. 一句話總結

reply-lint hook（IR-037 中英混雜 / IR-036 行話沒解釋）從「只警告」升級成「漸進式卡控」：前 2 次警告、第 3 次預告、第 4 次 block + 要求 Claude 重寫。同時根據 30 天 audit 數據擴白名單到 200+ 詞、threshold 分情境（純對話 15%、含 code 25%、純 code review 豁免）、加 `OWNMIND_REPLY_LINT_MODE` opt-in。對應 IR-027「邏輯才有效」。

> 白話：以前提醒沒用、Claude 看不到也不會改。現在違規累積到一定次數會被擋下、Claude 收到指令重寫。但先給緩衝（避免第一次誤判就毀對話）+ 預設 warn（要 user 主動 opt-in 才開 block）。

---

## 1. 設計緣由

### 1.1 真實事件（持續性）

OwnMind 在 SessionStart hook 帶 5 條「強制注意」、其中 3 條（IR-037 100%、IR-036 100%、解說偏好 100%）對當前 AI 違反率 100%——警告對 AI 完全無效、user 看到警告也只能下次注意。

### 1.2 為什麼這是 IR-027 的典型失效

IR-027「邏輯才有效」的同款情境：reply-lint 偵測到了、寫了 banner、AI 一無所知（hook 故意不寫 stdout 避免被 AI 通道吃）。產生了「規範了卻沒落地」的純擺設。

要破這個局：把 banner 從「事後通知 user」升級成「事前卡控 + 餵 Claude 重寫指令」。

### 1.3 為什麼是 v1.19.3 + 漸進式 + opt-in（不是直接 block 預設）

**Codex 對抗審查發現 3 大破口、修正後的方案**：

1. **誤判率高**：30 天 audit 顯示 Top 30 違規詞 80% 是「專案名 / 大公司名 / 標準技術詞」而非真正行話。直接上 block 會誤殺正常對話
2. **stop_hook_active 防呆不夠**：原本以為「Claude 重寫又違規就被防呆放行」、實際是「stop_hook_active 只防同一個 Stop 事件內遞迴、不防 Claude 重寫後又違規」
3. **跨工具相容性**：Stop hook 只在 Claude Code 跑、Codex / Cursor / Antigravity 都不會觸發。Block 模式會給「全 AI 都卡控」的錯覺、實際只擋 1 家

**Codex 實證 Claude Code Stop hook spec 後**：
- 確認 `{decision:'block', reason}` JSON 寫 stdout 是標準作法
- 確認 Claude Code 內建 **8 次連續 block 上限**自動防無限迴圈
- 確認 reason 被當「下一個 prompt」餵 Claude→ reason 要寫**指令型**（「請重寫」）而非**報告型**（「你違反了」）

---

## 2. 設計方案

### 2.1 漸進式 block（mode=block 時的累積行為）

session 內維護違規計數、每次違規加 1：

| 計數 | 行為 |
|---|---|
| 1 | 寫 tty banner、寫 compliance event、**不 block**（給第一次誤判緩衝）|
| 2 | 寫 tty banner、寫 compliance event、**不 block** |
| 3 | 寫 tty banner（含「下次違規會 block」預告）、寫 compliance event、**不 block** |
| 4+ | 寫 tty banner、寫 compliance event、**輸出 block JSON 到 stdout**、Claude 收到重寫指令 |

計數存在 `~/.ownmind/logs/reply-lint-session-counter.json`：
```json
{
  "<session_id>": {
    "count": 3,
    "last_violation_ts": "2026-05-22T12:00:00Z",
    "started_at": "2026-05-22T11:30:00Z"
  }
}
```
- session_id 從 Stop hook stdin 取得
- 30 天前的 session 自動清掉（runner 自掃）

### 2.2 三種 MODE（OWNMIND_REPLY_LINT_MODE 環境變數）

| MODE | 行為 |
|---|---|
| `warn`（預設） | 完全照舊：只寫 tty banner + compliance event、永遠不 block |
| `block` | 漸進式：計數 < 4 同 warn、計數 ≥ 4 寫 block JSON |
| `disable` | 完全跳過 lint（=OWNMIND_REPLY_LINT_DISABLE=1 的等效） |

不在白名單的值預設當 `warn` 處理（fail-open）。

### 2.3 Block reason 寫成指令型

Codex 警告：reason 是「下一個 prompt」、不是「修正指令」。所以：

❌ 不能寫：「你違反 IR-037、比例 32%、找到 5 個英文詞」
✅ 要寫：「請重寫剛才那則回應、用白話中文、把英文技術詞用括號附中文解釋」

實際格式：
```
請重寫你剛才的回應、改善以下品質問題（不改變原意、只改語言風格）：

1. 用白話中文取代以下英文詞（或在第一次出現時用括號附中文解釋）：
   {問題詞列表}

2. 對「{行話詞}」這類技術詞、第一次出現時要附白話說明、例如：
   - hook（攔截器、特定時機自動跑的小程式）
   - middleware（中間處理層）
   - 用「：」「（）」「即...」「也就是」等格式

如果你判斷上述詞已經有相關上下文、或屬於變數名 / 函式名等程式碼引用、可以保留不改。重寫時請回到原本的對話脈絡、不要重新確認問題、直接給新答案。
```

### 2.4 白名單擴充（基於 30 天 audit）

從 80 詞擴到 ~200 詞、分類：

**新增類別 A：大公司 / 大平台名（不是行話）**
Google, Meta, OpenAI, Chrome, OAuth, YouTube, Podcast, Imagen, Llama, Perplexity, Remotion, Evernote, Sheets, GitHub Actions, Jenkins...（35+ 詞）

**新增類別 B：Vin 個人專案名**
adog, fapa, fontrip, ring, ownmind, vincent...（10+ 詞）

**新增類別 C：Git / 開發流程詞**
main, origin, branch, worktree, commits, rebase, merge, conflict, stash, cherry-pick, hook, Hook, review, reviewer, prod, staging, spec, prompt, tasks, task, tests, pipeline, Pipeline, Stage, stage, chunk, monorepo, redirect, apply, archive, container, fresh, trigger, success, container, render, retry, batch, topic, server, handoff, project, brand, plan, publish, Research, Notes, redirect, payload, handler, router, service, factory, singleton, instance, function, class, interface, schema, array, string, boolean, number, error, exception, timeout...（80+ 詞）

**新增類別 D：常見技術概念**
async, await, callback, promise, middleware, endpoint, dispatcher, websocket, sse, polling, throttle, debounce, cache, queue, lock, mutex...（25+ 詞）

### 2.5 Threshold 分情境

`checkMixedLanguage(content, options)` 行為：

```js
const hasCodeBlock = /```|`[^`]+`/.test(content);
const isCodeReview = /code review|code-review/.test(content);

let threshold = 0.15;
if (isCodeReview) {
  return { ok: true, ratio: 0, mixedWords: [] }; // 豁免
}
if (hasCodeBlock) {
  threshold = 0.25;
}
```

### 2.6 IR-036 視窗從 50 字擴到 80 字

Codex 指出：中文語境 50 字符約等於 25 中文字、解釋常常在括號外又被切掉。改 80 字符讓緊接的補充能被抓到。

### 2.7 Proper noun 偵測（大寫開頭孤立詞）

新增規則：詞首大寫（capitalize first letter）且符合英文姓氏 / 公司名常見 pattern 的、視為 proper noun、不算違規：

```js
function looksLikeProperNoun(word) {
  return /^[A-Z][a-z]+$/.test(word);  // 例：Google, Eric, Phoebe
}
```

注意：全大寫詞（AWS, IDE）已在白名單。

---

## 3. 範圍 vs 不範圍

### 3.1 範圍內

- ✅ `shared/language-lint.js`：擴白名單到 200+ 詞、threshold 分情境、IR-036 視窗 80 字、proper noun 偵測
- ✅ `hooks/ownmind-reply-lint.js`：加 `OWNMIND_REPLY_LINT_MODE` env、漸進式計數、session counter 持久化、block JSON 輸出
- ✅ 新增 `hooks/lib/session-counter.js`：純函式、計數讀寫 + 自掃 30 天前 session
- ✅ 改測試 + 新增 mode / counter / block 測試
- ✅ Banner 加「目前計數 / 距 block 還幾次」資訊
- ✅ 文件三件套同步（IR-008 + IR-026 + IR-032）
- ✅ 版號 v1.19.3（IR-031）

### 3.2 不範圍

- ❌ 跨工具相容（Codex / Cursor 等的 hook 機制不同、留下個版本）
- ❌ Pre-tool hook 替代方案（架構翻修、本版只動 Stop hook）
- ❌ session 計數寫進 DB（純檔案夠用、避免依賴 server）
- ❌ Admin UI 顯示 lint 觸發歷史（已有 activity log、足夠）

---

## 4. 影響範圍

| 檔案 | 改動 |
|------|------|
| `shared/language-lint.js` | 擴白名單、threshold 分情境、視窗 80、proper noun 偵測 |
| `hooks/ownmind-reply-lint.js` | MODE env、漸進計數、block JSON、reason 指令型 |
| `hooks/lib/session-counter.js` | **新檔** — 純函式 session 計數讀寫 + 自掃 |
| `tests/language-lint.test.js`（如果已存在）/ 新檔 | 白名單、threshold、proper noun 測試 |
| `tests/reply-lint-hook.test.js` | 14+ 處 status===0 改成 mode-aware；新增 block / counter / no-loop 測試 |
| `tests/session-counter.test.js` | **新檔** — counter 純函式測試 |
| README / docs/zh-TW / docs/ja | Reply Lint 段加「漸進式 block + MODE」 |
| CHANGELOG / FILELIST | v1.19.3 條目 |
| package.json | v1.19.3 |

---

## 5. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|------|------|------|------|
| 白名單擴 200 詞、漏抓真正行話 | 中 | 中 | 預設 warn、跑 1 週看 audit 再決定要不要再縮白名單 |
| Session counter 檔毀損 | 低 | 小 | try/catch 包、毀損視為計數歸零、不影響其他流程 |
| Claude 重寫品質差 / 死循環 | 低 | 中 | Claude Code 內建 8 次連續 block 上限；reason 指令型寫法降低品質風險 |
| User opt-in block 後體驗差 | 中 | 中 | 預設 warn、要 user 自己改 env 才開 block、退場成本零 |
| 跨機器 session counter 不一致 | 中 | 低 | counter 是 per-machine、不需要跨機同步、合理 |

---

## 6. 拍板紀錄

| # | 議題 | 待拍板選項 | Vin 拍板 |
|---|------|-----------|----------|
| 1 | 漸進式門檻 | A. 2/3/4（建議）/ B. 1/2/3 / C. 3/5/7 | A |
| 2 | 預設 MODE | A. warn opt-in block（建議）/ B. block 直上 | A |
| 3 | session counter 存放 | A. ~/.ownmind/logs/json 檔（建議）/ B. SQLite / C. DB | A |
| 4 | proper noun 偵測 | A. `^[A-Z][a-z]+$` 簡單規則（建議）/ B. 不做 | A |
| 5 | reason 風格 | A. 指令型（建議）/ B. 報告型 | A |

---

## 7. 下一步

1. ✅ Audit 30 天 log + Codex 對抗審查 + 實證 hook spec（已完成）
2. ⏳ 寫 `spec.md` + `tasks.md`
3. ⏳ 走 TDD：先寫測試、跑紅、實作、跑綠
4. ⏳ Local install + dogfooding 確認不誤殺
5. ⏳ 文件三件套同步
6. ⏳ Commit + tag v1.19.3 + push（client-side hook、不用 deploy server）
7. ⏳ 跑 1 週 warn 模式 audit、確認誤判率降到可接受才考慮翻 block 預設
