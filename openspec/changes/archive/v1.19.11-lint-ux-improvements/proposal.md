# v1.19.11 — Lint UX 改善：誤判降低 + 雙顯示原因標註 + 自學資料根基

## 背景

v1.19.7-10 落地後、Vin 在使用中發現三個體驗問題：

### 問題 1：寫專案紀憶時容易誤觸關鍵字偵測

v1.19.1 引入的 `detectSecretLike` 偵測器、會用子字串比對抓 `password`、`token`、`secret`、`credential` 等英文敏感詞。

但寫 type=project 的記憶時、本來就會大量引用：
- 程式碼檔名（`random-password.js`、`admin-password-reset.js`）
- 內部規格資料夾名（`v1.19.9-password-recovery`、`v1.19.10-credential-hygiene`）
- 資料庫欄位名（`must_change_password`、`api_key`）

這些都會觸發偵測器、寫入被擋下、強迫使用者迂迴改寫。

### 問題 2：擋下後 AI 重寫、使用者看到兩段相似內容、不知道為什麼

reply-lint hook 違規累積到第 4 次後 `process.exit(2)`、Claude 收到 stderr 重寫指令直接寫新版本、不會自我標註「我剛被擋下」。

使用者體驗：兩段相似內容、感覺 AI 在重複自己。

### 問題 3：被擋下的事件沒結構化紀錄

目前事件靠 `~/.ownmind/logs/YYYY-MM-DD.jsonl` 寫合規事件、但結構為「給 server 收的合規回報」、不是「給使用者查的擋下紀錄」。

沒有結構化紀錄就：
- 沒法統計「我這週被擋幾次、最常違反哪條」
- 沒法自動建議「某條規則誤判率高、要不要調整」
- 後台儀表板資料來源不完整

## 改善範圍

### 1. 誤判降低（方案 A）

`src/routes/memory.js` 寫入流程中、把 `skip_keyword: true` 的適用類型從現有的 `iron_rule` / `principle` 擴大到所有敘述型類型：

- `iron_rule`、`principle`（既有）
- `coding_standard`、`team_standard`（新加）
- `project`、`portfolio`、`session_log`（新加）

樣式比對（regex）跟長度啟發式仍跑、可擋真正高風險樣式（WordPress、JWT、GitHub PAT、AWS、OpenAI 金鑰）。

### 2. AI 自我標註（軟性提示、盡力做到）

改 `hooks/ownmind-reply-lint.js` 的 `formatBlockReason`、指令文字加「重寫時開頭必須加引述標註」要求：

```markdown
> ⚠️ **上一版違反 IR-036（行話沒附白話）、重新調整：**
> 沒附白話的詞：routes, password

---

[新回應內容]
```

不驗證 AI 是否照做（接受 85% 服從率）。失效時靠紀錄保底。

### 3. 分級顯示（避免使用者疲勞）

| 第 N 次擋下 | 指令文字內容 |
|---|---|
| 第 1 次 | 完整標註：違規規則 + 違規詞清單 + 改寫提示 |
| 第 2-3 次 | 一行簡訊：「↻ 上版違反 IR-036、已重寫」 |
| 第 4 次（達 downgrade limit） | 完整警示 + 降警告提示 |

需要 hook 知道「這是本 session 第幾次擋下」、用既有的 `session-counter.js` 的 `block_count` 欄位（v1.19.7 引入）。

### 4. 結構化擋下紀錄（log 保底 + 自學根基）

新增 `~/.ownmind/logs/reply-lint-events.jsonl`、每筆擋下事件寫一行：

```json
{
  "ts": "2026-05-22T14:25:33.000Z",
  "session_id": "abc123",
  "event": "blocked",
  "rule_codes": ["IR-036", "IR-037"],
  "violated_words": {
    "ir036_jargon": ["routes", "password"],
    "ir037_mixed": ["refactor", "codebase"]
  },
  "violation_count_in_session": 4,
  "block_count_in_session": 1,
  "downgraded_to_warning": false,
  "ai_instructed_to_annotate": true
}
```

這份紀錄為下列功能鋪路（v1.20+）：

- 個人統計：「我這週被擋幾次、最常違反哪條」
- 誤判建議：「IR-XXX 被擋 50 次、其中 80% 使用者立刻 bypass」
- 規則優化：「某詞重複被擋、要不要加白名單」
- 跨工具連續紀錄：所有 OwnMind 客戶端共用同一份紀錄

## 不做的事

- ❌ 自動套用優化建議（v2.0 才做、現階段只記錄、不主動改規則）
- ❌ 機器學習誤判辨識（資料量不夠、留 v2.0+）
- ❌ 強制 AI 標註（沒做到接受、不打仗）
- ❌ 動到既有合規事件 jsonl（保持向後相容）

## 工作量估計

| 項目 | 行數 |
|---|---|
| 方案 A（src/routes/memory.js 改 skip_keyword 範圍） | 5 行 |
| AI 自我標註指令改寫 | 20 行 |
| 分級顯示邏輯 | 30 行 |
| 結構化擋下紀錄 | 50 行（新檔 + 整合） |
| 既有測試對齊 | 30 行修改 |
| 新測試（分級、紀錄、誤判降低） | 80 行 |
| 三語系 README + CHANGELOG + FILELIST | 200 行 |
| openspec | 200 行 |
| **總計** | 約 620 行 |

工程時間：約 3 小時（含測試 + 跑全套 + commit）。

## 風險檢查點

- [ ] `npm test` 全套綠（v1.19.10 之後新增 case）
- [ ] 方案 A：寫一筆 project 記憶含 `random-password.js` 字串、確認不被擋
- [ ] AI 標註：跑 dogfood、看實際 Claude 重寫是否照標註格式
- [ ] 分級顯示：連續觸發 4 次、確認第 1 / 第 2-3 / 第 4 次顯示樣式不同
- [ ] log 保底：擋下事件後檢查 `reply-lint-events.jsonl` 有新紀錄
- [ ] 既有 reply-lint test 不破壞（v1.19.3 / v1.19.7 既有 case 都該繼續綠）
