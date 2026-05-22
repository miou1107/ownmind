# v1.19.3 — Reply-lint Progressive Block 任務清單

> 依 IR-003（TDD）：每個實作 task 前面先寫測試
> 依 IR-012（品管三步驟）：驗證 → 請評審 → 處理回饋
> 依 IR-008（commit 同步更新 README/FILELIST/CHANGELOG）

---

## 階段 A：language-lint.js 擴白名單 + threshold + proper noun + 視窗

- [ ] A1. 寫測試（場景 9 / 10 / 11 / 12 / 13）
  - Top 30 違規詞全部進白名單後不再觸發
  - Proper noun pattern 跳過
  - 含 code block → threshold 25%
  - 含 code review → 完全豁免
  - IR-036 視窗 80 字
- [ ] A2. 改 `shared/language-lint.js`
  - `TECH_WHITELIST` 從 80 詞擴到 200+ 詞（分 5 類加註）
  - `checkMixedLanguage(content, options)`：偵測 code block / code review、動態 threshold
  - `looksLikeProperNoun(word)` 純函式
  - `checkJargonExplanation`：窗口 50→80

---

## 階段 B：Session counter 純函式

- [ ] B1. 寫測試 `tests/session-counter.test.js`（場景 7 / 8 / 14）
  - 檔不存在 → 視為 0
  - 檔毀損 → 視為 0、覆寫
  - 30 天前自掃
  - increment / read / write
- [ ] B2. 新檔 `hooks/lib/session-counter.js`
  - `readCounter(sessionId)`
  - `incrementCounter(sessionId)`
  - `cleanupStale(maxAgeMs)`

---

## 階段 C：Hook 整合 MODE + 漸進 block

- [ ] C1. 寫測試 `tests/reply-lint-hook.test.js` 補新 case（場景 1 ~ 6 + 15）
  - 改既有 14+ status===0 斷言：依 MODE 分流
  - MODE=warn 行為不變
  - MODE=block 第 1/2/3 次不 block、第 4 次 block JSON
  - MODE=block stop_hook_active=true 不增計數
  - MODE=disable 完全跳過
  - MODE 未知值 fallback warn
  - reason 為指令型、含具體詞、含改寫範例
- [ ] C2. 改 `hooks/ownmind-reply-lint.js`
  - 新增 `OWNMIND_REPLY_LINT_MODE` env 讀取
  - 違規時呼叫 `incrementCounter` 拿新計數
  - 計數 < 4：原本 banner + spool + POST + exit 0
  - 計數 ≥ 4 && MODE=block：寫 stdout block JSON + banner（含 ⚠️ 標記）+ spool + POST + exit 0
  - 新增 `formatBlockReason(violations)` 指令型格式
  - Banner 多一行「目前 session 違規 N 次、累積 4 次會 block」

---

## 階段 D：端對端驗證

- [ ] D1. 本機 install 新版 hook、開個 Claude session、手動回個明顯違規的話、看 banner 行為
- [ ] D2. 切 `OWNMIND_REPLY_LINT_MODE=block`、連續違規 4 次、實測 block JSON 觸發 + Claude 收到 reason 後重寫
- [ ] D3. 確認 stop_hook_active 防呆生效（不會跑 8 次連續 block 才停）
- [ ] D4. 跑 npm test 全測試、確認既有 case + 新 case 全綠

---

## 階段 E：文件同步（IR-008 + IR-026 + IR-032）

- [ ] E1. `README.md` Reply Lint 段：新增 MODE 說明 + 漸進式 block 流程
- [ ] E2. `docs/README.zh-TW.md`、`docs/README.ja.md` 同步
- [ ] E3. `CHANGELOG.md` 加 v1.19.3 條目
- [ ] E4. `FILELIST.md` 加 session-counter.js + 新測試檔

---

## 階段 F：版號 + commit + tag + push（client-side、不用 deploy server）

- [ ] F1. `package.json` v1.19.3（SERVER_VERSION 動態讀、不用改）
- [ ] F2. 品管三步驟（IR-012）：verification → request review → handle review
- [ ] F3. Commit（IR-009 Vin contributor + IR-024 no Co-Authored-By）
- [ ] F4. Tag v1.19.3 + push origin main + tag

---

## 階段 G：跑 1 週 audit + 決定是否翻 block 預設

- [ ] G1. 本機 update OwnMind 到 v1.19.3、保持 `MODE=warn` 預設（不改 env）
- [ ] G2. 跑 1 週、紀錄違規數變化（擴白名單後應大幅下降）
- [ ] G3. 評估是否：a) 翻 block 預設、b) 再縮白名單、c) 維持現狀
- [ ] G4. （後續版本）archive openspec change 資料夾
