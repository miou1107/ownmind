# OwnMind Dev Repo — AI 工作指引

此檔案是 OwnMind 本身開發時的 AI 行為規則。OwnMind 使用者的 CLAUDE.md / AGENTS.md 範本在 `configs/`、不要混淆。

## 產品設計最高理念（凌駕本檔所有其他規則，2026-08-13 Vin 拍板）

**規範的讀者是 AI，不是人。使用者把「要盯 AI 的事」寫一次，之後由系統來盯，人不再重複提醒。**

設計任何功能時的推論：

1. 庫裡每一條規範預設都要被**強制執行**，差別只在手段：擋得住動作的擋動作（hook 硬擋）、驗得了讀取的驗讀取（讀取回執）、需判斷語意的上語意查核（LLM 比對全文）。
2. 「提醒」只是機率，不算執行。列標題給 AI 看不等於 AI 讀了。任何新功能若只做到提醒，必須明說它是機率性的，不得宣稱「這樣 AI 就會遵守」。
3. 「留紀錄供事後查」只是過渡，不是任何規範的終點。
4. 「AI 沒讀／沒遵守已存規範」的事故＝產品存在理由的失敗，修它優先級最高。

起源：2026-08-13 FAPA 搬遷規劃事故（規範已送達 AI 仍違反），詳見 OwnMind 記憶 principle id=904。

## 使用者看得到的每一句話怎麼寫（2026-08-15 Vin 拍板，v1.30.1 全面重寫 24 句）

適用範圍：`hooks/locales/*.json`、hook 終端機訊息、CLI 輸出、伺服器錯誤訊息、後台文案 ——
**任何使用者會讀到的字**。內部給 AI 讀的 `reason`、日誌、稽核紀錄不在此列。

### 送出前的四道機械檢查

| # | 檢查 | 不過的例子 |
|---|---|---|
| 1 | **主詞是「你」或「AI」，不是機制** | ✗「合規檢查沒有執行」 ✓「OwnMind 沒有檢查 AI 這段回話」 |
| 2 | **動作要指名是誰做的**，不准無主詞被動句 | ✗「已經擋下來」「已經要它重寫」 ✓「OwnMind 擋下來了」「OwnMind 已經要 AI 重寫」 |
| 3 | **要講「所以呢」** —— 他要不要做什麼；不用做就明講不用 | ✗ 只說發生什麼事 ✓「AI 讀完再試一次就會過，你不用做什麼」 |
| 4 | **不准出現行話跟內部代號** | ✗ 合規、lint、回執、把關、憑證、同步、強制執行、模式、`unknown`、`timeout` |

### 狀態燈（三種，不准自己發明第四種）

| 燈 | 意思 | 判準 |
|---|---|---|
| 🟢 | **OwnMind 做到了它該做的事** | 擋下 AI、挑到違規、檢查過了。**擋住是綠燈 —— 擋住就是它在正常運作。** |
| 🟡 | 還在運作，但保護變弱、或該看一眼 | 只提醒不擋、重寫幾次放棄、確認不了 AI 有沒有讀規矩 |
| 🔴 | 沒運作 | 沒檢查到、連不上、沒登入、被關掉、設定錯 |

**不要用 ⛔。** 擋下 AI 不是使用者撞牆，紅色禁止標誌會讓「成功擋住」跟「整個壞掉」長得一樣。

### 為什麼寫成可以數的檢查項

2026-08-15 這批 24 句被連續退三次。前兩次我都只改了被點名的那一句，改完的新句子照樣
違反同一條原則 —— 因為我在**修舊句子的毛病**，而不是重問「他讀到這行要知道什麼、要做什麼」。
「寫得更好」不是規則，「看主詞，是機制就重寫」才是。

### 改動時的連帶責任

改一句 user-facing 訊息，這四個地方要一起動，漏一個就會在測試或下次翻譯時炸開：

1. `hooks/locales/zh.json`（**中文是原稿**，英日文由它產生）
2. `hooks/locales/en.json` + `en.override.json`（override 釘住英文，翻譯流程不准改寫）
3. `hooks/locales/ja.json` + `ja.override.json`
4. **程式碼裡那些寫死的英文備援 —— 有六個檔案，不是三個**：
   - `hooks/lib/action-gate.js`、`hooks/lib/compliance-step.js`、`hooks/ownmind-reply-lint.js`
     （`safeT` / `complianceNotice` / `lintNotice` 的第二個參數）
   - `hooks/lib/action-gate-cli.js`、`hooks/ownmind-iron-rule-check.js`、
     `hooks/ownmind-iron-rule-check.sh` —— **這三個最容易漏**。它們存的是
     `gate.failopen` / `gate.degraded`，而 `.sh` 那份跟 CLI 最外層那份根本不經過翻譯層
     （那條路是「node 整個跑不起來」，沒有 node 可以呼叫 `t()`）

   2026-08-15 這批 24 句就是漏了後面三個 —— 而且 `.sh` 裡本來就寫著「記得跟 en.json 同步」
   的註解、規格檔也記著「有三份複本」。**兩個都不是檢查，兩個都被讀過去了。**
   現在有 `tests/hook-english-fallbacks-match-dictionary.test.js` 在盯，漏掉會紅。

## 國際化專案規則（最高優先級）

OwnMind 走向國際化服務、要做**雙軌國際化**。2026-05-26 Vin 拍板。詳細見 OwnMind 記憶 `project_498`（雙軌國際化專案規則）+ `project_482`（v1.20 i18n 路線 C）。

### 軌道 A — 產品 i18n（user-facing）

延續 2026-05-24 拍板的「路線 C 編譯時自動翻譯」、4 機制控制一致性：
- git 快取（翻完 commit 進 en.json / ja.json）
- LLM temperature=0
- 術語表 `glossary.json`
- override 字典

範圍要擴大、不只前端 UI、還涵蓋：
- 前端 UI 字串
- MCP tool descriptions
- Hook 終端機訊息
- Server error messages
- README / CHANGELOG / 公開文件

### 軌道 B — 開發環境英文化（developer-facing）

**寫新程式碼時、以下一律英文：**

- JS / TS 的 `//` `/* */` 註解、JSDoc
- `console.log` / `console.error` / `throw new Error` 訊息
- 寫死的字串常數（除非是 i18n 字串表本身）
- 變數名稱、函式名稱、類別名稱
- OpenSpec spec、proposal、tasks 等內部開發文件
- README / CHANGELOG / FILELIST 主版本（zh-TW / ja 翻譯版另開）

**改既有檔案遇到中文** → 順手翻成英文、不另開 PR。大規模翻譯舊有中文要列入專案計畫、不亂改。

### 不在範圍（可保留原語言）

- 使用者自己存的記憶 / 鐵律內容 — user data
- 測試 fixture 模擬使用者中文輸入
- i18n locale 字典本身的中文翻譯值（例如 `zh-TW.json`）
- AI 跟 user 對話的訊息（既有鐵律：AI 回話一律白話中文）
- user 自己的 commit 訊息
- 此 `CLAUDE.md` 跟 `configs/` 下的 AI 指引文件（Vin 主要讀者、保留中文）

### 為什麼

- 想讓 OwnMind 變成國際化服務、全球工程師都能參與貢獻
- 開發環境英文化是「能讓全球開發者讀懂程式碼」的前提
- 不能只翻 UI 不翻內部、會變成半套國際化

### 卡控狀態（2026-05-26）

- 目前**沒有**自動 lint 卡控（嘗試升個人鐵律因 scope 跨專案、已停用）
- 靠 AI 自律 + 進入此 repo 讀 CLAUDE.md
- 等大規模翻譯啟動時、再評估加 project-scoped ESLint / pre-commit lint

## 既有現況（2026-05-26 掃描結果）

| 區塊 | 含中文檔案 | 中文行數 |
|---|---|---|
| `src/` | 66 | 2326 |
| `mcp/` | 7 | 374 |
| `hooks/` | 20 | 649 |
| `client/` | 32 | 267 |
| `shared/` | 26 | 752 |
| `scripts/` | 0 | 314 |
| `tests/` | 136 | 4653 |
| `openspec/` | 72 個 .md | — |

合計 298 個 JS/TS 檔含中文、9334 行。

## 既有 i18n 工具

- `scripts/lint-zh-only.js` — 檢查 client/src 內中英混雜（黑名單英文詞）、跟著 `npm test` 跑
- `client/` 內已有 `translate:client` 腳本（路線 C 部分實作）
- `client/src/i18n/` 字典檔

## 相關參考

- OwnMind 記憶：`project_498`、`project_482`、`iron_rule_131`
- OpenSpec change：`openspec/changes/v1.20-frontend-rebuild/`
