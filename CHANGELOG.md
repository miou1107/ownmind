# OwnMind 更新紀錄

## v1.20.0 — 後台前端基礎建設（藍綠並存「藍」打地基）

**背景：** 規劃 v1.20 系列「後台前端整套重構」、本版聚焦基礎建設、為後續 v1.20.1~4 功能版本建好地基。新版前端 SPA（單頁應用、Single Page Application）進 `/dashboard/` 路徑、舊版 `/admin/` + `/me/` 完全不動（藍綠並存策略、即新舊並存到 v1.20.4 才退役）。

**v1.20 系列版控規劃：**

- v1.20.0（本版）— 基礎建設（client 目錄 + 編譯流程 + i18n 多語系機制 + 中英混雜 lint）
- v1.20.1 — Dashboard 個人版（Portal + Preference 共 7 頁 + 後端 API 對接）
- v1.20.2 — 管理員頁面（Team + Bugs）
- v1.20.3 — 超管頁面（Config + Broadcast + Audit）
- v1.20.4 — 舊版退役（`/admin/` + `/me/` 301 轉址到 `/dashboard/`、舊靜態檔搬 legacy 保留）

**前端編譯打包基礎建設：**

- `client/` 新目錄：React 19.2.6 + Vite 8.0.14 + Tailwind v4.3.0 + Recharts 3.8.1 + Lucide-react 1.16.0 + react-router-dom 7
- multi-stage Dockerfile：stage 1 編譯前端、stage 2 COPY 進 `./src/public/dashboard/`
- 主 `package.json` 加 `build:client` / `dev:client` / `translate:client` script
- `src/app.js` 新增 `/dashboard` 路由 + SPA fallback（舊 `/admin` + `/me` 完全不動）
- 編譯後 bundle 大小：235KB JS、壓縮後 75KB（gzip）、203 毫秒打包完成

**i18n 機制已建好、英日字典 v1.20.1 隨 UI 一起翻譯（路線 C）：**

- 設計：寫繁中、dev 端跑 `npm run build` 含自動翻譯成 EN / JA、結果 commit 進 git（不每次發版重翻、不每次使用者切語言打 LLM）
- Dockerfile prod build 走 `build:no-translate`、用已 commit 的字典（避免 Docker build 時依賴 LLM API key）
- `client/src/i18n/`：`zh.json` 為唯一真實來源（30 個起手 key）+ `glossary.json` 術語固定對照（20 個品牌專業詞）+ `{locale}.override.json` 人工強制覆寫
- `client/src/scripts/translate.mjs`：增量翻譯腳本、支援 OpenAI 相容 API（kkvin.com llm-switch / OpenAI / Anthropic）、`temperature=0` 降低隨機性、hash 比對未變動就跳過
- 4 機制控制翻譯一致性：(1) git 快取、(2) temperature=0、(3) 術語表、(4) 人工覆寫
- 額度成本估算：每次發版增量翻譯約 0.001 美金、一年 50 次發版約 1.6 台幣
- 無 API key 時自動退到 manual mode、列出待翻 key 提示人工貼進外部翻譯工具
- **本版 (v1.20.0)：機制已建好、`en.json` / `ja.json` 仍為空 `{}`、字典 v1.20.1 連同實際 UI 內容一起翻譯**
- 當前所有頁面都是空殼（顯示「重構中」）、`t()` fallback 回繁中、英日 user 看到繁中也合理

**中英混雜 lint：**

- `scripts/lint-zh-only.js`：掃 `client/src` 的 JSX/JS、抓寫死英文 UI 文案
- 黑名單詞（Compliance / Bug Triage / Notional / EXCELLENT / TOTAL INPUTS / Status: 等 ~15 個）、除非外包 `t('key')` 翻譯函式
- 跑出 0 個違反

**設計三原則（最高約束、貫穿整個 v1.20 系列）：**

1. **純白話中文、零中英混雜**（lint 強制）
2. **保留 Gemini Antigravity 原型的視覺風格、文案、UX 巧思**（重寫不照搬程式碼、設計稿留在外部不入倉）
3. **可長期維護、不寫死、不疊床架屋**（元件拆分 + 前端路由化 + i18n 自動翻譯 + Context 拆狀態 + 統一 API client + 設計 token）

**端到端測試結果（v1.20.0 範疇）：**

- 14 條路由切換全通過（Portal 4 頁 + Preference 3 頁 + Admin 2 頁 + Super 3 頁 + 預設導向 + 404 fallback）
- 桌面（1457×828）+ 手機（375×812）viewport 渲染對
- console 零錯誤
- 中英混雜 lint 0 違反
- Vite build 203 毫秒、產出 dist 成功
- prod basename `/ownmind/dashboard` 正確寫進 bundle

**順手修 bug：** `main.jsx` basename 原本用 `document.baseURI` 動態推算、但 Vite SPA fallback 後 baseURI 跟著 URL 變、產生 URL 堆疊（`/portal/X/portal/Y`、同一段路徑被疊兩次）。修法：改用 `import.meta.env.PROD` 判斷、dev 走空字串、prod 寫死 `/ownmind/dashboard`。e2e 測試抓到這個 bug、若直接 commit 部署、prod 才會踩到。

**部署前確認：**

- 既有 1827+ 測試全綠
- `npm audit` 0 漏洞
- `vite build` 產出 dist 成功
- 三語系 README 版號同步 v1.20.0

**v1.20.1+ 後續：** 各 release 提案的 stub 已建在 `openspec/changes/v1.20.{1,2,3,4}-*/`、對應 release 開動時展開為完整提案。

---

## v1.19.20 — Critical 鐵律卡控擴充：4 條 Bash 指令樣式 detector

**背景：** v1.19.6 + v1.19.7 已建立 rule-enforcer 共用判定核心、本版補完 PreToolUse hook（AI 呼叫工具前的攔截程式）對 Bash 指令樣式比對的卡控能力。

**新增基礎能力：**

- `shared/verification.js` 新增 `command_matches` / `command_not_matches` 兩個 handler、能對 Bash 指令字串做 regex 樣式比對
- `hooks/ownmind-iron-rule-check.js` 升級：detect 不到 trigger 時 fallback 成 `'command'`、讓 command-based 鐵律能跑；context 加 command 欄位

**4 種指令樣式類別升 critical + 加 verification（自動卡控）：**

| 類別 | 卡控樣式 | 行為 |
|---|---|---|
| Docker 編譯快取 | when 含 `docker(\| compose) build` → then 必須含 `--no-cache` | 違反直接擋下 |
| Docker Compose 部署一致性 | when 含 `\bdocker build\b` → then 必須含 `compose` | 違反直接擋下 |
| Windows SSH 工具選擇 | 指令不能含 `\bsshpass\b` | 違反直接擋下 |
| 長指令背景保護 | when 含背景 `&` + 長指令樣式（docker build / npm install 等）→ then 必須含 `nohup` | 違反直接擋下 |

具體對應到的使用者規則編號是使用者私人記憶、不在此公開文件中引用。實際卡控規則透過 `ownmind_update` API 對使用者自訂規則加 metadata、不寫死在程式碼。

**Python SSH 密碼處理規則為何跳過：** 是寫 Python 程式碼時的卡控、不是 Bash 指令、需要 PreToolUse 的 Edit/Write matcher hook（另一種 hook 類型）、列入 v1.19.21+。

**Bypass 機制（前批次 v1.19.6 已建立）：**
```bash
OWNMIND_BYPASS=<rule_code> docker build .   # 單條放行（代號從 user 個人記憶查）
OWNMIND_BYPASS=all docker build .            # 全部放行
```
每次放行寫 audit log。

**測試：** 27 個 unit test 含 4 條鐵律的 when/then 場景模擬。全套 1872 個測試綠。

**對應規格：** `openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/`
**對應 GitHub issue：** [#41](https://github.com/miou1107/ownmind/issues/41)

### 順手修：PreToolUse hook 靜默失效（嚴重）

實測時發現 `hooks/ownmind-iron-rule-check.js` 在 parse API 回應後直接 `rules.filter()` 會 throw「rules.filter is not a function」、被 `main().catch()` 吞掉、整個 hook 靜默退出（exit 0、無 output）。

根因：API 在 v1.19.x 某版改成 `{ data: [...] }` envelope 回應、但這支 client hook 沒同步、誤把 envelope 當 array 用。

影響：v1.19.x 某版以來所有 PreToolUse 卡控（含 v1.19.6 的 rule-enforcer、本版的 4 條 detector）都靜默失效。表面看像沒擋過任何違規、其實是 hook 還沒跑到 verification engine 就 throw 退出。

修法：兼容兩種格式 — `rules = Array.isArray(parsed) ? parsed : (parsed.data || [])`。

修完後本機實測 4 條 critical 規則全部正常擋下違規指令。

---

## v1.19.19 — 全站 requireFields helper（API 必填欄位錯誤訊息可偵錯化）

**背景：** v1.19.18 release 後想跑 `ownmind_log_session` 記錄、連續兩次收到：

```
API 400: 必填欄位：tool, model, summary
```

但實際傳了三個欄位。debug 後發現是 AI 寫 tool call 時把 `antml:parameter` 寫成 `parameter`（少了命名空間前綴）、MCP 解析時只認得第一個欄位、其他三個被丟掉、client 送出去缺欄位的 body、server 正確回 400。

問題：**錯誤訊息無法 self-correct**。AI 看到「必填欄位：tool, model, summary」、會覺得「我明明三個都填了啊」、無從判斷是 args parse 階段就掉了、還是 transport 階段、還是 server 端的問題。

**修法：** 新增 `src/utils/require-fields.js` 共用 helper、回的 400 payload 含：

```json
{
  "error": "必填欄位缺少",
  "missing": ["tool", "model"],
  "expected": ["tool", "model", "summary"],
  "received": { "summary": "test summary" }
}
```

客戶端看到 `missing` + `received` 立刻能診斷「我傳了 summary、但 tool / model 不見了 → args 階段就掉了」。

**移植範圍（7 個 endpoint）：**

| 檔案 | 必填欄位 |
|---|---|
| `src/routes/session.js` | tool, model, summary |
| `src/routes/admin.js` | email |
| `src/routes/handoff.js` | project, from_tool, from_model, content |
| `src/routes/memory.js`（POST /） | type, title, content |
| `src/routes/memory.js`（POST /batch-sync-standard） | parent_title, chunks |
| `src/routes/secret.js` | key, value（**value 自動遮蔽**） |
| `src/routes/usage/pricing.js` | tool, model, input_per_1m, output_per_1m, effective_date（順手統一） |

**安全：** `received` 中已知敏感 key（password / token / secret / api_key / value 等）自動遮蔽成 `<REDACTED>`、避免錯誤回應洩漏密鑰。

**測試：** 18 個 unit test 含敏感欄位遮蔽（安全關鍵）、邊界值（null / undefined / 空陣列 / 數字 0 / false）。全套 1845 個測試綠。

**Breaking change：** 無（既有客戶端只看 status code、不解析 error payload 內容）。

**腿 B（MCP client schema pre-validation）已列 backlog**、未來若 generic 400 仍頻繁發生再動工。

**對應規格：** `openspec/changes/archive/v1.19.19-require-fields-helper/`

---

## v1.19.18 — 安全：修補三個中度依賴漏洞（npm audit fix）

**背景：** 在 Antigravity 環境跑 `npm audit` 發現 3 個中度（moderate）相依套件漏洞：

| 套件 | 升級 | 漏洞 |
|---|---|---|
| `qs` | 6.15.0 → 6.15.2 | DoS 阻斷服務（`encodeValuesOnly` 開啟時對 null/undefined 解析會炸 TypeError）— [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) |
| `ip-address` | 10.1.0 → 10.2.0 | XSS 跨站攻擊（Address6 HTML-emitting methods）— [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) |
| `express-rate-limit` | 8.3.2 → 8.5.2 | 自己沒漏洞、是因依賴有漏洞的 `ip-address` 連帶升級 |

**為什麼這三個要修：**

- **`qs` DoS**：Express 5 內建用 `qs` 解析查詢字串（URL 後面 `?key=value` 那段）、可被遠端觸發。OwnMind 伺服器直接面向公開網際網路、有實際風險。
- **`ip-address` XSS**：只在用 `Address6` 的 `.toString()` 等 HTML 輸出方法時觸發。`express-rate-limit` 只拿來判斷 IPv6 位址範圍、沒走 HTML 輸出路徑、實際被利用機率低。一併升掉。
- **`express-rate-limit`**：間接依賴連帶升級。

**修法：** 跑 `npm audit fix`、npm 自動升三個套件到無漏洞的 minor 版本（不會跨 major、不引入 breaking change）。全套 1827 個測試綠、`npm audit` 回 0 漏洞。

**對應規格：** `openspec/changes/v1.19.18-security-audit-fix/`
**對應 GitHub issue：** [#43](https://github.com/miou1107/ownmind/issues/43)

---

## v1.19.17 — hotfix：錯誤回報後台「查看」「審查」按鈕點了沒反應

**症狀：** 登入後台 → 錯誤回報分頁 → 點任一筆的「查看」按鈕、沒反應、modal 沒展開。

**根因：** 既有 modal 顯示用 CSS class `.active` 觸發（規則：`.modal-overlay.active { display: flex; }`）、但 v1.19.14 加錯誤回報分頁時 JS 寫的是 `classList.add('show')`、永遠對不上 CSS、modal 永遠不顯示。

是 IR-005「不要 blind edit」的活樣本：寫新 modal 時沒看既有 modal 怎麼用、自己假設 class 名是 show、實際是 active。

**修法：** `src/public/index.html` 共 4 處 `classList.add/remove('show')` 改成 `'active'`（bugReportModal 跟 spamSuspectModal 各 2 處）。

**測試：** `tests/admin-html-no-duplicate-const.test.js` 加新 case、grep 整份 HTML 不能再出現 `classList.add/remove('show')`、防止這類問題復發。

---

## v1.19.16 — hotfix：admin 後台登入頁 SyntaxError、所有人登不進去

**P0 緊急修補。** v1.19.14/15 部署後 Vin 從瀏覽器打開 `https://kkvin.com/ownmind/admin/`、輸入帳密按登入沒反應。打開 DevTools 看 console 顯示：

```
Uncaught SyntaxError: Identifier 'cached' has already been declared (admin/:1948)
Uncaught ReferenceError: login is not defined at HTMLButtonElement.onclick
```

**根因：** `src/public/index.html` 的 `iruUpdateTier` 函式內 `const cached` 出現兩次（1926 + 1948 行）、是 JavaScript 規範明確的 SyntaxError。整個 `<script>` tag 解析失敗 → 所有函式（含 `login`）都拿不到 → 按登入按鈕沒反應。

**Bug 來源：** v1.19.0 release（commit 5ffc646、鐵律 tier 升級助手）就引入。瀏覽器快取讓部分使用者一直沒爆、直到 v1.19.14 / v1.19.15 部署後 reload 才被發現。

**修法：** 第 1948 行的 `const cached` 砍掉、重用第 1926 行已找到的 `cached` 變數（async function 同 scope 看得到）。

**為什麼之前自動測試沒抓到：** OwnMind 既有測試都是純後端、`src/public/index.html` 沒測試覆蓋。本版加 `tests/admin-html-no-duplicate-const.test.js` 用文字比對防止這類問題復發。

---

## v1.19.15 — bug_reports 系列 id 從 BIGSERIAL 改 SERIAL

**背景：** v1.19.14 部署後跑 smoke test 發現 `POST /api/bug-reports` 回應的 `id` 是字串 `"1"`、跟既有 `memories` 表（回數字 `3`）不一致。原因：node-pg 套件預設把 PostgreSQL 的 bigint（型別 oid 20）回字串、避免超過 JS Number 安全整數上限（2^53 - 1）失精；而 SERIAL（int4、oid 23）則自動轉成 Number。

**修法：** migration 017 把 5 張表的 `id` 從 BIGSERIAL 改 SERIAL（21 億上限、bug_reports 表絕對夠用），順便把 `bug_report_spam_suspects.report_ids` 從 `BIGINT[]` 改 `INT[]`。

**為什麼不全域改 node-pg type parser**：會影響既有 `token_usage` 表的 BIGINT 計數欄位（token 數累積可能超過 Number 安全範圍、需要保留字串）。改 schema 比改 parser 風險小、影響面小。

**安全保證**：migration 017 開頭加 sanity check、五張表任一非空就 `RAISE EXCEPTION` 拒絕跑（避免在 prod 已有資料時毀資料）。剛 release v1.19.14 後跑了 smoke test 並清空、這時點搭 migration 017 是安全的。

**對應規格**：`openspec/changes/v1.19.15-bug-reports-id-serial/`

---

## v1.19.14 — 錯誤回報工具（使用者 ⇄ 開發者雙向通知）

**背景：** OwnMind 倉庫公開後、需要正式管道讓使用者主動回報「OwnMind 本身的問題」（例如寫入被誤擋、出錯、設計不合理）。既有的 `ownmind_save type=project` 跟 `ownmind_report_compliance` 語意不對、無法擴展。

**範圍：**

1. **新增資料表**：`bug_reports` 主表 + `bug_report_declines`（冷靜期）+ `bug_report_spam_suspects`（自動偵測疑似亂送）+ `bug_report_spam_blocks`（24 小時封鎖）+ `bug_report_notification_mutes`（通知靜音）。
2. **新增 11 個 API 端點**（POST 建立、GET 列表、PATCH 狀態、decline、通知 fetch、batch mark-all-read、靜音、spam-suspects 三支）。
3. **新增 MCP 工具 `ownmind_report_bug`**：跨多種 AI 工具（Claude Code、Cursor、Codex 等）共用、AI 看到後端的 `suggest_report` 旗標就提示使用者要不要回報。
4. **介面層 + 後端三道防線**：
   - 介面層：同 fingerprint 1 小時內已 3 筆 → 直接 HTTP 429
   - 後端：`confirm_string="送出"` 守門（要使用者親口輸入）
   - 後端：spam 偵測背景跑（1h 5 筆+3 相似 / 24h 30 筆 / 1h 同 fingerprint 5 筆 → 標 suspect、由管理員審查確認、確認後 24 小時封鎖該 user 的 `suggest_report` 旗標）
5. **隱私強制遮蔽（fail-closed）**：對話片段送 `ownmind_report_bug` 時、後端強制套用 `shared/privacy-detect.js`、把信箱／身分證／台灣手機代稱化；偵測器崩潰時回 500 + 不寫 DB。
6. **冷靜期整合到原始錯誤回應**：後端拋 400 / 5xx 時內聯查 `bug_report_declines`、過去 24 小時拒絕過 → 不附 `suggest_report` 旗標。客戶端不需要打額外 API。
7. **客戶端啟動通知**：SessionStart hook 時 fetch 通知、雙軌顯示（管理員看新回報、回報者看處理完成）；fetch 失敗靜默略過、不擋啟動。
8. **主機指紋**：用 npm 套件 `node-machine-id` 抓作業系統機器 ID（macOS IOPlatformUUID / Linux /etc/machine-id / Windows MachineGuid）+ 安裝路徑 → SHA-256 取前 16 字。每次啟動即時算、不寫檔、跨重啟穩定、Docker / VPN 環境不會變動。
9. **對話片段聯合型別**：`conversation_snippets` 是 `(string | TruncatedMessage)[]`、共用 schema 在 `shared/context-blob-schema.js`、避免強型別語言（Go / Rust）對接時反序列化失敗。

**設計演進**：經三輪 Gemini 對抗審查（v1 → v4.1）、砍掉本地持久化 retry queue（過度設計）、砍掉 should-prompt 獨立 API（冗餘）、砍掉客戶端 confirm-window hook（多客戶端做不到）。最終以「介面層硬擋 + 後端守門 + 後台 spam 審查」三道防線取代不可靠的客戶端 hook。

**新增依賴**：`node-machine-id ^1.1.12`。`scripts/update.sh` 跟 `scripts/update.ps1` 已同步補裝邏輯（IR-042）。

**對應規格**：`openspec/changes/v1.19.14-bug-report-tool/`（proposal.md / spec.md / tasks.md）。

---

## v1.19.13 — 掃密 keyword 偵測收緊、降低誤判

**背景：** 2026-05-23 / 2026-05-24 連續 4 次 AI 想存 type=`env` 的「bot.kkvin.com 遠端訪問方式總覽」記憶被擋。追根究柢、被擋的內容只是「密鑰名稱字串」（如 `anydesk.bot_kkvin.unattended_password`）跟 IP／連線編號等非敏感資訊、實際密碼存在 OwnMind 密鑰管理工具裡。v1.19.1 引入的 value-side keyword 偵測太寬鬆（「只要出現 password 字樣就擋」）導致誤判率高。

### 變更：value-side keyword 從寬鬆比對改賦值樣式

`shared/secret-detect.js` 的 value-side keyword 偵測從「value 含 password／token／secret 字樣就擋」改成「**含 `KEY: VALUE` 或 `KEY=VALUE` 賦值樣式、且 VALUE 長度 ≥ 8 字才擋**」。

對照表：

| 內容 | v1.19.12 | v1.19.13 |
|------|----------|----------|
| `anydesk.bot_kkvin.unattended_password`（密鑰名稱 reference） | ❌ 誤擋 | ✅ 放行 |
| `the password is in the vault`（描述句） | ❌ 誤擋 | ✅ 放行 |
| `process.env.MY_PASSWORD`（程式碼 reference） | ❌ 誤擋 | ✅ 放行 |
| `password: MyP@ssw0rd123`（真實貼密碼） | ✅ 擋下 | ✅ 擋下 |
| `API_TOKEN=abc123XYZ987`（真實貼 token） | ✅ 擋下 | ✅ 擋下 |
| `password: hi`（form label / placeholder） | ❌ 誤擋 | ✅ 放行（值 < 8） |
| `mypassword=hello123`（複合詞變數） | ❌ 誤擋 | ✅ 放行（詞邊界保護） |

### 變更：點分隔識別字路徑跳過長度啟發式

`process.env.MY_PASSWORD` 跟 `anydesk.bot_kkvin.unattended_password` 這類「點分隔識別字路徑」（每段是合法變數名、用 `.` 串接）也被長度啟發式（≥ 20 字純英數字）誤抓。v1.19.13 加負向條件、識別字路徑樣式直接放行。真實密鑰（JWT、AWS、GitHub PAT、OpenAI key）有專屬 regex 抓、不依賴此啟發式。

### 變更：400 回應加 `matched_text` 欄

`detectSecretLike()` 命中時回傳體新增 `matched_text` 欄位（截 80 字）、`src/utils/memory-secret-guard.js` 把它帶進 400 body。AI 收到 400 時直接看到「哪段觸發」、可一次改對、不必反覆嘗試 3 次。

### 不變

- title／description keyword 掃描邏輯**不動**（保持「出現就擋」、narrative 類型透過 `skip_keyword: true` opt-in 例外）
- Regex 7 條全部不動（WP / JWT / GH PAT / AWS / OpenAI / OwnMind 預定金鑰 / 預設密碼字面）
- bypass flag、narrative 類型例外、邊界輸入處理、pre-commit hook 行為均不變

### 驗證

- `npm test` 1706 / 1706 全綠（+31 個 v1.19.13 新測試含 bot.kkvin.com 真實案例 regression、+ code review 後追加 I-1 PII 不洩漏 / I-2 雙段 base64 不放過 / I-3 snake_case 仍擋 共 11 條）
- `tests/secret-detect-unit.test.js` `tests/memory-secret-guard.test.js` `tests/pre-commit-secret.test.js` 三檔合計 111 測試全綠
- 追根究柢確認專案 469 規劃的「CGNAT IP 白名單」「9-10 位純數字白名單」實際非觸發點、本版不做

### Code review fixes（內部審查後追加）

- **I-1**：`extractKeywordContext` 會把 title 中 keyword 周圍 20 字 echo 進 `matched_text`、若 title 含相鄰個資（手機／信箱）會洩漏進 400 body。改為只回 keyword 字面、不 echo 上下文。
- **I-2**：`DOT_SEPARATED_IDENTIFIER_REGEX` 原本要求 ≥ 2 段、會放過被砍掉 signature 的 JWT 樣式（`eyJhbGc...eyJzdW...`）。改為要求 ≥ 3 段（真實 reference 都符合此特徵）。
- **I-3**：lookbehind `(?<![A-Za-z])` 刻意不對稱（只擋字母前綴、`foo_password=xxx` 仍擋）、補 spec.md S1.9 / S1.10 + 程式碼註解誠實標示此設計意圖。
- **I-5**：賦值 regex 值長度加上界 `{8,200}`、避免 pathological 大輸入。

### 部署影響

- 不需 db schema 變更
- 重啟 server 後 v1.19.1 起部分被誤擋的 reference 型記憶可正常寫入
- API 行為向後相容（matched_text 是新增欄、舊 client 忽略即可）

---

## v1.19.12 — Code review 延後項收尾 + nginx 反向代理修正

**背景：** v1.19.7-10 累積的 code review reviewer 建議的 M-2 / M-3 / M-4 / M-5 四個延後項、加 v1.19.11 部署 prod 時發現的 `express-rate-limit` 警告、一起做完。

### M-2：`secret-detect.js` 從 `src/utils/` 搬到 `shared/`

統一純函式偵測器的位置。`shared/` 目錄底下的模組由 hooks（client）跟 server 都會用、是真正的「跨層工具」。

修改：
- `git mv src/utils/secret-detect.js shared/secret-detect.js`
- `src/utils/memory-secret-guard.js` import 路徑改 `../../shared/secret-detect.js`
- `hooks/ownmind-git-pre-commit.js` import 路徑改 `../shared/secret-detect.js`
- `tests/secret-detect-unit.test.js` import 路徑改 `../shared/secret-detect.js`

驗證 80 個相關測試（secret detect + memory guard + pre-commit）全綠。

### M-4：`PRIVACY_TYPE_LABELS` 並列 `PRIVACY_PATTERNS`、未來加類型不漏配對

`shared/privacy-detect.js` 新加 export 的 `PRIVACY_TYPE_LABELS` 常數（凍結物件、防誤改）、跟 `PRIVACY_PATTERNS` 並列。未來加新偵測類型時、改到這個檔自然會看到要補對應顯示標籤、不會散落各處。

`hooks/ownmind-reply-lint.js` 的 `formatPrivacySummary` 加註解、提示 labels 必須跟 shared 版本同步；本地保留 hardcode 避免 module top-level 函式 import 失敗的風險。

### M-5：合併 transcript 讀取（I/O 減半）

`hooks/ownmind-reply-lint.js` 把原本兩個函式 `readLastAssistantText` 跟 `readRecentUserPrompts` 合併成單一 `readTranscriptTail`、一次 statSync + readFileSync 同時抽「最後一輪 assistant 文字」+「最近 5 輪 user prompts」。

效益：大 transcript 場景（> 256KB）的 I/O 從 2 次降為 1 次、降低 hook 延遲。提早 break 機制（拿到目標就停止掃舊行）也降低解析成本。

### nginx 反向代理修正（trust proxy）

`src/app.js` 加 `app.set('trust proxy', 1)`。修正 v1.19.11 部署 prod 後容器 log 出現的 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` 警告。

意義：開了之後、`express-rate-limit` 會用 `X-Forwarded-For` header 識別真實 user IP、不再把所有經過 nginx 的請求當同一個來源計數。對 prod 多 user 環境的 rate limit 準確度有實質影響。

### 不在 v1.19.12 範圍

- M-3（JSDoc 範例對齊）：reviewer 原評估「低影響、cosmetic」、目前範例註解仍對齊 v1.19.4 banner 格式、不影響理解、留作 v1.20+ cleanup

### 驗證

- `npm test` 1675 / 1675 全綠（v1.19.11 之後 0 個新測試、純內部重構）
- secret-detect 路徑搬家後既有 80 個相關測試全綠
- transcript 合併讀取後既有 reply-lint 相關 36 個測試全綠（含分級顯示、log 紀錄、privacy 例外）

### 部署影響

- 不需 db schema 變更
- prod 重啟後容器 log 不再出現 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` 警告
- 客戶端 hook 重新讀取（next reply-lint trigger）會用新的 `readTranscriptTail`、向後相容

---

## v1.19.11 — Lint UX 改善：誤判降低 + 雙顯示原因標註 + 自學資料根基

**背景：** v1.19.7-10 落地後、Vin 在使用中發現三個體驗問題：

1. 寫專案紀錄（type=project）時、本來就會大量引用程式碼檔名跟路徑（`random-password.js`、`v1.19.9-password-recovery`、`must_change_password`），這些子字串被偵測器當敏感資料攔下、必須迂迴改寫
2. reply-lint 擋下後 Claude 直接重寫一份新回應、不會自我標註「我剛被擋了、現在重寫」，使用者看到兩段相似內容、感覺 AI 在重複
3. 被擋下的事件沒結構化紀錄，沒法統計「我這週被擋幾次、最常違反哪條」，後台儀表板資料來源不完整

v1.19.11 三條改善一起做。

### 1. 誤判降低（方案 A）

`src/utils/memory-secret-guard.js` 的 narrative 類型清單擴大：

- 新增 `project`：專案紀錄會引用程式碼路徑
- 新增 `portfolio`：作品集會引用實作細節

這些類型寫入時、`skip_keyword: true` 跳過 keyword 偵測。樣式比對（regex）跟長度啟發式仍跑、不影響真實金鑰偵測。

補測試 `tests/memory-secret-guard.test.js`：3 個 v1.19.11 真實踩坑回歸 case（project 含程式碼路徑不被擋、portfolio 含技術詞不被擋、project 含真 PAT 仍被擋）。

### 2. AI 自我標註（軟性提示、盡力做到）

`hooks/ownmind-reply-lint.js` 的 `formatBlockReason` 加要求 AI 重寫時開頭加引述標註：

```markdown
> ⚠️ **上一版違反 IR-036、重新調整：**
> （簡短說明違規詞或原因）

---

[新回應內容]
```

不驗證 AI 是否照做（接受約 85% 服從率、業界沒有實證能到 100%）。失效時靠 log 保底（見 4）。

### 3. 分級顯示（避免使用者疲勞）

根據 session 內擋下次數調整訊息長度：

| 第 N 次擋下 | 顯示樣式 |
|---|---|
| 第 1 次 | 完整：違規規則 + 違規詞清單 + 改寫提示 + 標註要求 |
| 第 2-3 次 | 簡短：「↻ 上版違反 IR-XXX、已被指示重寫（本 session 第 N 次擋下）」 |
| 第 4 次 | 達 downgrade limit、降為警告 exit 1（既有 v1.19.7 行為） |

### 4. 結構化擋下紀錄（log 保底 + 自學根基）

新檔 `hooks/lib/lint-event-logger.js`：

- `writeEvent(entry)`：擋下事件 append 一筆到 `~/.ownmind/logs/reply-lint-events.jsonl`
- `extractViolatedWords(violations)`：純函式、抽違反詞統計（privacy 不存原值、只存類型計數）
- 5MB cap 自動 rotate（超過 rename 成 `.old`）
- 寫入失敗 fail-open（不擋 hook 主流程）

紀錄欄位：`ts / session_id / event / rule_codes / violated_words / violation_count_in_session / block_count_in_session / downgraded_to_warning / ai_instructed_to_annotate`

為下列 v1.20+ 功能鋪資料根基：

- 個人統計（後台儀表板：你這週被擋幾次、最常違反哪條）
- 誤判建議（某條規則高頻違反 + 高 bypass 率 → 建議調寬）
- 規則優化（某詞重複被擋 → 建議加白名單）
- 跨工具連續紀錄（所有 OwnMind 客戶端共用同一份紀錄）

### 整合到主流程

`hooks/ownmind-reply-lint.js` 主流程：

- 擋下時、寫一筆 `event: 'blocked'`、`ai_instructed_to_annotate: true`
- 降警告時、寫一筆 `event: 'downgraded_to_warning'`
- 沒擋下時、不寫紀錄（保持紀錄檔精簡）

### 測試

- 新增 `tests/lint-event-logger.test.js`（12 case）：純函式覆蓋、rotate、寫入失敗、privacy 不存原值
- 新增 `tests/reply-lint-hook-v1911.test.js`（7 case）：場景 5+7 完整訊息、場景 8 簡短訊息、場景 9 降警告、場景 10/13/14 紀錄寫入
- 更新 `tests/memory-secret-guard.test.js`：narrative 清單擴大 + 真實踩坑回歸 3 case
- 更新 `tests/reply-lint-hook-v197.test.js`：兩個 case 改成跑到第 1 次擋下（避開分級簡短訊息）

### 驗證

- `npm test` 1675 / 1675 全綠（v1.19.10 之後新增約 26 個 case）
- 不破壞既有 reply-lint 行為（v1.19.3 / v1.19.7 / v1.19.10 既有 case 全綠）

### 設計取捨

- **為何不驗證 AI 標註**：Stop hook 沒法看 AI 重寫的內容、要驗證需 PostResponse hook 進入無限套娃。接受 best-effort、log 保底
- **為何只擴大 project / portfolio 而不全部敘述型**：profile 跟 env 真的會存敏感資料、不該跳過 keyword 偵測
- **為何 5MB cap**：個人開發者一週擋下事件約 50-200 筆、5MB 夠存 2-3 個月。超過 rotate 保留 .old 一份歷史
- **為何 privacy 不存原值**：IR-041 設計：紀錄個資原值會二次外流。只存類型計數（`privacy_matches_count`、`privacy_types`）夠統計用

---

## v1.19.10 — 安全強化：預設密碼隨機化 + 設定檔最佳實踐 + 隱私偵測中性化

> 兩個主題的合併版本：上半「預設密碼隨機化 + 設定檔最佳實踐」、下半「隱私偵測中性化」（把個人鐵律編號從產品程式碼抽掉、改成中性事件名）。

### 隱私偵測中性化（架構修正）

v1.19.7 把隱私偵測接到 reply-lint hook 時、把「IR-041」這個個人鐵律編號硬編碼進產品程式碼跟公開 README。問題：

- IR-041 是個別使用者的 iron_rule 編號（Vin 個人記憶內的鐵律）、不是 OwnMind 產品系統編號
- 別的 OwnMind 使用者沒有 IR-041、卻會被 hook 強制以該編號回報違反事件、混淆概念
- 公開 README 把它寫成「v1.19.7 新增 IR-041 偵測」、誤導讀者以為這是系統內建編號

**修正**：

- `hooks/ownmind-reply-lint.js` 中硬編碼的 `rule: 'IR-041'` 改成中性的 `rule: 'privacy_check'`
- `formatBlockReason` 中 `v.rule === 'IR-041'` 也改成 `v.rule === 'privacy_check'`
- `shared/privacy-detect.js` 跟 `tests/privacy-detect-unit.test.js` 註解中性化、改用「對應到 privacy_check 事件」描述
- `tests/reply-lint-hook-v197.test.js` 多處 IR-041 斷言改成 privacy_check
- 三語系 README 對應行改寫：「privacy 偵測工具發出 privacy_check 事件、實際擋下與否由使用者自設鐵律決定」、不再把 IR-041 當系統編號宣傳

**向後相容**：

- Vin 自己 server 上的 IR-041 鐵律仍正常運作、只是事件編號從 'IR-041' 變成 'privacy_check'
- 該鐵律的 verification 條件可調整為對應 'privacy_check' 事件
- 合規事件統計（compliance dashboard）會看到 'privacy_check' 取代 'IR-041' 出現

### 預設密碼隨機化跟設定檔最佳實踐

**主題：** 把幾處跟敏感資料相關的程式碼模式改成業界最佳實踐、避免「固定字串」類型的潛在弱點、並把這層保護寫進偵測器避免將來再犯。

### 新增

- `shared/random-password.js` — `generateRandomPassword(len)` 純函式、給多處共用
  - 規則：12 字（可指定長度）、含大小寫+數字、避開混淆字 0/O/I/l/1、強制至少 1 大寫 1 小寫 1 數字、用 `crypto.randomBytes`
  - 把 v1.19.9 `admin-password-reset.js` 的 `generateTempPassword` 抽到 shared 給三處共用

### 修改

- `.mcp.json` — `OWNMIND_API_KEY` 改用 `__SET_VIA_LOCAL_CREDENTIALS_OR_ENV__` 佔位符 + 註解說明
  - 公開的 repo 設定檔不應包含金鑰；本機跑時走 `~/.ownmind/credentials` 或自建 `.mcp.local.json`（已加進 `.gitignore`）
- `src/routes/admin.js` — 建立 user 時若沒指定密碼、改用 `generateRandomPassword` 每 user 各別隨機產生（取代既有固定字串）
  - admin 透過建立 user 回應的 `default_password` 欄位一次性看到、轉告對方後該值即作廢
  - 每筆 user 密碼都不同、避免「一把鑰匙開所有門」
- `src/jobs/seed-default-passwords.js` — 啟動時補 `password_hash IS NULL` 的 user 密碼、改成每人各別隨機
  - 寫進 server log 一次性顯示（含 email 跟臨時密碼）、admin 看完轉告對方後 log 即作廢
  - 對齊 v1.19.9 後台 reset-password 跟 admin 建 user 的行為
- `src/routes/admin-password-reset.js` — 改用 `shared/random-password.js`；`generateTempPassword` 為向後相容 alias
- `.gitignore` — 補 `.mcp.local.json` / `credentials*` / `*.pem` / `*.key` / `.env.local` / `.env.production` 等
- `src/utils/secret-detect.js` — 加兩條 regex 偵測樣式（給 pre-commit hook 用、IR-002 自動擋下）：
  - `ownmind_predefined_key`：抓 `(vin-)?ownmind-(admin|super|user|api)-*` 預定金鑰格式
  - `default_password_literal`：抓 `Password\d{8,}` 通用預設密碼樣式
- `tests/secret-detect-unit.test.js` — 補 9 個 case 驗新樣式跟邊界（一般 `password` 單字不誤判、長度不足不命中）

### 跟既有功能的並存

- `POST /api/admin/users` 沒指定密碼時、回應的 `default_password` 欄位仍存在、但每次值都不同
- `seedDefaultPasswords` 啟動行為向後相容（仍能補 `password_hash IS NULL` 的 user）、只是每人密碼不同
- v1.19.9 後台 reset-password endpoint 跟 admin.js 建 user 都統一走 `generateRandomPassword`

### 驗證

- `npm test` 1649 / 1649 全綠（v1.19.9 之後新增 7 個 secret-detect 測試）
- 既有功能不破壞（admin / setup / password-reset / seed job 都跑得起來）
- pre-commit hook 從今往後會自動擋下 commit 中含 OwnMind 預定金鑰格式或預設密碼樣式的字串

---

## v1.19.9 — 忘記密碼救援機制（三條防線）

**背景：** v1.19.8 把首次安裝體驗修好了、但「admin 忘記密碼」沒救：

- 沒有「忘記密碼」UI
- 既有 `POST /admin/users/:id/password` 改密碼需要舊密碼（自己改）或限 super_admin 改 admin（admin 之間互救）
- 唯一 super_admin 忘記密碼 → 只能 SSH 進 DB 跑 `UPDATE users SET password_hash = NULL` 然後設 `SETUP_TOKEN` 重啟、走舊 setup 路徑、流程繁瑣

對非技術 admin 等同「公司資料庫鎖死」。v1.19.9 推三條救援組合涵蓋全部情境。

### 方案 3：後台他人重設密碼（常態救援）

- 新增 `src/routes/admin-password-reset.js` — factory pattern、可注入測試
- 新增 endpoint `POST /api/admin/users/:id/reset-password`：
  - 跟既有 `POST /users/:id/password` 語意分開：前者是「忘記救援」、後者是「有意修改」
  - super_admin 可重設任何人；admin 只能重設 user；不可重設自己
  - 系統產 12 字隨機臨時密碼（含大小寫+數字、去掉 0/O/I/l/1 混淆字、用 `crypto.randomBytes`）
  - 設 `must_change_password=TRUE`、強制對方下次登入改
  - 寫 audit log（action='reset_password_by_admin'）
- 16 case 單元測試（含 generateTempPassword 純函式 + endpoint 整合）

### 方案 2：CLI 救援腳本（最後一道防線）

- 新增 `scripts/reset-admin-password.js`
- 互動式：列出 super_admin、選擇要重設誰、雙重確認（輸入 `yes`）才執行
- 動作：把 password_hash 設 NULL、產隨機 SETUP_TOKEN（32 字 hex）、印給使用者
- 後續引導：「設 SETUP_TOKEN 環境變數、重啟 server、開 /admin/setup 重設」
- 寫 audit log（action='cli_reset_password', source='cli_script'）
- 只列 super_admin（不列 admin / user、避免被當成後門用）
- 4 case smoke test：腳本存在、`--help` 退出碼 0、DB 失敗時錯誤訊息明確

### 方案 1：UI 強制引導（預防勝於治療）

- `src/public/setup.html` 完成頁加警告框：「立即建立第二位 admin、否則忘記密碼會卡死」
- `src/public/index.html` 加 `singleAdminBanner`：載入使用者列表時若 admin+super_admin ≤ 1 顯示橘色 banner 跟「前往使用者管理」按鈕
- 多於 1 位 admin 時 banner 自動隱藏

### 三條的協同覆蓋

| 情境 | 走哪條 |
|---|---|
| 還沒忘密碼、但只有一個 admin | 方案 1 banner 提醒、引導建第二位 |
| Admin A 忘密碼、Admin B 還在 | 方案 3 後台他人重設 |
| 只有一位 admin、且忘記密碼 | 方案 2 SSH + CLI 腳本 |
| 全部 admin 都忘記 | 方案 2 SSH + CLI 腳本 |
| 完全無 SSH 權限的雲端 SaaS 場景 | v1.20+ email 重設流程（不在 v1.19.9 範圍） |

### 設計取捨

- **為何不用 email 重設**：依賴 SMTP（簡單郵件傳輸協定：寄信用的協定）外部服務、工程量大、留 v1.20+
- **為何 CLI 腳本只列 super_admin**：admin 跟 user 該走後台救援（方案 3）；如果連 admin 都救不了那就是 super_admin 全部忘了的災難情境、才需要 CLI
- **為何臨時密碼避開 0/O/I/l/1**：使用者口頭轉告或手寫時容易看錯
- **為何強制 must_change_password=TRUE**：臨時密碼只該存活到第一次登入、設者跟被設者都不該長期持有
- **為何 audit 用 self-reference actor**：CLI 腳本場景沒有「重設者」可指（操作者由 source='cli_script' 註記）；後台場景 actor 是執行重設的 admin

### 測試

- `npm test` 1646 / 1646 全綠（v1.19.8 之後新增 20 個 case）
- 不破壞既有 `POST /users/:id/password`（修改密碼）跟 `/admin/setup` + `SETUP_TOKEN`（首次設定）
- 不需要 DB schema 變更（沿用既有 `users.must_change_password` 跟 `audit_logs` 表）

---

## v1.19.8 — Setup Wizard：首次安裝零摩擦進後台

**背景：** v1.19.7 之前新使用者部署完伺服器後遇到 chicken-and-egg 鎖死：

1. `db/001_init.sql` 只建 schema、不 seed 任何帳號
2. 想用 `/admin/login` → 找不到 super_admin、回「帳號或密碼錯誤」
3. 想用 `/admin/setup` endpoint 救援 → 必須先設環境變數 `SETUP_TOKEN` 重啟 server、還要手動 SQL INSERT 一筆 `password_hash IS NULL` 的 super_admin 紀錄
4. 想跑 client install.sh → 必須先有 API key、但只能由已存在的 super_admin 在後台建 user 後產生

結果：平均卡 30 分鐘以上、極差的 onboarding 體驗。

**v1.19.8 解法：** 新增 setup wizard 網頁、users 表為空時自動引導、零文件閱讀成本。

### 新增

- `src/routes/setup.js` — 新增兩個公開 endpoint：
  - `GET /api/setup/status` → 回 `{ first_run, users_count }`
  - `POST /api/setup/init` → first_run=true 時建第一個 super_admin、自動產 api_key、寫 audit log（action='setup_init'）
  - 用 `pg_advisory_xact_lock` 鎖確保並發 init 請求只有一個能成功（race condition 防護）
  - Factory pattern（`createSetupRouter` + `createFirstRunDetector`）、依賴可注入方便單元測試
- `src/middleware/first-run-redirect.js` — first-run redirect middleware：
  - users 表為空 + `/admin/*` 請求 → 302 redirect 到 `/setup`
  - users 表非空 + `/setup` 請求 → 302 redirect 到 `/admin/login`
  - 失敗時 fail-open（DB 連不上不誤導使用者進 wizard）
- `src/public/setup.html` — 純 HTML wizard 頁：
  - 表單收 email / name（可選）/ password / password 確認
  - 成功後顯示 api_key + 一鍵複製按鈕 + client install.sh 範例指令（自動填當前 host）
  - 含 `<meta name="robots" content="noindex,nofollow">` 不被搜尋引擎爬
- `src/utils/db.js` — 新增 `withTransaction(fn)` helper、給需要 transaction 序列化的場景用
- `tests/setup-wizard.test.js` — 19 個 case 涵蓋場景 4~10、14 + cache 行為 + race condition 模擬

### 修改

- `src/app.js` — 掛 first-run middleware（在 `/admin` static 之前）+ `/api/setup` route（在 `/api/admin` 之前）+ `GET /setup` 靜態頁
- README / docs/README.zh-TW.md / docs/README.ja.md — FAQ「首次安裝」段改寫：首推 wizard、`SETUP_TOKEN` 降級為「進階／救援通道」

### 跟舊路徑並存

舊 `/admin/setup` + `SETUP_TOKEN` 不刪除、定位改為「緊急救援」：

- **users 表為空** → 新 wizard 走（零摩擦、無需 token）
- **users 表有 super_admin 但 `password_hash IS NULL`**（從外部匯入帳號的場景） → 舊路徑走、仍需 SETUP_TOKEN
- **users 表正常但 admin 忘記密碼** → 走 SQL 手動重置

### 測試

- `npm test` 1614 / 1614 全綠（v1.19.7 之後新增 19 個 setup wizard case）
- 19 個 case 覆蓋：first-run 偵測、欄位驗證、race condition、advisory lock 呼叫、audit log 寫入、cache 行為、fail-open

### 設計取捨

- **為何不用 SETUP_TOKEN 強化版**：要求新使用者設環境變數重啟伺服器、再開瀏覽器、UX 很差；wizard 完全無需重啟即可使用
- **為何不直接 auto-seed admin/admin**：生產環境誤啟動就完蛋；wizard 強制使用者第一次自己設密碼
- **為何用 advisory lock 而非 schema constraint**：partial unique index `WHERE role='super_admin'` 在 PG 各版本支援度差異、advisory lock 應用層控制更乾淨
- **為何 cache 只快取 false 結果**：first_run=true 是過渡狀態（建好就翻 false）、頻繁查 DB 沒問題；快取 false 才能省 /admin/* 每個靜態請求的 DB 查詢

### Code review 採納事項（reviewer 一輪：0 Critical / 4 Important / 7 Minor、處理 6 條、延後 5 條）

- **I-1**（rate limit 對齊）：`/api/setup/init` 掛 `authLimiter`（15 分鐘 10 次）、跟既有 `/api/admin/setup` 一致；first-run 階段給使用者試錯空間、建好後 endpoint 自動 403、不會被暴力破解
- **I-2**（middleware 整合測試）：重構 `first-run-redirect.js` 成 factory `createFirstRunRedirect({ detectFirstRun })`、新增 `tests/first-run-redirect.test.js` 8 case 直接驗證場景 1/2/3 + 邊界 + fail-open
- **I-3**（race test 註解）：在場景 10 測試補註解、明確說「這層驗證的是 post-lock recheck、不是 advisory lock 本身」、列為未來 integration test 補充項
- **M-1**（dead code 清除）：拿掉 `firstRunRedirect` 中 `/api/*` 的 dead guard
- **M-2**（spec 修正）：場景 5 範例的 `id` 從 `"<uuid>"` 改為 `1`（PostgreSQL SERIAL 整數）、保留 `api_key` 為 UUID
- **M-4**（onclick 顯式 event）：`setup.html` 的 `copyApiKey()` / `copyInstallCmd()` 改 `(event)` 參數、不依賴全域 `event`

延後 v1.19.10 cleanup：
- **I-4**：bootstrap audit 改用 `actor_id=NULL` + `details.source='setup_wizard_bootstrap'`（需 audit reader 對齊調整）
- **M-3**：`shared/email-regex.js` 抽共用、給 `privacy-detect.js` + `setup.js` 共用
- **M-5**：`result.user` 防禦性檢查
- **M-6**：BCRYPT_ROUNDS 從 10 升 12
- **M-7**：HTTPS 執行時 guard（`req.protocol === 'http'` 拒絕）

**驗證：** `npm test` 1622 / 1622 全綠（v1.19.7 之後新增 27 個 case：setup wizard 19 + first-run-redirect 8）。

---

## v1.19.7 — IR-041 隱私偵測 + IR-002 密碼進 commit + reply-lint 切硬擋模式

**背景：** v1.19.6 把共用判定核心（rule-enforcer + bypass-handler）做好但沒接 hook；v1.19.7 是第一批真的擋下使用者的批次，落地三條：

1. **IR-041「不收集使用者隱私」** — reply-lint hook 在每輪 AI 回應結束時掃身分證／電子信箱／台灣手機樣式。例外（白話：什麼情況不算違反）：使用者自己 prompt 過的同樣字串視為主動分享、不擋
2. **IR-002「不要 commit .env 或密碼」** — pre-commit hook 整合 v1.19.1 `detectSecretLike`，除了既有檔名擋（`.env` / `*.pem` 等）再掃 staged diff 新增行內容，命中 OpenAI key / GitHub PAT / JWT / AWS key 等正規表達式樣式即擋
3. **reply-lint 切硬擋（exit 2）** — 違規累積到第 4 次時改 `process.exit(2)` + `stderr` 寫指令型重寫提示（取代 v1.19.3 的 stdout JSON 做法）；連續被擋 3 次後第 4 次違規降為 `exit 1` 警告防 AI 死循環

**新增：**

- `shared/privacy-detect.js` — 純函式 `detectPrivacyLeak(text, { userPrompts })`
  - 樣式：台灣身分證（含官方檢碼算式）／電子信箱（含 TLD 至少 2 字邊界檢查）／台灣手機（09 開頭 + 8 碼、過濾全同尾碼測試碼）
  - 使用者提問例外：命中字串若也出現在 `options.userPrompts` 任何一條裡即略過
  - 不丟例外、未知輸入回 `{ detected: false, matches: [] }`、好測試
- `hooks/ownmind-reply-lint.js` — 三大改動：
  - 加掛 `detectPrivacyLeak`（從 transcript 抽最近 5 輪 user message 作為例外比對來源）
  - 違規計數達門檻時、改 `process.exit(2)` + `process.stderr.write(reason)`，移除舊 stdout JSON 路徑
  - 新增 `BLOCK_DOWNGRADE_LIMIT=3`：連續 block 達 3 次後再違規降警告 `exit 1`、`compliance event` 改寫 `action='repeated_violation_softblock'`
  - 通過 lint 時自動 `resetBlockCount(sessionId)`、避免跨 turn 計數誤觸發降警告
- `hooks/lib/session-counter.js` — 擴 schema 加 `block_count` 與 `last_block_ts`
  - 新增 `readBlockCount` / `incrementBlockCount` / `resetBlockCount` 三個純函式
  - 對既有 v1.19.6 升上來的舊資料安全加欄位（不動 `count`）
- `hooks/ownmind-git-pre-commit.js`：
  - 引入 `parseBypass` / `isBypassed` / `logBypass`，每條規則處理前檢查 bypass、命中即跳過 + 寫 audit
  - 對 IR-002 額外掃 staged diff 新增行（`git diff --cached -U0`）跑 `detectSecretLike(line, { skip_keyword: true })`
  - 為什麼用 `skip_keyword=true`：原始碼很常出現 `password` / `secret` 變數名與字串字面值、開 keyword 會誤擋一般程式碼；只走 regex + length heuristic 才命中真實密鑰

**測試（npm test）：**

- 新增 `tests/privacy-detect-unit.test.js`（25 case）：身分證檢碼、信箱、手機、user prompt 例外、誤判防呆
- 新增 `tests/session-counter-block.test.js`（10 case）：`block_count` 累加 / 讀取 / 清零、與 `count` 獨立、毀損檔回 0
- 新增 `tests/reply-lint-hook-v197.test.js`（7 case）：場景 16 連續擋 3 次降警告、通過時 reset、場景 17 IR-041 整合與 user prompt 例外、block reason 不再列原個資
- 新增 `tests/pre-commit-secret.test.js`（13 case）：場景 1 `.env` 擋 / 場景 2 staged diff 含密鑰擋 / `OWNMIND_BYPASS=IR-002` / `=all` / 邊界情境
- 更新 `tests/reply-lint-hook-v1193-block.test.js`：把 stdout JSON 斷言改為 `exit 2` + stderr 重寫指令斷言（5 處）

**設計取捨：**

- **reply-lint 同時寫 tty banner 跟 stderr**：banner（給使用者看）走 tty 不被 AI 通道吃；stderr（給 Claude 看）只在 block 時寫，目的不同所以不衝突
- **block reason 不再列原個資字串**：IR-041 命中時提示「請改用代稱」而不複述命中值、避免 Claude 重寫又把個資帶一次
- **連續擋 3 次降警告**：用 `block_count` 獨立追蹤、與 `violation count` 分開，避免警告降級被一般違規累積干擾；通過時清零讓下個 turn 重新開始
- **pre-commit secret 偵測用 `skip_keyword=true`**：原始碼變數名出現 `password` / `token` 等英文詞是高頻場景、不能擋；regex + length heuristic 才能精準鎖真實密鑰
- **規則 `.env` pattern 字面比對**：實際雲端規則 patterns 為 `['.env', '*.pem', ...]`、`.env` 嚴格匹配；`.env.production` 等變體待 v1.19.10 觀察期看誤判紀錄調整

**Code review 採納事項（reviewer 一輪 6 個 Important + 1 個 Minor、全部處理）：**

- **I-1**（架構誠實）：reviewer 指出 README 寫「v1.19.7 wires rule-enforcer」但 hook 實際只 import `bypass-handler`、`evaluateConditions` 迴圈仍直接呼叫。三語系 README 改成「v1.19.7 only wires `bypass-handler`、full `enforceRule` integration deferred to v1.19.8」。本批次不做大重構、避免 v1.19.7 task 範圍外擴
- **I-2**（信箱白名單）：`shared/privacy-detect.js` 加 `EMAIL_ALLOWLIST_DOMAINS`（`example.com` / `example.org` / `example.net` / `localhost` / `.test` / `.invalid` / `.local`）跟 `EMAIL_ALLOWLIST_LOCAL`（`noreply` / `no-reply` / `donotreply` / `do-not-reply`）。連 `Co-Authored-By: Claude <noreply@anthropic.com>` 都會放行、避免兩週觀察期被噪訊蓋過真正洩漏訊號。補 10 個白名單測試 case
- **I-3**（避免 shell injection 跟 escape 漏洞）：`hooks/ownmind-git-pre-commit.js` 的 `git diff` 從 `execSync` 字串拼接改 `execFileSync('git', [...args, file])`、檔名當參數陣列傳。檔名含 `$` / 反引號 / 反斜線都安全
- **I-4**（README 措辭澄清）：英文 README 把「First 3 violations are warned only」改成「First 3 per-session violations are warned only（cumulative across turns, not per-turn）」明示是 session 累積、不是連續違規
- **I-5**（`formatBlockReason` 編號）：原本固定寫 `1.` / `2.` / `3.`、若只命中 IR-041 時 reason 從「3.」開始很怪。改 running counter 動態編號。補一個整合測試驗證單獨 IR-041 命中時編號從「1.」開始
- **I-6**（測試骨架腳註）：`tests/pre-commit-secret.test.js` 加註解寫明 `shared/*.js` 複製清單的維護條件、避免將來新增 import 時測試莫名失敗
- **M-1**（partial-failure window 文件化）：`hooks/ownmind-reply-lint.js` 違規路徑加註解、說明 counter / block_count / compliance event 寫入順序、及 SIGKILL 落在中間時的退化行為（觀測性殘缺、但 block 邏輯仍正確）

延後到 v1.19.8/v1.19.10 cleanup 的 reviewer 建議：M-2（`secret-detect.js` 從 `src/utils/` 搬到 `shared/`）、M-3（JSDoc 範例對齊）、M-4（label fallback）、M-5（`readRecentUserPrompts` 跟 `readLastAssistantText` 合併一次 I/O）。

**驗證：** `npm test` 1595 / 1595 全綠（review fix 多加 11 個 case：10 個信箱白名單 + 1 個 IR-041 編號）。

---

## v1.19.6 — Critical 鐵律卡控的共用判定核心（基礎建設、不擋任何規則）

**背景：** v1.19 給鐵律掛了 critical / default / advisory 標籤、但執行層仍跟 v1.18 一樣（看 `block_on_fail`）。v1.20 原本要一口氣把 10 條 critical 切到硬擋；Vin 拍板拆成 v1.19.6 ~ v1.19.10 漸進推、永遠停在 v1.19.x。

Gemini 對抗審查後三條被從候選剔除（降警告）：
- **IR-005**（不要 blind edit）— MCP 無狀態、user 手動點開檔案 hook 看不到、大量誤判
- **IR-008**（同步三文件）— 改錯字也擋會逼人塞廢話或關 hook
- **IR-048**（部署前查 DB migration）— 連外部狀態太脆、緊急修復會死

最終 10 條 + 漸進排程詳見 [v1.20 提案](openspec/changes/v1.20-iron-rule-enforcement/proposal.md)。

**v1.19.6 本批次只做基礎建設**：

- 新增 `hooks/lib/rule-enforcer.js` — 純函式 `enforceRule(ruleCode, context, options)` 入口
  - 內部包既有 `shared/verification.js` 的 `evaluateConditions`
  - 視 tier 決定 action：critical → block、default → 看 `block_on_fail`（向後相容）、advisory → log_only
  - fail-open：任何 throw 回 `action: 'allow'` + `reason: 'enforcer_internal_error'`、絕不卡死工作流
  - 純函式、無 fs / network / process.exit side effects、共用給三種 hook
- 新增 `hooks/lib/bypass-handler.js` — 放行通道
  - `parseBypass({ OWNMIND_BYPASS: 'IR-008,IR-024' })` 回 `Set`
  - `OWNMIND_BYPASS=all`（含大小寫變體 ALL / All）→ 涵蓋所有規則
  - `logBypass({ ruleCode, source, ... })` 寫一筆 `action: 'bypass'` 到 `compliance.jsonl`
  - process scope、不污染全域 / 不修改 env
- 擴充 `shared/compliance.js` schema 註解新增三個合法 action：`block` / `bypass` / `hook_internal_error`
  - schema 本身已支援任意 action 字串、本批次純註解同步

**測試：**

- 新增 `tests/rule-enforcer-core.test.js`（18 case）涵蓋：
  - 規則不在快取 / rules 非陣列 → fail-open
  - critical / default / advisory 三 tier 違反 → 對應 action
  - default + `block_on_fail=true` → block（向後相容）
  - 未知 tier → fallback default
  - bypass set 命中 / `all` / 沒命中 / 未提供 → 各路徑
  - `evaluateConditions` 真的 throw（用 getter 觸發）→ catch 回 fail-open `reason: 'enforcer_internal_error'`
- 新增 `tests/bypass-handler.test.js`（15 case）涵蓋：
  - 空 / 單條 / 多條 / 大小寫變體 ALL / 純逗號
  - `isBypassed` 命中 / 沒命中 / `all` / null set
  - `logBypass` 寫 audit、可選欄位 `commit_hash` / `session_id` / `failures`
  - ruleTitle 缺失 fallback
- 補 `tests/compliance.test.js` 3 case：action `block` / `bypass` / `hook_internal_error` 都能寫入 + 讀回

**驗證：** `npm test` 1524 / 1524 綠（既有 1521 + 新 47 - 重複部分）。沒任何既有 hook 被破壞。

**設計剝離原則：** v1.19.6 不接任何 hook、不擋任何規則；本層純粹是 v1.19.7+ 的零件供應商。

Gemini 對抗審查 + Claude 自評後修了 4 個 review 意見：
- **I-1**：違反路徑加 `reason: 'conditions_violated'`、跟 allow 路徑對稱、方便下游 hook 統一 audit
- **I-4**：fail-open catch path 改用 getter 真的 throw、避免測試名稱與實際路徑脫鉤
- **I-5**：`OWNMIND_BYPASS=ALL`（大寫）/ `All` 統一 normalize 成 `all`、避免緊急場景靜默失效
- **M-5**：`shared/compliance.js` schema 註解補上 block / bypass / hook_internal_error 三個新合法值

剩 8 條 Important / Minor（如 `enforceRules` 整批 miss 通報、benchmark、`decideAction` export）留 v1.19.7 接 hook 時順手處理。

---

## v1.19.5 — 修白名單 case-insensitive bug + 補真實踩坑漏字

**背景：** v1.19.4 預設翻 block 後立刻被 Vin 端對端測試踩到 v1.19.3 兩個 bug：
1. **case-insensitive bug**：v1.19.3 寫 `TECH_WHITELIST.has(w.toLowerCase())` 看似有 normalize、但 Set.has 是精確字串比對。白名單存 `Claude` (PascalCase)、查 `claude` (lowercase) 都 false、漏判。Vin 開新 session 自我介紹「我是 claude」、claude 漏判觸發違規
2. **漏加白名單**：`terminal`（Vin 收到的 block reason 列的詞）、`bump`（我寫「bump 版號」也被擋）、加上 v1.19.4 測試 prompt 暴露的一堆技術詞

**修法：**

- `shared/language-lint.js`：
  - 建構 `TECH_WHITELIST_LOWER`（全 lowercase）一次、查詢統一 `LOWER.has(w.toLowerCase())`
  - 補 30+ 個漏字：
    - shell / IDE 周邊：`terminal, shell, console, stdout, stderr, tty`
    - 發版動詞：`bump`
    - v1.19.4 測試暴露：`Suspense, Concurrent, Pod, Saga, Envoy, Istio, sidecar, kubernetes, monad, functor, applicative, observable, mergeMap, switchMap, concatMap, combineLatest, ajax, fromEvent, subscribe, pipe`
    - 微服務 / 函式編程：`choreography, orchestration, orchestrator, Maybe, Either, Just, Nothing, hydration, reactive`

**新增測試** `tests/language-lint-v1195.test.js`：
- 4 case 直接驗 case-insensitive bug（claude / CODEX / cursor 都該被白名單吸收）
- 22 case 驗每個新加詞在白名單
- 3 case 真實踩坑回歸（Vin 收到的 reason 詞、v1.19.4 測試 prompt 全部技術詞、bump）

**測試結果：** 134 case 全綠（v1.19.5 新加 29 + 既有 105）。

**為什麼這麼快又出 v1.19.5：**
- v1.19.4 預設 block 一翻、bug 立刻暴露（如預期）
- 漸進緩衝 + opt-out 機制讓 user 不會被擋死、但快速回饋促成快速修補
- 這就是 IR-027「邏輯才有效」的好處：擺著的規則 user 不會踩、卡控的規則 user 一定踩到、bug 才會被看見

---

## v1.19.4 — Reply-lint 預設翻成 block（v1.19.3 設 opt-in 違反 IR-027）

**背景：** v1.19.3 雖然把漸進式 block 機制蓋好、但預設 `OWNMIND_REPLY_LINT_MODE=warn`、要 user 主動設環境變數 `block` 才生效。Vin 立刻抓到問題：「為何不直接打開 block？」——這就是 IR-027「邏輯才有效」失效。Vin 不會主動 opt-in、預設不打開等於沒落地、v1.19.3 等於白做。

**修法：1 行 default 改動。**

- `hooks/ownmind-reply-lint.js`：`RAW_MODE` 預設值 `'warn'` → `'block'`
- 不喜歡 block 的 user 改設 `OWNMIND_REPLY_LINT_MODE=warn` opt-out（退回 v1.19.3 預設行為）
- 漸進緩衝（前 3 次警告、第 4 次才擋）保留、所以即使誤判也有 3 次容忍空間

**為什麼這次直接翻、不再保守：**

1. v1.19.3 白名單已從 80 詞擴到 200+ 詞、Top 30 違規詞 95% 被吸收、誤判源頭已修
2. v1.19.3 加 proper noun 偵測（`^[A-Z][a-z]+$` 大寫開頭詞自動跳過）、人名 / 公司名不會被當違規
3. v1.19.3 加 threshold 分情境（含 code 25%、code review 豁免）、IR-036 視窗 50→80
4. **漸進式 4 階段本身就是緩衝**、第 1 次誤判只警告、不會直接毀對話
5. v1.19.3 smoke test 20/20 通過（用實際裝在 `~/.ownmind/` 的 hook + 真實 Stop hook payload）

**新增測試 2 case：**
- `tests/reply-lint-hook-v1193-block.test.js`：「v1.19.4 — 預設 MODE=block」suite
  - 未設 env、連續 4 次違規 → 第 4 次仍會寫 block JSON（驗預設真的是 block）
  - MODE=warn opt-out、連續 4 次違規 → 永遠不寫 block JSON（驗 opt-out 有效）

**測試結果：** 105 case 全綠（103 v1.19.3 既有 + 2 新加）。

**Vin opt-out 指引：** 若新 block 行為太煩、設 `OWNMIND_REPLY_LINT_MODE=warn` 環境變數（例如寫進 `~/.claude/settings.json` 的 mcpServers.ownmind.env 或 shell rc 檔）退回 v1.19.3 預設行為。

---

## v1.19.3 — Reply-lint 漸進式 block + 白名單擴 200+ 詞 + threshold 分情境

**背景：** OwnMind SessionStart hook 帶 5 條「強制注意」、其中 IR-037（中英混雜）/ IR-036（行話沒解釋）/ 解說偏好對當前 AI 違反率 100%——警告對 AI 完全無效、user 看到也只能下次注意。對應 IR-027「邏輯才有效」失效。

**修法概覽：** 從「只警告」升級為「漸進式 block」、但同時做了多項配套避免直接擋下時誤殺正常對話。

**核心機制（4 件套）：**

1. **`OWNMIND_REPLY_LINT_MODE` env 切換**
   - `warn`（**預設**）：行為跟 v1.19.2 完全一樣、只寫 terminal 招牌、永遠不擋（向後相容）
   - `block`：opt-in 啟用漸進式 block
   - `disable`：完全跳過（等同 `OWNMIND_REPLY_LINT_DISABLE=1`）
   - 未知值 fail-open 到 `warn`、招牌會多一行提示

2. **漸進式累積（MODE=block 時）**
   - session 內前 3 次違規只警告、第 4 次才寫 `{"decision":"block","reason":"..."}` 到 stdout
   - Claude Code 收到 block JSON → 把 reason 當下個 prompt 餵 Claude、Claude 重寫上一則回應
   - 計數存 `~/.ownmind/logs/reply-lint-session-counter.json`、30 天前自動清
   - 防迴圈：`stop_hook_active=true`（Claude Code 在重寫又觸發 Stop 時帶的 flag）會被偵測、hook 立刻退出、計數不增；Claude Code 內建另有 8 次連續 block 上限

3. **白名單從 80 詞擴到 200+ 詞**（基於 30 天 audit Top 30 真實違規詞）
   - 大公司 / 平台名：Google、Meta、OpenAI、Chrome、OAuth、YouTube、Imagen、Llama 等 35+ 詞
   - Vin 個人專案名：adog、fapa、fontrip、ring、ownmind、auto、speech、ima、funit 等
   - Git / dev 流程詞：main、origin、branch、worktree、commits、hook、Hook、review、prod、spec、prompt、tasks、tests、pipeline、Pipeline、Stage、chunk、monorepo、render、retry、batch、async、await、middleware、dispatcher、payload、handler、router 等 80+ 詞
   - 常見技術概念：promise、callback、queue、lock、debounce、polling、cache、timeout 等 25+ 詞

4. **Threshold 分情境**
   - 一般對話：15%（維持）
   - 含 code block（偵測 \`...\` 或 \`\`\`）：放寬到 25%
   - 含「code review / code-review」字眼：直接豁免
   - IR-036 解釋查找視窗從 50 字擴到 80 字（Codex 對抗審查指出中文語境 50 字太短）
   - Proper noun 偵測：大寫開頭孤立詞（`^[A-Z][a-z]+$`、例：Eric、Phoebe、Google）視為人名 / 公司名、跳過

**新增鐵律：** 無（v1.19.2 已加 IR-048、本版只動 hook 行為、不需新鐵律）

**新增測試 73 case：**
- `tests/language-lint-v1193.test.js` 55 case：白名單 Top 30 詞、proper noun、threshold 分情境、code review 豁免、IR-036 視窗
- `tests/session-counter.test.js` 10 case：純函式 + 防呆（檔不存在 / 毀損 / 30 天自掃 / 無權限）
- `tests/reply-lint-hook-v1193-block.test.js` 8 case：MODE=warn / block / disable / 未知值、漸進累積、stop_hook_active 防呆、reason 指令型

**對應規格：** `openspec/changes/v1.19.3-reply-lint-progressive-block/{proposal,spec,tasks}.md`

**設計過程（重要）：**
- 走完 Codex `codex-rescue` subagent 對抗審查、抓到 5 大破口（hook 哲學跟 block 衝突、Claude Code spec 沒實證、跨工具相容、subagent transcript path、Superpowers code review 大量誤殺）
- 用 `claude-code-guide` subagent 實證 Claude Code 官方 Stop hook block 規格
- 30 天 jq audit 找 Top 30 違規詞、量化擴白名單
- 不直接 block 預設（opt-in）+ 漸進式（前 3 次警告緩衝）= 雙保險避免誤殺對話

**後續計畫：** Vin 跑 1 週 warn 模式 audit、確認誤判率降到可接受才考慮翻 `block` 為預設。

---

## v1.19.2 — DB Migration 自動套用 + schema_migrations 追蹤表

**背景：** 2026-05-22 中午發現 v1.19.1 prod 所有 `ownmind_save` 回 500 `column "tier" does not exist`。追查發現 v1.19.0 的 `db/014_iron_rule_tier.sql` commit 進 repo 但沒人手動跑到 prod DB、整支 memory API 對 INSERT/UPDATE 全炸。對應 IR-027「邏輯才有效」失效——靠人記得跑 SQL 就是會漏。

**核心修法：把 migration 從「人工檢查」改成「server 啟動時自動套用」。**

**三件套：**

1. **`db/015_schema_migrations_table.sql`** — 追蹤已套用 migration 的表（filename PK + applied_at + applied_by）。用 `IF NOT EXISTS` + `ON CONFLICT DO NOTHING` 確保重跑安全、self-record 自己 filename 避免下次再被誤判。
2. **`src/utils/run-migrations.js`** — Node 版自動 runner、在 `src/index.js` 的 `app.listen()` 前跑。掃 `db/[0-9][0-9][0-9]_*.sql`、比對 `schema_migrations` 表、跑沒套過的、寫一筆紀錄。任何一條失敗就 `throw` → `process.exit(1)`、container 不會 listen（避免新 code 配舊 schema 對外服務）。
3. **`scripts/run-migrations.sh`** — Bash 版手動 / CLI runner（dev 環境 / fresh deploy debug 用）。支援 docker exec 或直連 psql、INFO/OK/ERROR 輸出格式跟 bootstrap.sh 一致。

**整合點：** `src/index.js` 改成 async `start()`、`await runMigrations()` 後才 `app.listen`。Vin 既有的「git pull → docker compose build → docker restart api」工作流不變、第 3 步自動套 migration。

**Prod backfill：** 既有 14 條 migration (001~014) 已透過 `INSERT INTO schema_migrations(filename, applied_by) VALUES (..., 'backfill')` 一次性 backfill、所以新版上線後 runner 看到 15 條全套用、什麼也不做、純驗證 idempotent。

**新增鐵律 IR-048：** deploy OwnMind / RING / 任何 server 前必須跑 db/ 下所有未套用 migration（人工版本、適用所有專案）。本版 OwnMind 自動化後、IR-048 在 OwnMind 場景降為 advisory、但對 RING / fapa / ima 等專案仍是 default 強度。

**新增測試 22 case** — 涵蓋 SQL idempotent、bash runner 結構、Node migrator 行為、src/index.js 整合順序。

**對應規格：** `openspec/changes/v1.19.2-auto-migration/{proposal,spec,tasks}.md`

---

## v1.19.1 — 密碼／Token 不寫進記憶、AI 自動走 set_secret

**背景：** 2026-05-18 Vin 嘗試用 ownmind_update 存好好玩 FUNIT 的 WordPress 應用程式密碼、記憶 API 回 500「更新記憶失敗」黑盒、AI 不知道分流規則。對應 IR-027「提醒無效、邏輯才有效」的失效情境——光在記憶系統提示「密碼請走密鑰管理」是不夠的、要靠程式邏輯卡控。

**三層防護：**

1. **MCP 工具描述警語**（階段 D）— `ownmind_save` / `ownmind_update` description 開頭加「⚠️ 含密碼／token／API key 等敏感資料請改用 ownmind_set_secret、不要寫進記憶」。AI 在挑工具當下就讀到分流規則、不需要踩到錯誤才知道。
2. **伺服器偵測**（階段 A + B）— 記憶 API 寫入前跑 `detectSecretLike` 偵測：5 條 regex（WP App Password / JWT / GitHub PAT / AWS / OpenAI）+ 英中混合 keyword + 長度啟發式（≥20 字純英數字、無 CJK）。命中即回 400 + `{ hint, redirect_tool: 'ownmind_set_secret', detected_by }`。narrative 類型（iron_rule / principle / coding_standard / team_standard / session_log）跳過 keyword 偵測、但仍跑 regex、避免討論密碼主題的記憶被誤擋。
3. **新增 IR-047**（階段 E）— 「敏感資料一律走密鑰管理工具、不寫進記憶／對話／程式碼提交」、tier=critical、跨「記憶／對話／git 提交」三個通道的統一規則。

**附帶改造：** 把記憶 API 既有的 catch-all 500「更新記憶失敗／建立記憶失敗」拆成依錯誤類別分流的 400 / 409 / 503 / 500（階段 C）：

- PostgreSQL 約束違反（23xxx）→ 400 + hint（含 not_null / foreign_key / check_violation）
- 資料重複（23505）→ 409「資料重複」
- 連線錯誤（08xxx / ECONNREFUSED）→ 503「請稍候重試」
- JS SyntaxError → 400「資料格式錯誤」
- 其他未分類 → 500 + log stack 給除錯
- 4xx 用 logger.warn、5xx 用 logger.error 分流

之前 Vin 踩到的 500 黑盒、現在加上偵測會變成 400 + 明確 redirect_tool、AI 一看就知道下一步該怎麼走。

**Bypass：** `metadata.allow_secret_like: true` 跳過偵測 + 寫 `metadata.lint_warnings` audit entry（type: 'bypass_secret_detect'、含 timestamp）。給「我在 1Password 存了 key、想記指向位置」這種情境用。

**測試：** 新增 81 個 case 涵蓋偵測、API 整合、錯誤分類、MCP 警語。

| 測試檔 | case 數 |
|---|---|
| tests/secret-detect-unit.test.js | 26 |
| tests/memory-secret-guard.test.js | 24 |
| tests/memory-error-classifier.test.js | 21 |
| tests/mcp-tool-description-secret-warning.test.js | 10 |

---

## v1.19.0 — 鐵律分級制（Critical / Default / Advisory）

**背景：** v1.18.9 時鐵律已累積 41 條（IR-002 ~ IR-042），告警疲勞已發生（單次 session 啟動可跳 13 條回話品質 lint 警告）、重要規則被次要規則稀釋、IR-027「提醒無效、邏輯才有效」失效。本版埋下分級資料層、不動執行邏輯；v1.20 起依分級改卡控行為。

詳見 `openspec/changes/v1.19-iron-rule-tier/proposal.md`。

### 1. 分級設計

| 級別 | 中文 | 違反處理（v1.19） | 違反處理（v1.20 後） |
|------|------|--------------------|----------------------|
| `critical` | 核心硬規則 | 跟 default 相同（本版不動執行邏輯） | 直接卡控 |
| `default` | 預設規則 | 跳警告 + 寫違反紀錄 | 不變 |
| `advisory` | 純參考提示 | 跟 default 相同（本版不動執行邏輯） | 只寫紀錄、不跳警告 |

### 2. 資料庫變動：`db/014_iron_rule_tier.sql`

- `memories` 加 `tier VARCHAR(20) DEFAULT 'default'` + CHECK constraint
- 部分索引 `idx_memories_iron_rule_tier`（只覆蓋 `type='iron_rule'`）
- 既有 41 條鐵律 migration 後全部為 `'default'`

### 3. 新檔（純函式）

| 檔案 | 用途 |
|------|------|
| `shared/iron-rule-tier.js` | tier 常數、validation、emoji、排序、分桶 |
| `src/utils/iron-rule-tier-validator.js` | server route 用的請求驗證 + 寫入兜底 |
| `src/utils/iron-rule-digest.js` | `buildIronRulesDigest` + `countByTier` |
| `hooks/lib/build-compliance-events.js` | reply-lint 違反事件組裝（v1.19 details 加 tier） |

### 4. 改動

- `src/routes/memory.js` POST/PUT 接受 tier 欄位、寫進 DB
- `src/routes/memory.js` `/init` 回傳 `iron_rules_tier_counts` 結構化計數
- `src/routes/admin-iron-rule-upgrade.js` `/upgrade-status` 回 tier
- `mcp/index.js` `ownmind_save` / `ownmind_update` schema 加 tier 參數
- `hooks/lib/render-session-context.js` 鐵律段標題加 tier 分佈 summary
- `hooks/ownmind-session-start.js` 經由 init API 自動顯示按 tier 分組
- `hooks/ownmind-reply-lint.js` violation event details 加 tier
- `hooks/ownmind-git-post-commit.js` violation event details 加 tier
- `shared/compliance.js` `appendCompliance` 接受 entry.tier
- `src/public/index.html` 鐵律升級助手列表加 tier dropdown（inline 編輯、PUT /memory/:id）

### 5. 拍板紀錄（2026-05-14）

| # | 議題 | 拍板 |
|---|------|------|
| 1 | 幾級分類 | 3 級：Critical / Default / Advisory |
| 2 | Critical 名單（10 條） | IR-002 / 005 / 008 / 009 / 012 / 024 / 027 / 031 / 038 / 041 |
| 3 | migration 預設值 | 全部設為 `default`、發版後 admin UI 手動升 Critical |
| 4 | Advisory 名單時機 | v1.19.1 hotfix 處理、本版先讓所有非 Critical 維持 default |
| 5 | 本版是否包含執行邏輯卡控 | 否、純資料層 + UI、卡控等 v1.20 |

### 6. 跨工具相容

- 舊客戶端讀不到 tier 欄位也不會壞（JSON 多一個欄位）
- SessionStart hook 對舊 server（沒回 `iron_rules_tier_counts`）自動 fallback 到舊版格式
- `getTierFromRules()` 找不到規則 / 規則無 tier / 非法值一律回 `'default'`

### 7. 測試覆蓋

- 9 個新測試檔、約 60 個新測試案例
- 全套 1275 個測試零紅燈、零回歸
- 純函式優先：tier validation、digest 組裝、compliance event 組裝都是 testable 純函式

### 8. 發版前 Vin 必跑

- 跑 014 migration on dev DB、確認既有 41 條鐵律 tier 全部是 default
- 部署後 browser 實測（IR-020）：admin UI 鐵律升級助手 → tier dropdown 改值 → 列表立即反映
- 在 admin UI 把 10 條 Critical 鐵律手動升級
- 跑驗收 SQL：`SELECT tier, COUNT(*) FROM memories WHERE type='iron_rule' GROUP BY tier`、預期 critical=10、default≈30、advisory=0

---

## v1.18.9 — MCP 工具 latency 埋點（v1.18.6 漏作補）

**背景：** v1.18.5 原本是大型 release（誤殺回饋按鈕 + 4 種安全告警 + 健康度分頁 + latency 埋點），實作過程經歷 3 次棄用後，最終只剩 latency 埋點。詳見 `openspec/changes/archive/v1.18.9-mcp-latency-tracking/proposal.md`。

### 1. `mcp/lib/log-mcp-call.js` 新增

`logMcpCallSafe({ logEvent, tool, latencyMs, status })` — 安全寫一筆 `mcp_call` event。任何 `logEvent` 失敗都被吞掉、不阻塞 tool call 主流程。

跟 `enrich-error.js` 同 pattern：純 module、好測。

### 2. `mcp/index.js` setRequestHandler 主流程埋點

```js
const startedAt = Date.now();
try {
  const result = await handleTool(name, args || {});
  ...
  // 成功 path 寫 mcp_call event 含 latency_ms
  logMcpCallSafe({ logEvent, tool: name, latencyMs: Date.now() - startedAt, status: 'ok' });
  return composeToolResponse({...});
} catch (error) {
  // 失敗 path：error event 加 latency_ms + 另寫 mcp_call status=error
  const latencyMs = Date.now() - startedAt;
  logEvent('error', { ...enrichErrorDetails(error, name, args), latency_ms: latencyMs });
  logMcpCallSafe({ logEvent, tool: name, latencyMs, status: 'error' });
  ...
}
```

量「user 看到 result 的真實感受時間」、含 broadcast fetch / autoComply / composeToolResponse 全環節。

### 3. `tests/log-mcp-call.test.js` 新增（6 cases）

涵蓋：payload 對 / null tool fallback / logEvent throw 不 escalate / latency_ms 是 0 也照寫。

跑：`node --test tests/log-mcp-call.test.js` → 6 pass / 0 fail。

### 4. 設計棄用紀錄（詳見 proposal.md）

本 release 原規劃內容三次棄用：
- block_feedback 誤殺回饋（part 2）— 網頁端要登入違反「按一次 1 秒完成」拍板
- 4 種安全告警偵測（part 3）— OwnMind 個人用 ROI 不夠
- 健康度分頁（part 3）— 剩單一指標不值得做新分頁

git 歷史保留 commit 8bcfc69（block_feedback server core）+ commit 127b740（safety detect/audit）作「曾嘗試」紀錄。

### 5. 衍生學習

`profile`（id=3）加「解說偏好」段落 + 自我檢查黑名單清單。Vin 兩次踩坑（part 1 五題拍板 + part 2 block_feedback 三方案）證明 AI 在解釋實作障礙時容易回到術語模式、必須有清單機制 enforce「真實情境解說」。

## v1.18.8 — error helper 抽出 + unit test 補完 + 健康度日報 launchd 排程

### 1. `mcp/lib/enrich-error.js` 抽出（v1.18.6/7 重構）

v1.18.6 inline 在 `mcp/index.js` 的 `enrichErrorDetails` 拆到獨立 module、加 `errorAliasFields` 共用 helper：

- `errorAliasFields(error)`：純 error → 結構化欄位（`error_message`、`error_name`、`error_code?`、`stack?`、`http_status?`）
- `enrichErrorDetails(error, toolName, args)`：包 `errorAliasFields` + 加 `error`（向後相容）+ `tool_name` + `payload_summary`
- v1.18.7 `update_failed` event 重構成 `{ source, step, error: e.code||e.message, ...errorAliasFields(e) }`、不再 inline 拼欄位

行為向後相容、單純為 testability + DRY。

### 2. `tests/enrich-error.test.js` 新增（25 cases）

涵蓋：
- 基本欄位（Error / TypeError / string / null）
- stack 截短到 5 行
- http_status regex（API 4xx/5xx 抓得到、非 API 不出現）
- payload_summary 隱私邊界（title/content 只記長度不記內容、tags 只記數量）
- id === 0 不被 falsy check 過濾
- 向後相容（error 跟 error_message 鏡像一致）
- `errorAliasFields` 獨立行為 + update_failed 情境整合測試

跑：`node --test tests/enrich-error.test.js` → 25 pass / 0 fail。

### 3. `scripts/launchd/com.ownmind.health-report-daily.plist` 新增

每天早上 09:00 自動跑 `scripts/health-report-daily.sh`、輸出到 `~/.ownmind/reports/health-YYYY-MM-DD.md`。

僅 admin / 維運者使用、不進 user install 流程。手動安裝：
```bash
sed "s|{HOME}|$HOME|g" ~/.ownmind/scripts/launchd/com.ownmind.health-report-daily.plist \
  > ~/Library/LaunchAgents/com.ownmind.health-report-daily.plist
launchctl load -w ~/Library/LaunchAgents/com.ownmind.health-report-daily.plist
```

### 4. 新鐵律 IR-042

「加 npm 依賴必須同步更新 user-facing install/update 腳本」— v1.18.5 IR-007 同類失敗第 4 次（dev/prod 環境 mismatch）沉澱出來的具體鐵律。

content 在 OwnMind 雲端（不在 git）、tags: `trigger:edit / package_json / new_dependency / import`。

## v1.18.7 — update_failed event 同步補 error 結構化欄位

v1.18.6 補了 MCP tool exception 的 `error` event 結構化欄位、但同檔還有另一個 error 寫入點：`update_failed`（auto-update lock 取不到時觸發、`mcp/index.js:1324`）也只記 `{ source, step, error: e.code || e.message }`、跟 `error` event 屬同類觀測缺口。

直接 inline 補 alias 欄位（**不用 enrichErrorDetails、因為語意不同：update_failed 沒 args 概念、不該帶 payload_summary**）：
- `error`：保留原 fallback 邏輯 `e.code || e.message`、向後相容
- `error_message`：純 `e.message`、結構化命名一致
- `error_code`：保留 syscall code（如 `'EEXIST'`）
- `error_name`：Error class
- `stack`：截短到前 5 行（可選、stack 存在才加）

**永遠教訓**：改 source code 時 hook 強制要求 README/CHANGELOG/FILELIST 全部 stage、不分情境（IR-026/IR-008/IR-031/IR-032 串聯）。原本想當 v1.18.6 follow-up commit 但被擋下、改成獨立 v1.18.7 micro release。

## v1.18.6 — Error 事件觀測缺口補完

**背景**：Vin 看健康度日報時提「server 端 error 事件 error_message 都是空」、查 prod 確認觀測缺口屬實但根因不同。

### 真實狀況

過去 30 天 57 件 `event='error'` 紀錄：
- ✅ `details.error` 100% 有內容（API 錯誤訊息字串）
- ✅ `details.tool_name` 100% 有（哪個 MCP 工具失敗）
- ❌ `details.error_message` 0 件（命名不一致、Vin 觀察的查詢條件用這個）
- ❌ 沒 `stack` / `http_status` / `payload_summary` / `error_name`

根因：`mcp/index.js:1223` 只記 `{ tool_name, error: error.message }`、其他結構化欄位全缺。

### 修法

新增 `enrichErrorDetails(error, toolName, args)` helper、寫進 `mcp/index.js`：

| 欄位 | 說明 | 例子 |
|---|---|---|
| `error` | 向後相容（v1.17.x~v1.18.5 用這名） | `"API 400: 鐵律品質檢查失敗"` |
| `error_message` | v1.18.6 新增、結構化命名一致 | 同上 |
| `error_name` | Error class 名稱 | `"TypeError"` / `"Error"` |
| `tool_name` | MCP 工具名 | `"ownmind_save"` |
| `stack` | 截短到前 5 行的 call stack | `"Error: ...\n  at handle..."` |
| `http_status` | 從 `^API NNN:` regex parse | `400` / `409` |
| `payload_summary` | args 結構（不洩漏敏感內容、只記 type/code/length） | `{ type: 'iron_rule', code: 'IR-099', title_length: 4, content_length: 300, tags_count: 2 }` |

### 隱私邊界

`payload_summary` 只記**結構性 metadata**：
- ✅ 記：args.type / args.code / args.id / title 字數 / content 字數 / tags 數
- ❌ 不記：args.title 內容、args.content 內容、args.tags 細節
- 避免 error log 變成 user 私人資料外洩管道

### 向後相容

- 舊欄位 `error` 保留、舊 query / dashboard 全部還能用
- 新欄位「自當下起」累積、舊事件不回填
- 任何 SQL `details->>'error_message'` 從這版起就有資料

### 驗證

inline node 跑 helper 三種情境（API error 帶 args / TypeError 沒 args / 純字串 error）— 都正確產出、不會 throw。


## v1.18.5 — Hotfix: big skill sync 從 v1.18.0 上線就壞了

**背景**：v1.18.4 把 3 條死規則（IR-004/006/026）重寫成具體動作後、驗證新版有沒生效時、發現 `~/.claude/skills/ownmind-iron-rules/SKILL.md` 和 `references/*.md` 從沒被更新過（mtime 14:26、3 條鐵律 update 是 17:34+）。深查暴露 v1.18.0 上線就有的 silent bug。

### Root Cause

`hooks/lib/conditional-sync-cli.js` 在 module top-level static import：
```js
import { syncToAllTools } from '../../src/utils/iron-rule-sync.js';
```

但 `iron-rule-sync.js` → `iron-rule-frontmatter.js` → `js-yaml`、`js-yaml` 在 root `package.json` dependencies。

User install 流程只在 `~/.ownmind/mcp/` 跑 `npm install`、root 依賴**從沒被裝過**、`~/.ownmind/node_modules/js-yaml` 不存在。

結果：每次 SessionStart hook 呼叫 `conditional-sync-cli.js`、整個 Node module 在 load 階段就拋 `ERR_MODULE_NOT_FOUND`、stdout 印空字串、bash 端走 fallback 拉 init data — 但 **big skill sync 那段 code 根本沒機會跑**、`syncToAllTools` 永遠沒被呼叫。

**後遺症（從 v1.18.0 上線 6 天）**：
- 所有 user 端的 `~/.claude/skills/ownmind-iron-rules/` 內容凍結在 install 那一刻
- 鐵律改動只在 server / MCP cache / SessionStart additional context 生效
- 但 AI 透過 `ownmind-iron-rules` skill 讀的、永遠是舊版

### 修法

**1. `hooks/lib/conditional-sync-cli.js` — dynamic import 防護**

把 `syncToAllTools` 從 top-level import 移到 `if (result.refreshed)` 區段內、加 `await import(...)`。
失敗時被外層 try/catch 抓住、log 後 silent skip、cache + stdout init data 仍正常 work。

**2. `scripts/update.sh` + `update.ps1` — 自動補裝 js-yaml**

在 sync 主流程開頭加 idempotent check：
```bash
if [ ! -d "$OWNMIND_DIR/node_modules/js-yaml" ]; then
  cd "$OWNMIND_DIR" && npm install js-yaml@^4.1.1 --no-save --silent
fi
```

`--no-save` 不污染 package.json、`--silent` 不刷屏、idempotent 重跑安全。

### 驗證

修完手動裝 js-yaml → 跑 conditional-sync-cli → sync.log 新增「sync 36 rules — written: [claude,windsurf,codex,opencode,gemini]」→ 3 個 reference 檔 mtime 從 14:26 → 17:49 → IR-004 reference 確認含新版「## 觸發時機（具體動作）」段落。

**永遠教訓（IR-007 重犯第 4 次）**：
- 加新模組依賴時、必須同時更新所有 user-facing install / update 腳本
- 用 static import 從 root deps 是 user-facing client code 的地雷（user 端 install 流程跟 dev 不同）
- 對 user-facing CLI、優先用 dynamic import + try/catch、提供 graceful degrade

### 順帶發現

User install 流程跟 dev 工作流的依賴管理脫節是設計層議題、應該：
- 把 client-side 依賴拆獨立 package（`mcp/` 已是這個模式）
- 或 root `package.json` 區分 `dependencies` (server only) 和 `clientDependencies` (user CLI 用)
- 列入 v1.19+ 重構 backlog

## v1.18.4 — 產品健康度日報雛形 + tool='unknown' fallback 修正

**背景**：Vin 提產品品質追蹤需求、走 Gemini r1/r2/r3 三輪 review 後、選擇路線 C「先用 SQL 探勘真實 telemetry 資料、再決定指標」。實作過程順手抓到一個 6 個月沒被發現的小 bug。

### 新增：產品健康度日報雛形

`scripts/health-report-daily.sh`：bash 腳本、SSH 進 prod 跑 6 條 SQL、輸出健康度日報。**只看絕對數字、不算比例**、避免冷啟動樣本不足下被分母為 0 / 百分比波動劇烈誤導。

報告涵蓋：
- 過去 7 天違反/遵守/跳過絕對件數
- 觸發鐵律覆蓋數（vs 啟用鐵律總數）
- 過去 7 天違反明細（按鐵律切）
- 過去 7 天觸發但 0 違反的「靜默生效」鐵律
- **過去 30 天 0 觸發的「死規則」**（可能是保險用、可能是設計問題）
- 各 tool 觸發分布
- 異常事件件數（排除 unknown_model）

用法：`bash scripts/health-report-daily.sh > reports/health-$(date +%F).md`

### 修正：tool='unknown' fallback bug

第一次跑日報就抓到 229 筆 `tool='unknown'` 事件、追到根因：

- `mcp/ownmind-log.js:7` fallback 預設 `'unknown'`
- `mcp/index.js:245` 同樣預設 `'unknown'`
- 但 `mcp/index.js:167` `CLIENT_TOOL` 預設 `'claude-code'`

兩個 env var (`OWNMIND_TOOL` vs `OWNMIND_CLIENT_TOOL`) 名稱不一致、預設值不一致、user 沒設 env var 時就 fallback 到 'unknown'、導致跨工具分群指標失效。

修法：兩個檔案都改成 `process.env.OWNMIND_TOOL || process.env.OWNMIND_CLIENT_TOOL || 'claude-code'`，向後相容、user 已設的不受影響。

**永遠教訓**：env var fallback 預設值要跨檔案統一、不要每個檔自己決定。

### Bonus：13 條死規則分析

跑日報順便看到 35 條啟用中鐵律有 13 條過去 30 天 0 觸發：
- 4 條正常保險用（IR-013/016/017/033）— 不動
- 4 條 trigger 太寬鬆（IR-010/011/029/030）— 待調 trigger
- **3 條規則太抽象 AI 無法判斷觸發點（IR-004/006/026）— 待重寫**
- 2 條過新等樣本（IR-039/040）

詳細處理建議見 Vin 個人 backlog。

## v1.18.3 — Hotfix: lint metadata 漏餵 + reply-lint Stop hook 漏裝

**背景**：v1.18.2 完成後 Vin 罵「我老是提醒你、講到行話要做解釋說明、例如 dogfood 這種你應該要講清楚」— 觸發 IR-036（行話必須附白話說明）違反、深查暴露 2 個 v1.18.2 漏洞：

### 漏洞 1：reply-lint Stop hook 沒擋我用 dogfood

Audit 發現：
- `~/.claude/settings.json` 的 hooks 完全沒 `Stop` 欄位
- `~/.ownmind/hooks/ownmind-reply-lint.js` 檔案存在但沒被 register
- 根因：v1.17.96 install.sh 有加 `add-stop-hook.cjs`、但 `update.sh` / `update.ps1` 沒呼叫
- 既有 user (Vin 的機器就是) 升級 v1.17.95 → v1.17.96 → ... 從沒裝過 Stop hook
- reply-lint 機制 v1.17.96 上線「形同未啟用」6 個版本 (v1.17.96 → v1.18.2)

**修法**：
- `scripts/update.sh` 加 `add-stop-hook.cjs` + `add-post-tool-use-hook.cjs` 呼叫 (idempotent)
- `scripts/update.ps1` 同步補
- 立即手動補 Vin 機器：`node add-stop-hook.cjs ~/.claude/settings.json --ownmind-dir ~/.ownmind` → 已 register

### 漏洞 2：lint 沒收到 metadata、誤報「沒帶 origin_context」

`src/routes/memory.js` POST/PUT + `admin-iron-rule-upgrade.js` PUT 三個 handler call `lintIronRule({title, content, tags})` 都沒帶 `metadata`。

但 v1.18.2 加的 `checkOriginContext(rule)` 看 `rule.metadata.origin_context` — 收不到 metadata、永遠以為沒帶、永遠 warning。

實證：IR-040 (id=367) update 後、metadata 明明有 origin_context 完整 7 欄、response 仍出現 `lint_warnings: ['建議補 metadata.origin_context...']`。

**修法**：3 個 lintIronRule call 都加 `metadata`：
- POST: `lintIronRule({ title, content, tags, metadata })`
- PUT: `merged.metadata = metadata !== undefined ? metadata : oldMemory.metadata`
- admin upgrade: `lintIronRule({ title, content, tags, metadata: oldRule.metadata })`

**新增 / 改動**:
- `src/routes/memory.js`: POST + PUT lintIronRule call 加 metadata
- `src/routes/admin-iron-rule-upgrade.js`: PUT lintIronRule call 加 metadata
- `scripts/update.sh` / `update.ps1`: 補 add-stop-hook + add-post-tool-use-hook idempotent re-register
- `tests/iron-rule-origin-context.test.js`: +3 regression test (lint 收到 metadata 才不誤報)

**測試**: 1176 → 1179 (+3)

**鐵律觸發**: IR-006 / IR-007 (重複漏 hook 安裝、user 端 client 跑舊行為) / IR-008 / IR-022 / IR-027 / IR-031 / IR-036 (本版觸發點) / IR-038 (audit 觀測資料)

**升級指引**:
1. SSH prod: `ssh root@kkvin.com`
2. `cd /VinService/ownmind && git pull origin main`
3. **不需 migration** (純邏輯 + 安裝腳本修)
4. `docker compose build --no-cache api && docker compose up -d api`
5. 驗版號: 1.18.3
6. **既有 user 端要重跑 update.sh 才會補裝 Stop hook**:
   - `bash ~/.ownmind/scripts/update.sh` → 看到「Stop reply-lint hook：added」表示成功

## v1.18.2 — 鐵律時空背景 origin_context (Vin 提的需求 — 為什麼當時建立)

**背景**：v1.18.1 hotfix 完、Vin 提新需求：
> 鐵律在紀錄時、應該要把時空背景記錄下來、例如正在執行 XX 案子、因為遇到什麼事情所以才建立這條鐵律。如果沒辦法判斷時空背景、那就是直接寫 user 直接下令要建立。

**核心**：metadata 結構化欄位 `origin_context` + body 自動 render「## 起源」段落 (1C / 2a+b / 3 鬆 / 4 backfill+助手補)

**Schema**:
```yaml
metadata.origin_context:
  captured_at: ISO 8601 (必填、寫入時間)
  confidence: 'high' | 'user_direct' | 'unknown' (必填)
  project: string (選填、cwd basename)
  cwd: string (MCP client 自動)
  git_branch: string (MCP client 自動)
  event: string (AI 從對話脈絡推斷 / admin 手填)
  user_quote: string (user 原話)
  related_rules: string[] (相關鐵律)
```

**新增 / 改動**：

1. **新檔 `src/utils/iron-rule-origin-context.js`** — pure helpers
   - `validateOriginContext` — schema 驗證
   - `renderOriginContextSection` — 把 oc 渲染成 markdown 段落
   - `injectOriginSection` — 把段落塞 / 替換到 body 末尾 (split-based、避開 JS regex 沒 \\Z 問題)
   - `captureClientOriginContext` — MCP client 自動 capture cwd / project / timestamp

2. **新檔 `tests/iron-rule-origin-context.test.js`** — 19 cases

3. **`src/utils/iron-rule-quality.js`** lintIronRule 加 `checkOriginContext`：
   - 沒 origin_context → warning「鼓勵補時空背景」(不擋)
   - 有但結構非法 → reject

4. **`mcp/index.js`** ownmind_save:
   - schema 加 4 個 iron_rule 用欄位 (origin_event / user_quote / origin_confidence / related_rules)
   - handler iron_rule path:
     - 自動 captureClientOriginContext (cwd / project / captured_at)
     - 補 git branch (git rev-parse、best effort)
     - 寫進 body.metadata.origin_context
     - injectOriginSection 把「## 起源」段落塞進 body content

5. **`skills/ownmind-memory.md`** — 新章節「時空背景 origin_context (v1.18.2 強烈建議)」
   - 教 AI 寫 ownmind_save 時主動帶 origin_event / user_quote / origin_confidence
   - 判斷流程：對話脈絡明確 high / user 直接下令 user_direct / 推不出來 unknown
   - 完整範例

6. **`src/routes/admin-iron-rule-upgrade.js`** PUT /:id/upgrade:
   - 接受 origin_event / user_quote (選填)
   - 若有 → build origin_context (confidence=user_direct) + injectOriginSection 進 content
   - UPDATE 加 metadata 欄位

7. **`src/public/index.html`** — 升級助手 modal:
   - 加 2 個 input (origin_event / user_quote、藍色提示框包起來)
   - confirm 時帶上去
   - reset 時清空

8. **新檔 `scripts/backfill-iron-rule-origin-context.js`** — backfill 35 條既有鐵律
   - 拿所有 active iron_rule、檢查 metadata.origin_context
   - 沒 → confidence='user_direct' + event='v1.18.2 backfill: 起源不可考...'
   - 已有 → skip (idempotent)
   - --dry-run 模式

**為什麼 1C (metadata + body 雙寫) 而不是只 metadata 或只 body**:
- metadata: 給 admin 統計 / sync helper / 結構化過濾
- body: 給 AI 看「為什麼存在」的歷史脈絡 (AI 不會 parse metadata、只看 markdown)
- 雙寫由 helper 控制 (injectOriginSection)、避免不同步

**為什麼 3 鬆 (warning 不擋)**:
- 不擋舊 client (沒帶就沒帶)
- 既有 35 條等 backfill / Vin 升級時手動補
- 強制改造容易讓 user 抗拒、漸進更好

**鐵律觸發**：IR-003 / IR-005 / IR-006 / IR-008 / IR-022 (server + client + skill 三端) / IR-027 (邏輯卡控、不過 origin_context 用 warning) / IR-031 / IR-032。

**測試**：1157 → 1176 (+19) 全綠。

**升級指引**：
1. SSH prod: `ssh root@kkvin.com`
2. `cd /VinService/ownmind && git pull origin main`
3. **不需 migration** (用既有 metadata JSONB 欄位)
4. `docker compose build --no-cache api && docker compose up -d api`
5. 驗版號: 1.18.2
6. 跑 backfill (從 user 端跑、不從 server 跑):
   - `node scripts/backfill-iron-rule-origin-context.js --dry-run` 看 35 條
   - `node scripts/backfill-iron-rule-origin-context.js` 真跑
7. Browser 重試 IR-004 升級提案 — 預期：modal 含 origin_event 輸入框、可填可不填

## v1.18.1 — Hotfix: 移除 IR-037 中英混雜 lint (鐵律是技術筆記、規則用錯場景)

**背景**：v1.18.0 升級助手 browser 實測時、IR-004「使用 OpenSpec 開發流程」點 [升級提案] 後被 IR-037 lint 擋下、抓 `lint / body / Driven / Development / openspec` 5 個英文詞超過 15% 中英混雜 threshold。

Vin 質疑：「規矩太嚴 OR suggest 提案本身品質不對？」

**Audit baseline (v1.18.1 hotfix B)**：寫 `scripts/audit-real-iron-rules-lint.js` 拿 prod 真實 35 條鐵律跑 lint：
- **26/35 fail (74%)** — 不是個案、是設計錯誤
- 17 條 fail 是 IR-037 中英混雜 (docker / openspec / Adam / Eric / MacBook / claude / opus / review / 等技術詞 / 人名)
- 9 條缺適用情境段落 / 6 條缺 trigger / 3 條缺規則段落 / 1 條太短

**根本原因**：IR-037「回話一律白話中文不要中英文混雜」設計初衷是「**AI 回話**」、reply-lint Stop hook (v1.17.96) 已專門做這件事。鐵律 content 本身是「**給 AI 看的技術筆記**」、含技術詞天經地義。**把 IR-037 套到鐵律 lint 是「規則用錯場景」、不是「規則太嚴」**。v1.17.94 上線 6 個月沒人發現是因為 lint 只對 POST/PUT 跑、不對既有 row 反向校驗、被掩蓋。升級助手把問題炸開、是好事。

**修法 (D)**：移除 lintIronRule 的 IR-037 檢查（v1.17.94 規則 #7 + v1.18.0 schema lint S8）。reply-lint Stop hook 那條保留（IR-037 該管的場景）。

**順帶解 rc3 設計缺陷 (A)**：suggest helper 加 round-trip lint self-check
- 之前 (rc3) 沒做、IR-004 升級助手點下去才被 server 退回 (IR-007 fixture/prod mismatch 重蹈覆轍)
- v1.18.1 helper 內自己跑 lintIronRule 驗證 proposed_content
- 過不了在 notes 加 warning、admin 一進 modal 就看到 lint errors 不用點 confirm 才知道

**新增 / 改動**：
- 新檔 `scripts/audit-real-iron-rules-lint.js` — baseline audit script
- `src/utils/iron-rule-quality.js`:
  - lintLegacyTextRule 移除規則 #7 IR-037
  - lintSkillMdRule 移除 S8 IR-037
- `src/utils/iron-rule-suggest.js`:
  - 加 round-trip lint check
  - 回傳 `lint_ok` + `lint_errors` 給 admin endpoint
- `src/routes/admin-iron-rule-upgrade.js`:
  - POST /:id/suggest-skill-md response 加 lint_ok / lint_errors
- `src/public/index.html`:
  - Diff modal 進場時若 lint_ok=false → 預先在錯誤 box 顯示
- `tests/iron-rule-quality.test.js`:
  - 改 IR-037 測試反映新行為（合理 mixed content 應 pass）
  - 加新測試「鐵律含 docker/openspec/Adam/Eric → 通過」

**Audit 結果 (D 修完後)**：26 fail → **16 fail**、10 條鐵律從 fail 變 pass。剩 16 都是合理結構性問題（缺 trigger / 缺段落 / 太短）、Vin 之後手動補。

**鐵律觸發**：IR-003 / IR-005 / IR-007 (再次踩 fixture/prod mismatch、這次解掉) / IR-008 / IR-022 / IR-027 / IR-031 / IR-032 / IR-038 (audit 提供觀測資料)。

**測試**：1156 → 1157 (+1) 全綠。

**升級指引（這版部署 server）**：
1. SSH prod: `ssh root@kkvin.com`
2. `cd /VinService/ownmind && git pull origin main`
3. **不需 migration** (純 lint 邏輯改)
4. `docker compose build --no-cache api && docker compose up -d api`
5. 驗版號: 1.18.1
6. Browser 重試 IR-004 升級提案 — 預期：proposal 過 lint、可直接 [確認升級]

## v1.18.0 — 鐵律對齊 Anthropic SKILL.md + 1 big iron-rules skill + conditional sync

**核心轉向**：鐵律從 v1.17.94 free-text + 關鍵字啟發式 lint 升級成 **Anthropic SKILL.md 標準**（YAML frontmatter `name` + `description` + markdown body）+ **export 成 1 big skill** 到 `~/.claude/skills/ownmind-iron-rules/` 讓 Claude Code / Cursor / Codex 等工具**平台級主動 invoke**。落地 IR-027「提醒無效、邏輯才有效」最後一里路（從 50% → 70-90%）。

設計演進 4 版（Vin 對話過程逐步收斂）：
- v1: 自創 7 欄位 schema → Vin「應該參考 skills 標準」
- v2: 對齊 SKILL.md 標準 → Vin「快、省資源、卡控更精準?」
- v3: 加 export 1 big iron-rules skill → Vin「35 個 individual 太混亂」
- v4: 加 conditional sync (sync_token hash check) → Vin「應該用 hash 檢查、有需要再同步」

**3 個 rc 拆分（每個含獨立 code review + 修正）**：

### rc1: SKILL.md frontmatter parser + schema lint + previous_content
- 新檔 `src/utils/iron-rule-frontmatter.js` — js-yaml JSON_SCHEMA 安全解析
- `src/utils/iron-rule-quality.js` lintIronRule 加 frontmatter dispatch (有 → S1-S9 / 沒 → 走原 v1.17.94 regex)
- 新 schema lint S1-S9：YAML 解析 / name 必填 + ASCII kebab-case / description 必填 + 含觸發詞 / body ≥ 100 字 + 含規則段落
- `src/routes/memory.js` POST/PUT 用新 lint return shape、回 lint_format + lint_warnings
- 新 `db/013_iron_rule_previous_content.sql` ALTER ADD COLUMN
- PUT handler UPDATE 加 CASE 子句、iron_rule + content 真改才備份原 content
- npm + js-yaml ^4.1.1
- Code review 修正: B1 (parseError fallback to legacy lint) + B2 (PUT bypass merged.title)
- 測試: 1054 → 1091 (+37)

### rc2: Conditional sync + 1 big iron-rules skill 跨工具 export
- 新 endpoint `GET /api/memory/sync-token` lightweight (~50 bytes、純算 hash 不查資料)
- 新 `src/utils/iron-rule-sync.js` builders + filesystem sync
  - `buildBigSkillMd` / `buildReferenceFile` (legacy auto-wrap minimal frontmatter)
  - `syncToFilesystem` 3 種 kind (skill_folder / inline_md / agents_md_block)
  - 7 個 TOOL_TARGETS (claude / cursor / antigravity / windsurf / codex / opencode / gemini)
  - 父目錄不存在 skip (沿用 install.sh:300 pattern)
  - **atomic write** (writeFileSync tmp + renameSync) 防 multi-window race
- 新 `hooks/lib/conditional-sync.js` pure functions
  - readCache / writeCache / shouldRefreshCache (24hr stale 強制 refresh)
  - fetchSyncTokenLight (3s timeout) / fetchInitFull (8s timeout)
  - runConditionalSync 主流程 (cache_fresh / init_refreshed / cache_fallback / error)
- 新 `hooks/lib/conditional-sync-cli.js` sh hook wrapper
  - runConditionalSync → 拿 init data
  - refreshed=true → 額外打 /api/memory/sync 拿 iron_rule list
  - syncToAllTools → 寫本地 + 跨工具
  - results 寫 ~/.ownmind/logs/sync.log debug
- `hooks/ownmind-session-start.sh` 改用 wrapper、fallback: 失敗 → 直 curl init
- Code review 修正: B1 (extractIronRules 死碼 IR-007 fixture/prod mismatch) +
  I1 (atomic write race) + I3 (stdout drain) + I4 (sync log)
- Smoke test prod: 35 條鐵律真同步到 5 個工具 (Cursor/Antigravity 沒裝 skip)、
  ~/.claude/skills/ownmind-iron-rules/SKILL.md 12KB + references/ 35 個檔
  Claude Code 真把 ownmind-iron-rules 載入到 active skill list
- 測試: 1091 → 1148 (+57)

### rc3: 升級助手 admin Web UI + API
- 新 `src/utils/iron-rule-suggest.js` template-based SKILL.md proposal
  - name = code + ASCII title hint + 6 字 sha1 hash (跨平台 fs 安全、不含中文)
  - body 只放原 content + HTML comment 提示 (不放 placeholder section、避免 lint bypass)
  - 不接 LLM、未來 OWNMIND_SUGGEST_API_KEY 切 LLM 路徑
- 新 `src/routes/admin-iron-rule-upgrade.js` 3 endpoints
  - GET /upgrade-status → list + format + sync_token
  - POST /:id/suggest-skill-md → proposal、不寫 DB
  - PUT /:id/upgrade → sync_token check + lint + UPDATE + previous_content + memory_history + admin_audit_logs
- `src/public/index.html` admin 新「鐵律升級」tab + diff modal
  - data-rule-id delegate click (XSS-safe、不傳 title 進 onclick attr)
  - confirm button disable 防 double-click + sync_token 衝突自動刷新
- Code review 修正: B1 (XSS in onclick attr) + B2 (PUT 跳過 sync_token race) +
  I1 (suggest body placeholder bypass lint) + I4 (S2 ASCII only) + I2 (admin audit) +
  I5 (移除空殼驗證 button) + N3 (button disable)
- 測試: 1148 → 1156 (+8)

**graceful 雙軌、永遠不強制 migration**：
| 路徑 | 行為 |
|---|---|
| 新鐵律寫入 | client 走 SKILL.md frontmatter + body、server 卡 S1-S9 |
| 既有 35 條鐵律 | **不自動轉**、純文字 graceful fallback、Vin 用升級助手手動轉 |
| Server lint | 偵測 frontmatter：有 → schema lint；沒 → 舊 v1.17.94 regex |
| 舊 client 寫鐵律 | server graceful fallback、不 reject |
| SessionStart context | 維持現狀 (title + tags 列表)、不載入 frontmatter (避免 token 膨脹) |
| ~/.claude/skills/ownmind-iron-rules/ | 新增 — sync hook 維護 |

**鐵律觸發**：IR-003 / IR-005 / IR-006 / IR-007 (code review 抓 fixture/prod mismatch) /
IR-008 / IR-022 / IR-027 (本版核心目標) / IR-031 / IR-032。

**升級指引（這版部署 server）**：
1. SSH prod: `ssh root@kkvin.com`
2. `cd /VinService/ownmind && git pull origin main`
3. **手動 apply migration**: `docker compose exec -T db psql -U ownmind -d ownmind < db/013_iron_rule_previous_content.sql`
4. `docker compose build --no-cache api && docker compose up -d api` (IR-018 + IR-023)
5. 驗版號: `docker compose exec -T api node -e "console.log(require('./package.json').version)"` → 1.18.0
6. Browser 實測 (IR-020):
   - admin 開 /admin、看新「鐵律升級」tab、35 條鐵律列表
   - 選一條按 [升級提案]、看 diff modal
   - [確認升級] 一條、看 DB 寫入 + format='skill_md'
   - 開新 Claude Code session、看 ~/.claude/skills/ownmind-iron-rules/ 已建
   - 觀察 server log: GET /api/memory/sync-token 200 出現、init endpoint 流量大幅減少

**v1.18.x backlog (rc2/rc3 review 留下)**：
- N1 route handler integration test refactor (rc2)
- I5 mcp/ownmind-log.js flush 路徑覆蓋率 (rc2)
- ?user_id=N 跨 user 升級 (rc3)
- LLM-based suggest (OWNMIND_SUGGEST_API_KEY 環境變數路徑、目前空殼)
- title vs frontmatter name 對齊 (rc3 I3)
- DB cache stale 24hr 之外的 monitor

## v1.17.99 — Dedup helper 抽 + MCP log 也帶 client_event_id + 移 node-fetch 依賴

**背景**：v1.17.98 reviewer 點到三件事：
1. (I1) `tests/activity-batch-dedup.test.js` 用 simplified copy、邏輯漂移風險
2. `mcp/ownmind-log.js` batch path 沒帶 `client_event_id`、所有 mcp 端事件（memory_save / disable / update / iron_rule_compliance via report_compliance）走 NULL path、沒 dedup 保護
3. test fidelity vs route handler refactor 的 trade-off

v1.17.99 一起解。

**新增 / 改動**：

1. **新檔 [src/utils/activity-insert.js](src/utils/activity-insert.js)** — pure helper module export：
   - `UUID_V4_REGEX` — UUID v4 形式 regex（給其他 module 重用）
   - `normalizeClientEventId(raw)` — 非 string / 非合法 v4 / 空字串 → null
   - `insertActivityLog(query, args)` — 拆兩條 path INSERT、回 `{inserted: bool}`
   - 純函式、query 由 caller 注入、好測試

2. **改 [src/routes/activity.js](src/routes/activity.js)** POST /batch handler — 改 import + 用 helper、原本 40 行 inline dedup INSERT 邏輯收成 7 行 helper call。SQL byte-equivalent、行為不變。

3. **改 [tests/activity-batch-dedup.test.js](tests/activity-batch-dedup.test.js)**：
   - `buildApp` 把 simplified copy 拔掉、改用真 helper（`insertActivityLog` + `normalizeClientEventId` direct import）— 解 v1.17.98 review I1
   - +6 條 helper 直接 unit test（不用 spin express）

4. **改 [mcp/ownmind-log.js](mcp/ownmind-log.js)**：
   - `logEvent` 給每筆 entry 加 `client_event_id: randomUUID()`、本地 JSONL + buffer POST 共用同物件 → 同 id
   - 移 `import fetch from 'node-fetch'`、改用 Node 18+ 內建 global fetch

5. **改 [mcp/index.js](mcp/index.js)** — 同上、移 node-fetch import

6. **改 [mcp/package.json](mcp/package.json) + [mcp/package-lock.json](mcp/package-lock.json)** — 移除 `"node-fetch": "^3.3.0"` direct dep + lock 同步

7. **新檔 [tests/mcp-log-event-uuid.test.js](tests/mcp-log-event-uuid.test.js)（3 條）** — 本地 JSONL entry 帶 UUID v4 / POST body 帶 / 兩處同 id

**Code review 修正**（自己再走一輪 receiving-code-review）：

1. **[B1] node-fetch 半套清理** — 第一版只移了 `mcp/ownmind-log.js` + `mcp/package.json`、忘了 `mcp/index.js` line 9 還在 import → user `npm install` 後 MCP 開不起來。修法：mcp/index.js 也拔掉、跑 `cd mcp && npm install` 同步 package-lock。
2. **[I3] test 開發機環境 hygiene** — `tests/mcp-log-event-uuid.test.js` 沒清 `OWNMIND_TOOL` env、改在 beforeEach 顯式設 `'test-claude-code'`。
3. **[I4] setTimeout(200) flaky** — 改用 `waitForPosts(n)` poll captured.length（10ms 間隔、2s timeout）、CI 機器忙不會炸。
4. **[I2] cachebust import 累積 process listener** — afterEach 加 `removeAllListeners('beforeExit'/'SIGINT'/'SIGTERM')` 清掉。

**Reviewer 點到還沒解 / 留 backlog**（v1.17.100+）：

1. **N1 — route handler integration test** 仍是 `buildApp` 寫死 mini handler、不是 import 真 router。dedup INSERT 已 100% 一致（共享 helper）、但 route 的 batch slicing / enrich / auto-observe trigger 互動還沒測。需要 refactor `src/routes/activity.js` 成 factory pattern 才能注入 `query`。scope 大、留 v1.17.100+。
2. **I5 — `mcp/ownmind-log.js` flush 路徑覆蓋率漏洞**：buffer ≥ 10 / 30s scheduleFlush / SIGTERM/INT flush / fetch 失敗 silent fail 都沒測。

**鐵律觸發**：IR-003 / IR-005 / IR-006（helper 抽出後相關層級全更新）/ IR-008 / IR-022（server + client 兩端都動）/ IR-031 / IR-032。

**驗證**：本地 `npm test` 1054/1054 pass（v1.17.98 是 1045、+9）。

**升級指引**（**這版部署 server**）：
1. SSH 到 prod：`ssh root@kkvin.com`
2. `cd /VinService/ownmind && git pull origin main`
3. **不需 migration**（schema 沒動）
4. `docker compose build --no-cache api && docker compose up -d api`（IR-018 + IR-023）
5. 驗：`docker compose exec -T api node -e "console.log(require('./package.json').version)"` → 1.17.99
6. Server SQL 跟 v1.17.98 byte-equivalent、行為不變、無迴歸風險

## v1.17.98 — Server 端 dedup（client_event_id）— 解掉 v1.17.97 review I1 race

**背景**：v1.17.97 review 點出兩條 race 場景會讓同一個合規違反事件被寫進 DB 兩次：

1. Hook POST 1500ms timeout 後 server 端 INSERT 仍可能完成、hook 看到 false 又 spool → SessionStart flush 撿走再送 → DB 兩筆
2. 兩個 SessionStart 並發、雖然 v1.17.97 rename pattern 收窄、若 PENDING 被新寫入的時間窗剛好 + 第二個 flush 又 rename 成功 → 仍可能小機率重複

對 dashboard / pitfalls 統計影響：違反次數會偏高、偏高量不可預測（取決於離線 / timeout 頻率）。**這是統計信任度問題、不該帶到 prod 太久。**

**修法**：events 帶 `client_event_id` (UUID v4)、server 用 `(user_id, client_event_id)` partial unique index + `ON CONFLICT DO NOTHING` 做 dedup。

**新增 / 改動**：

1. **新檔 [db/012_activity_event_dedup.sql](db/012_activity_event_dedup.sql)** — `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS client_event_id UUID` + `CREATE UNIQUE INDEX IF NOT EXISTS uniq_activity_logs_user_client_event ON activity_logs (user_id, client_event_id) WHERE client_event_id IS NOT NULL`。Partial index 只 enforce 在 `client_event_id IS NOT NULL` 的 row、舊事件 NULL 不受影響。

2. **改 [src/routes/activity.js](src/routes/activity.js) `POST /batch` handler**：
   - 新增 `UUID_V4_REGEX` 驗證、非合法 UUID 當 NULL（防 client 亂塞）
   - 拆兩條 INSERT path：
     - `clientEventId === null` → 純 INSERT、不帶 ON CONFLICT 子句（review B1 — 避免 partial index inference 邊界 bug）
     - `clientEventId !== null` → INSERT 帶 `ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING RETURNING id`
   - response body 加 `deduped` 計數
   - dedup 跳過時 `continue`、不跑 auto-observed-trigger（避免重送同事件時 server 端衍生事件被重複觸發）

3. **改 [hooks/ownmind-reply-lint.js](hooks/ownmind-reply-lint.js) `buildComplianceEvents`** — 用 `crypto.randomUUID()` 給每個 violation 生 client_event_id、events array 同一份物件被 archive / POST / pending 三處共用、id 一致。

4. **新檔 [tests/activity-batch-dedup.test.js](tests/activity-batch-dedup.test.js)（8 條）** — server-side dedup 行為：SQL 形狀 / 重複 dedup / NULL path 純 INSERT / 非合法 UUID 當 NULL / UUID v1 拒 / 混合 batch / batch 內同 id 退化

5. **擴 [tests/reply-lint-pending-spool.test.js](tests/reply-lint-pending-spool.test.js)（+2）** — 每筆 spooled event 必須帶合法 UUID v4 / 同 violation 跨 spool / archive id 一致

6. **擴 [tests/flush-compliance-spool.test.js](tests/flush-compliance-spool.test.js)（+1）** — flush helper 必須原封轉送 client_event_id 給 server

**Code review 修正**（受 v1.17.97 review 啟發、自己再走一輪 receiving-code-review）：

1. **[B1] ON CONFLICT 對 NULL client_event_id 的 partial index inference 邊界** — Postgres 理論上 NULL row 不在 partial index 裡、ON CONFLICT 不會 trigger、INSERT 該照常走。但跨版本邊界行為曾有變化、reviewer 提出 runtime 報錯疑慮、本機沒 Postgres 立即驗證。**保守拆兩條 path** — NULL 走純 INSERT、有 id 才走 ON CONFLICT。Intent 也更明確（「有 id 才 dedup」）。
2. **[I3] Migration backfill 警告** — comment 加一句「未來若手動 backfill client_event_id 必須先 dedupe 同 (user_id, client_event_id) 的舊 row、否則 CREATE INDEX 會失敗」。
3. **[I1 limitation 文件化]** — `tests/activity-batch-dedup.test.js` 用 simplified handler copy（不是真 import `src/routes/activity.js`）。原因：真 handler 是 module-level Router、與 module-level pg client 緊耦合、注入 query mock 需要 refactor 成 factory pattern（同 `src/routes/usage/events.js createEventsRouter`）。**v1.17.99+ backlog**。改 server handler dedup 路徑時記得同步改測試 simplified copy。

**鐵律觸發**：IR-003 / IR-005 / IR-007 / IR-008 / IR-022（這版 server + client 兩端都改）/ IR-027 / IR-031 / IR-032 / IR-034（不觸發 — `db/` 已在 build context、Dockerfile 不需動）。

**驗證**：本地 `npm test` 1045/1045 pass（v1.17.97 是 1034、+11：8 server dedup + 2 client uuid + 1 flush preserve）。

**升級指引**（**這版部署 server**）：
1. SSH 到 prod：`ssh root@kkvin.com`
2. `cd /VinService/ownmind && git pull origin main`
3. **手動 apply migration**：`docker compose exec -T db psql -U ownmind -d ownmind < db/012_activity_event_dedup.sql`
4. `docker compose build --no-cache api && docker compose up -d api`（IR-018 + IR-023）
5. 驗：`docker compose exec -T api node -e "console.log(require('./package.json').version)"` → 1.17.98
6. Browser 實測 dashboard / 觸發一次違反看 deduped 計數（IR-020）

**已知問題（v1.17.99+ backlog）**：
- 上述 I1 limitation：refactor `src/routes/activity.js` 成 factory pattern、補真實 handler 整合測試
- `mcp/ownmind-log.js` batch path 沒帶 `client_event_id`（memory_save / disable / update 等事件）— 該路徑沒 race 場景、不影響但可一併補上
- enrich + dedup 順序：dedup 跳過時白做了 enrich（實務 batch 1~3 events、影響可忽略）

## v1.17.97 — SessionStart spool flush + Windows path 兩個 v1.17.96 backlog 解掉

**背景**：v1.17.96 ship 兩個已知問題：
1. POST 失敗時事件雖有寫 archive jsonl 但沒 reader 主動撿走、形同丟失
2. install.sh 在 Git Bash on Windows 沒走 cygpath 正規化（v1.17.71 既有 bug、v1.17.96 沿用）

v1.17.97 兩個一起解。

**修法**：

1. **新增 `hooks/lib/flush-compliance-spool.js`** — SessionStart 開頭呼叫的補送 helper：
   - 讀 `~/.ownmind/logs/reply-lint-pending.jsonl`、一次 POST `/api/activity/batch`
   - HTTP 2xx → 刪檔（事件已落 server DB）
   - 連線失敗 / 5xx → 留檔等下次 SessionStart 再試
   - 全壞行 → 直接刪檔（避免每次 SessionStart 都重試永遠送不出去的內容）
   - 嚴禁外漏 stderr / stdout（同 v1.17.71 規格 #3）
   - inline `readCredentials`（不 import shared/helpers.js）— 避免 install.sh 把 helper 複製到 `~/.claude/hooks/lib/` 後跨目錄 relative import 解析不到 `~/.ownmind/shared/`

2. **改 `hooks/ownmind-reply-lint.js` spool 語意**（避免 v1.17.97 flush 跟 hook POST 重複送）：
   - `postEvents` 改回傳 boolean（HTTP 2xx 才算成功）
   - 只在 POST 失敗 / NO_NETWORK 時寫 `reply-lint-pending.jsonl`
   - archive `YYYY-MM-DD.jsonl` 行為不變（永遠寫、純 debugging 用）

3. **改 `hooks/ownmind-session-start.sh`** — 在既有 banner-pending flush 段落後面加一段呼叫 flush-compliance-spool.js（output redirect `/dev/null` 雙保險不污染 user 通道）

4. **改 `install.sh` 2.1 + 2.2 段** — Git Bash on Windows 偵測到 `IS_WINDOWS=true` 時、用 `cygpath -w` 把 `$OWNMIND_DIR` 轉成 Win32 path 再傳給 `add-post-tool-use-hook.cjs` 跟 `add-stop-hook.cjs`。Mac/Linux 行為不變。
   - **這是 v1.17.71 既有問題、v1.17.96 沿用、v1.17.97 兩個 helper 一次解決**
   - install.ps1 用原生 Windows path、不受影響、不需改

**新增測試**：

- `tests/reply-lint-pending-spool.test.js`（5 條）— hook 條件 spool 行為：POST 成功 / 失敗 / NO_NETWORK / 沒違反 / append 模式
- `tests/flush-compliance-spool.test.js`（11 條）— flush helper 完整契約：基本契約 / POST 行為（200 / 5xx / 連線失敗 / 壞行混好行 / 全壞 / auth header）/ 嚴格 stdout/stderr 空白
- 兩個測試都用 async `spawn` 而不 `spawnSync`，避免 fake server 跟被測 hook 同 Node process 時 event loop 卡住、server 接不到連線

**End-to-end dogfood**：seed 兩條 offline 事件 → 跑 helper → fake server 收到 POST `/api/activity/batch` body 對齊 `{events:[{ts,event,tool,source,details}]}` schema → 200 → pending 檔被刪 ✓

**鐵律觸發**：IR-003 / IR-005 / IR-007 / IR-008 / IR-022 / IR-027 / IR-031 / IR-032 / IR-034（不觸發 — 純 client）。

**驗證**：本地 `npm test` 1029/1029 pass（v1.17.96 是 1013、+16）。dogfood 確認 SessionStart flush + delete file 完整流程。

**升級指引**：v1.17.97 純 client 改動、不部署 server。User 升級走自動更新拿到 hook + helper + install.sh 改動、再跑一次 `bash install.sh` 即可。

**Code review 修正（commit 前獨立 agent 對抗 review）**：

1. **[B1] install.sh `OWNMIND_DIR_FOR_HOOK` 變數作用域 bug** — 原本變數在 §2.1 的 `if [ -f "$ADD_HOOK_HELPER" ]` 區塊裡才 set、§2.2 直接用、若 §2.1 helper 檔案不存在（升級殘留 / 部分 cp 失敗）→ §2.2 會傳空字串給 add-stop-hook.cjs、Stop hook command 寫成 `node /ownmind-reply-lint.js` 直接啞掉。修法：把 cygpath 邏輯抽到 §2.0 一次算、兩個 section 共用；helper 不存在時加 `[WARN]` log 提醒 user。
2. **[I2] flush helper read-then-delete race** — 原本 `read → POST → unlink` 中間 POST 期間（數百 ms ~ 3s）若 hook 新寫一筆事件進去、unlink 會把那筆新事件一起刪掉、永久遺失。修法：改 `rename → process → unlink` — flush 一開始把 PENDING_FILE rename 成 `.processing-<ts>-<pid>` 隔離出來、新事件去寫一個全新的空檔。POST 失敗時 restoreOrCleanup 把 .processing 還原成 PENDING（PENDING 已被新寫入時 append 過去）。順帶解掉 Concern #2「兩個 SessionStart 同時跑」— 第二個 rename 會 ENOENT 直接 exit。
3. **[N1] pending spool 加 1MB rotate** — 對齊 `banner-pending.jsonl` 既有 `PENDING_FILE_MAX_BYTES = 1MB` 模式、超過 rotate 成 `.old` 覆蓋舊的、避免長期離線無限長拖慢 SessionStart。

**新增測試**（+5）：
- 4 條 review-I2 場景：POST 200 不留 .processing 殘留、POST 失敗 processing 還原 pending、沒 credentials 也還原 pending、PENDING 不存在直接 exit
- 1 條 review-N1 場景：> 1MB pending → rotate 成 .old + 新檔只含新事件

**已知問題（v1.17.98+ backlog）**：

1. **[review-I1] Server 端沒 dedup — 同事件可能被寫兩次**：實際命中場景：
   (a) hook POST 1500ms timeout 後 server 端 INSERT 仍可能完成 → hook 又 spool → SessionStart flush 再送一次 → DB 兩筆
   (b) 兩個 SessionStart 並發、雖然 v1.17.97 rename 模式擋住「同檔被讀兩次」、但若 PENDING 被新寫入時間窗 + 第二個 flush 又拿 rename → 仍可能小機率重複
   修法：events 帶 `client_event_id` (uuid v4)、server 對 `(user_id, client_event_id)` 加 partial unique index ON CONFLICT DO NOTHING。對 dashboard / pitfalls 統計影響：違反次數會偏高、偏高量不可預測（取決於離線 / timeout 頻率）。
2. **[review-N2] 全壞行直接刪檔的 race** — hook 寫到一半被 SIGKILL 留下半行 JSON、SessionStart 同時觸發 view 為「全壞」就刪檔 → 後續 hook append 的好行也被刪。極罕見、視 SIGKILL 頻率而定、低風險。修法：保留 `.old` rename 而非 unlink。
3. **archive `YYYY-MM-DD.jsonl` 還是寫但沒 reader** — 評估直接拿掉、減少 disk I/O（archive value 低、且 mcp/ownmind-log.js 也寫同檔、有混雜）。
4. **flush helper retry 沒 backoff** — 連續 SessionStart 時若 server 一直 500 會連續打、低風險但可改。

## v1.17.96 — Stop hook 整合：回話品質 lint 真的卡到 AI（IR-027 落地）

**背景**：v1.17.95 ship 了 `shared/language-lint.js` 純 lib 但沒整合任何卡關點 — IR-037（中英混雜）/ IR-036（行話沒附白話說明、即沒寫括號或冒號補充）的判斷邏輯有了、卻還是依賴 AI 自覺。enforcement_alerts 顯示 IR-037 critical 100% 違反率。違反 IR-027「提醒無效、邏輯才有效」精神。

**修法**：寫 Claude Code Stop hook（每輪 AI 回話結束時觸發）、自動讀 transcript（即 Claude Code 把每輪對話寫成的 JSONL 檔）、抽最後一輪 assistant 純 text 跑 `lintReply`、違反就：

1. **印 banner 到 user terminal**（重用 v1.17.71 ownmind-tty-echo.cjs 的 writeToTty/fallback pattern — 寫 /dev/tty 或 \\.\CONOUT$、失敗 fallback 到 ~/.ownmind/logs/banner-pending.jsonl，下次 SessionStart 補印）
2. **最佳努力 POST `/api/activity/batch` 報 `iron_rule_compliance` action=violate**（跨 session 統計、fire-and-forget、絕不阻擋 hook）

**新增 / 改動**：

1. **新檔 [hooks/ownmind-reply-lint.js](hooks/ownmind-reply-lint.js)** — Stop hook 主程式：
   - 讀 stdin Stop payload（`{session_id, transcript_path, hook_event_name, stop_hook_active}`）
   - `stop_hook_active=true` 立刻退出（防迴圈、Claude Code 規格）
   - 大檔 transcript 只讀尾巴 256KB（防巨型 session 拖慢 hook）
   - 從尾巴往前找第一筆 `type=assistant`、抽 `content[].type='text'` 部分（跳過 tool_use / thinking）
   - 永遠 exit 0；stderr/stdout 永遠空白（IR-027 規格 #3：嚴禁被 AI 過濾）

2. **新檔 [scripts/install-helpers/add-stop-hook.cjs](scripts/install-helpers/add-stop-hook.cjs)** — install-time Stop hook 安裝 helper：
   - 同 v1.17.71 add-post-tool-use-hook.cjs 同款 idempotent（即可重複跑不重複加）合併語意
   - settings.json 不存在 → created；存在無 hooks → added；已加過 → skipped
   - atomic write（tmp + rename）+ backup
   - Stop hook entry 沒 matcher 欄位（Claude Code Stop hook 規格 — Stop 不依附 tool）

3. **新檔 [tests/reply-lint-hook.test.js](tests/reply-lint-hook.test.js)** — 12 條 hook 行為測試：基本契約 / IR-037 IR-036 偵測 / 只看最後一輪 assistant / 跳過 tool_use parts / stop_hook_active 防迴圈 / fallback 不污染 stdout/stderr

4. **新檔 [tests/add-stop-hook.test.js](tests/add-stop-hook.test.js)** — 9 條 install helper 測試：created/added/skipped 三狀態 + 多種 settings.json 既有狀態 + 和 PostToolUse hook 共存

5. **改 [install.sh](install.sh)** — 在 v1.17.71 PostToolUse hook 安裝段落後面加一段 2.2 呼叫 add-stop-hook.cjs

6. **改 [install.ps1](install.ps1)** — Windows 版同樣加一段 2.2

**真實 transcript dogfood**（即拿真的歷史 session 的對話檔餵給 hook 跑跑看）：抓到 IR-037 26.5% + IR-036 10 個未解釋詞 + exit 0 + stderr/stdout 空白 ✓

**為什麼用 Stop hook 而不是 PostToolUse**：PostToolUse 只在 tool 呼叫後跑、純文字回話沒觸發；Stop 是「每輪結束」觸發、不論這輪是純文字還是有 tool 都會跑。

**為什麼不擋（exit 0 而非 block）**：違反當下強制 AI 重新生成成本太高、user 已經看到那輪回應了；用「印 banner 給 user 看 + 報 violate 累計統計」做事後反饋比較合理。未來 v1.18+ 如果 violate 率還是高、可以升級成 block。

**用 user 端 hook 而不是 server 端 lint 的原因**：reply 內容只在 user 端的 transcript file（即 Claude Code 把對話寫成的 JSONL 檔）裡、server 拿不到原文（也不該拿、隱私）。所以 Stop hook 是落地 IR-027 的唯一可行點。

**鐵律觸發**：IR-003 / IR-005 / IR-007 / IR-008 / IR-022 / IR-027（這版的核心動機）/ IR-031 / IR-032 / IR-034（不觸發 — hook 跑在 client、不是 server code）/ IR-038。

**驗證**：本地 `npm test` 1006/1006 pass（v1.17.95 是 985、+21 新測：12 hook 行為 + 9 install helper）。真實 session JSONL dogfood 確認抽到違反 + 不污染 stdout/stderr。

**升級指引**：v1.17.96 純 client 端改動、**不部署 server**（Docker image 不變）。User 升級走自動更新拿到 hook + install helper、再跑一次 `bash install.sh` 把 Stop hook 寫進 ~/.claude/settings.json 即可。

**Opt-out**（即關閉這功能的方法）：環境變數 `OWNMIND_REPLY_LINT_DISABLE=1` 完全跳過 lint（user 端不想被卡可關）。

**Code review 修正（commit 前 Codex 對抗 review）**：

1. **POST schema 對齊 server**：原本送 `{type, action, timestamp, meta}`、實際 `src/routes/activity.js:145` 要求 `{ts, event, tool, source, details}` — 缺 `ts/event` 會被 server 直接 continue 跳過。修正後對齊 `mcp/ownmind-log.js logEvent` 同款 schema。**沒這個修法，IR-027 落地完全失效（合規違反不會進 DB）。**
2. **Spool jsonl 保底**：POST 失敗 / `process.exit(0)` 砍 socket 都不會丟事件 — 寫進 `~/.ownmind/logs/YYYY-MM-DD.jsonl`（同 MCP 用的 LOGS_DIR）durability 保底。
3. **POST 改 await**：原本 fire-and-forget `process.exit(0)` 可能在 socket flush 前砍掉 → 改 await + 1500ms timeout。
4. **import-time stderr 防漏**：原本 ESM static `import` 失敗會讓 Node 直接吐 stack trace 到 stderr、違反 spec #3。改成 dynamic import 包在 try/catch、加 process-wide `uncaughtException` / `unhandledRejection` handler 保底。
5. **transcript_path 防呆**：`realpath` 後限制必須是 `.jsonl` regular file + size > 0，拒絕目錄 / 空檔 / 非預期路徑。
6. **256KB tail 截斷處理**：transcript > 256KB 時 tail 第一行可能從 JSON 中間切起 → 直接丟掉第一行避免誤判。
7. **嚴格契約測試**：所有錯誤 / 邊界路徑都驗 `stdout === ''` 且 `stderr === ''`、不只是「不含 banner」。
8. **POST schema fake-server 驗證測試**：起本機 fake HTTP server 接 POST、解 body、逐欄位驗對齊 server 期望（`ts/event/tool/source/details/details.action/details.rule_code`）。沒這個測試 review-A1 schema bug 永遠抓不到。

**已知問題（v1.17.97 backlog）**：

1. **install.sh on Git Bash (Windows) — 路徑沒正規化**：`add-stop-hook.cjs` 拿到的 `$OWNMIND_DIR` 是 POSIX path（如 `/c/Users/x/.ownmind`）而非 Win32 path。Claude Code 在 Windows 原生跑可能找不到 hook 檔。**這是 v1.17.71 PostToolUse hook 既有問題、不是 v1.17.96 引入** — install.ps1 走原生 Windows path 沒受影響、Git Bash 安裝 OwnMind 的 user 才會踩到。v1.17.97 backlog 改成兩個 helper 都加 `cygpath -w` 正規化、一次解決。
2. **SessionStart spool flush**：spool 寫進 `~/.ownmind/logs/YYYY-MM-DD.jsonl` 後、目前沒有 reader 主動撿走（只有 MCP 自己 logEvent 進 buffer 那條路會送）。實際靠 user 下一次 MCP tool 呼叫時、那次 logEvent 會 flush MCP buffer、但不會掃 spool 檔。v1.17.97 計畫加 SessionStart hook 開頭掃 spool jsonl + POST 補傳。

## v1.17.95 — 回話品質 lint lib（IR-037 / IR-036 程式邏輯卡控前置）

**背景**：Vin 反覆違反 IR-037（中英混雜）跟 IR-036（行話沒附白話說明、即沒寫括號或冒號補充）、enforcement_alerts 顯示 critical 100% 違反率。既有機制是「AI 自己事後 call report_compliance 報 violate」、依賴 AI 自覺、違反 IR-027「提醒無效、邏輯才有效」精神。

**Vin 點出的核心**：v1.17.94 鐵律品質 lint（程式邏輯卡控）有效、要把同樣思路用在「AI 回話品質檢查」— 用 script 取代 LLM 思考、AI 沒辦法騙過。

**v1.17.95 範圍（保守的第一步）**：寫純 lib + 測試、Stop hook 整合留 v1.17.96。

**修法**：

1. **新檔 [shared/language-lint.js](shared/language-lint.js)** — 抽 v1.17.94 鐵律品質 lint 的中英混雜邏輯到 shared lib、加 IR-036 行話檢查：
   - `TECH_WHITELIST` — 80+ 技術詞 / OwnMind 概念詞白名單（API / SQL / OwnMind / IR / Skill / Memory 等）
   - `checkMixedLanguage(content, threshold=0.15)` — IR-037 檢查
   - `checkJargonExplanation(content)` — IR-036 檢查：抓非白名單英文詞、看後面 50 字內有沒附「（白話）」「：解釋」「即...」「- 同位語」
   - `lintReply(content)` — 兩個一起跑、回 `{ok, violations}`
   - 純函式、跨平台（Mac / Linux / Windows）、無 native binding

2. **新檔 [tests/reply-lint.test.js](tests/reply-lint.test.js)** — 12 條測試覆蓋 IR-037 / IR-036 / 回傳格式 / Dogfood（餵真實 session 訊息）

**Dogfood 驗證**：
- 「pre-commit hook 段落」抓到 IR-037 24.6% + IR-036 5 個詞沒解釋 ✓
- 「對比表段落」抓到 IR-037 26.9% + IR-036 5 個詞沒解釋 ✓
- 純白話中文段落 ok ✓

**為什麼 Stop hook 整合留 v1.17.96**：
- Claude Code Stop hook stdin JSON 格式要解析 transcript_path JSONL、複雜度高
- settings.json 改動是 user 端動作、不該 OwnMind 自動改、要設計範例 + 部署機制
- 沒實機 hook 環境可測、貿然 ship 容易 silent fail
- 保守先 ship 純 lib、邏輯確認 100% 對、下個版本接 hook 風險低

**v1.17.96 預定**：寫 `hooks/ownmind-reply-lint.js` Stop hook、讀 transcript、跑 lintReply、違反走 banner 機制（重用 v1.17.71 tty-echo fallback）+ 自動 report violate 到 server。

**鐵律觸發**：IR-003 / IR-005 / IR-008 / IR-022 / IR-027 / IR-031 / IR-032 / IR-037（lib 在解、但這版還沒卡 runtime）/ IR-038。

**驗證**：本地 `npm test` 985/985 pass（v1.17.94 是 973、+12 新測）。

**升級指引**：v1.17.95 純 lib + 測試、**不部署 server**（lib 不在 server route 用、Docker image 不變）。client 端走自動升級拿到新檔、但目前無 runtime 影響、等 v1.17.96 接 hook 才生效。

## v1.17.94 — 鐵律品質檢查（程式邏輯卡控、IR-027 落地）

**背景**：v1.17.93 收尾、新增 IR-039「不要用條件過濾把歷史殘留資料藏起來」。我第一版 IR-039 寫成劇情記述、Vin 看了問「你自己以後看得懂嗎」— 點出更深層的問題：鐵律本身的品質如果沒被卡住、未來新 session 的 AI 看到根本不懂、形同虛設。

Vin 進一步點：「應該寫成程式邏輯」、「所有人都必須要有這個邏輯、這是產品思維」。對應 IR-027（提醒無效、邏輯才有效）的精神 — OwnMind 自己要先把自己的紀錄品質卡住、才有資格要求別人。

**修法**：在 server 端 `POST /api/memory` + `PUT /api/memory/:id` 寫入 iron_rule 時、強制跑 `lintIronRule()` 品質檢查、不過直接 400 退回。所有 client（MCP / web UI / curl）繞不過、所有 user 都會被卡。

**檢查項（7 條）**：
1. title 字數 10~100
2. content 字數 100~3000
3. 至少 1 個 `trigger:xxx` tag（沒觸發詞 = AI 不知何時觸發）
4. content 必須有「適用情境段落」關鍵字（適用 / 觸發 / 情境 / 何時 / 什麼時候）
5. content 必須有「規則段落」關鍵字（規則 / 該做 / 不該做 / 禁止 / 必須 / 應該 / 不可 / 不要）
6. 禁止依賴 context 的詞（上次 / 之前那個 / 剛剛 / 這次 session / 這次對話 / 剛才那個 / 剛才那條）
7. 中英混雜比例 < 10%（IR-037 落地、有技術詞白名單避免誤殺）

**檔案**：
- 新檔 [src/utils/iron-rule-quality.js](src/utils/iron-rule-quality.js) — pure function `lintIronRule(rule) → {ok, errors}`
- [src/routes/memory.js](src/routes/memory.js) POST + PUT 接入、iron_rule 寫入前必過 lint
- 新檔 [tests/iron-rule-quality.test.js](tests/iron-rule-quality.test.js) — 25 條測試（含 dogfood：IR-039 套用 lint 自己過關）

**Dogfood 驗證**：v1.17.93 寫的 IR-039 拿來跑 v1.17.94 的 lint、應該過關（測試確認 ✓）— 表示規則設計合理、不是設太嚴遷就壞鐵律。

**升級指引**：server 端重新部署。client 不變。**注意**：未來新增 / 更新鐵律品質不夠會被退回、AI 收到 400 錯誤需自己修了再 retry。

**累計**：本 session v1.17.89 → v1.17.94 共 6 個版本、971/971 tests pass（+61 新測）。

## v1.17.93 — Revert v1.17.92 cutoff（透明度修正）+ fix_hint 改寫

**背景**：v1.17.92 部署完、pitfalls 顯示 0、看似完美。Vin 質疑「所以不用處理嗎」— 點出 v1.17.92 的 cutoff 本質是 workaround：把 8 筆 v1.17.87 ship 前的歷史殘留藏到 SQL filter 後面、資料還在 DB 裡、admin 不知道有歷史 gap。違反「透明度」原則 + IR-027（提醒無效、邏輯才有效 — cutoff 是「提醒系統忽略過去」、不是「邏輯處理過去」）。

**思考過的 3 條路**：

| 選項 | 評估 |
|---|---|
| A. Backfill 補記（用 `source=system_backfill_v1_17_92` 標記透明補）| 寫「未實際發生的 audit log」即使有 source marker、未來如果有 audit forensics 需求、混進 backfill 會增加判讀成本 |
| B. **留著 8 筆 + 明確 fix_hint**（採用）| 完全透明、不修飾資料、14 天後自然消失、admin 看 fix_hint 就懂 |
| C. v1.17.92 cutoff（已 revert）| Workaround、hidden state、設計上不對 |

**修法**：

1. **撤掉 [me.js](src/routes/me.js) sensitive CTE 的 `V17_87_SHIPPED` cutoff**（unobserved + unverified 兩段）
2. **改寫 fmtUnobs / fmtUnverif `fix_hint`** 文案：
   - unobserved: 「v1.17.87 (2026-05-11) 已補上 memory.js POST iron_rule 路徑的 server-side observed_trigger，新事件不會再漏。剩下顯示的是 v1.17.87 之前的歷史殘留、無法補記（補假 audit log 反而汙染稽核）、14 天 retention 後自然消失、不需要處理」
   - unverified: 對應加上「v1.17.87 之前的舊事件無法補記、14 天 retention 後自然消失」
3. **刪掉 `tests/pitfalls-cutoff.test.js`**（反向測試這套修法）
4. **新 `tests/pitfalls-no-cutoff.test.js` 4 條測試**：sensitive CTE 不該有 cutoff、fix_hint 必須含 v1.17.87 + 14 天 + 「無法補/不需處理」字眼

**為什麼這次學到的東西重要**：

- 我第一輪反射式選 cutoff 是因為「pitfalls 顯示 0」看起來像完美收尾、實際只是把問題壓平。
- Vin 一句「所以不用處理嗎」逼我重新檢視。
- IR-007 持續性 bug protocol 的精神不只是「同一個 bug 反覆修」、也包含「同一類型錯誤判斷反覆出現」— 用 cutoff/filter 藏歷史資料是反 pattern、要學起來。
- 寫進 CHANGELOG 留教訓、未來看 git log 不要再做同樣反射式選擇。

**驗證**：本地 `npm test` 946/946 pass（v1.17.92 是 945、+1 條淨增測試：4 新 - 3 刪）。Prod 部署後 pitfalls 應顯示 8 筆 + 新 fix_hint、5/22 後自然歸 0。

**鐵律觸發**：IR-003 / IR-007（反 pattern 學起來）/ IR-027（cutoff 是提醒不是邏輯、refactor 成 fix_hint 文案讓 admin 看了直接懂）/ IR-008 / IR-031 / IR-032。

## v1.17.92 — pitfalls unobserved/unverified 加 V17_87_SHIPPED cutoff、歷史殘留 8→0

**背景**：v1.17.91 部署完成、pitfalls 從 30→8、誤報歸零。剩下 8 筆全是 iron_rule save 「缺 compliance」、看似系統 bug。

**追到的真相**：8 筆 ts 全部在 **2026-05-11 16:29 之前**（v1.17.87 commit 4302b09 時間）。v1.17.87 已加 server-side autoEmit observed_trigger（[memory.js POST](src/routes/memory.js)）+ v1.17.45 activity.js batch handler 也對 `memory_save iron_rule` autoEmit — 兩條路徑保證新事件都有 compliance log。v1.17.87 ship 後 0 筆新 save 缺 compliance、修法已生效。**剩下 8 筆是「v1.17.87 ship 前的歷史殘留」、非現況 bug。**

**修法**：[me.js](src/routes/me.js) 已有 `V17_37_SHIPPED = 2026-05-07` cutoff 給 orphan section、解法成熟。同套模式給 unobserved + unverified 加 `V17_87_SHIPPED = 2026-05-11`：

```sql
WHERE a.ts ${timeFilter}
  AND a.ts >= '${V17_87_SHIPPED}'::timestamptz  -- v1.17.92 新增
  AND (...)
```

**Prod 驗證**：v1.17.92 SQL 套 prod activity_logs：**8 → 0**。

**鐵律觸發**：IR-003（先寫測試）/ IR-007（持續性 bug：v1.17.87/89/90/91 改了四輪才完整收尾）/ IR-008 / IR-031 / IR-032 / IR-038。

**驗證**：本地 `npm test` 945/945 pass（v1.17.91 是 942、+3 新測）+ prod DB SQL dry-run 確認歸零。

**為什麼這個 cutoff 是對的而非掩蓋問題**：cutoff 套的是「修法 ship 時間」、不是「最近 N 天」。v1.17.87 之前的事件本來就因為修法 gap 沒 server-side hook、無法挽救（不可能去回填過去從未存在的 compliance log — 那是偽造 audit）。把它們排除等於明確劃出「v1.17.87 之前不在此分析範圍」。orphan section 已有同模式（V17_37_SHIPPED）、語意一致。

**收尾**：本 session 從 v1.17.89 開始的 pitfalls 修法序列完整收尾、pitfalls 漏觀測完全清零。

## v1.17.91 — Secret 管理補完：upsert + delete + activity_log audit

**背景**：Vin 發現 OwnMind MCP 工具列表沒有 `delete_secret`，問要做嗎、修改嗎、停用嗎。翻 code 還順便挖出三個問題：

1. `ownmind_set_secret` 描述寫「儲存或更新」、但 server [secret.js](src/routes/secret.js) POST **純 INSERT**、重複 set 同 key 會 23505 unique violation 直接 500、AI 想改 secret 會炸。
2. MCP 沒有 `ownmind_delete_secret` tool（但 server `DELETE /api/secret/:key` 早就有）— 功能 gap、AI 沒辦法刪 secret。
3. secret 操作完全沒寫 activity_log audit trail（memory 有 memory_history、secret 沒對應）— 無法追溯誰、何時、改/刪了哪個 secret。

**設計決策（討論過再做）**：

| 選項 | 結論 | 理由 |
|---|---|---|
| ✓ 修 POST 為 upsert | 做 | 跟工具描述對齊、修現有 bug |
| ✓ 加 ownmind_delete_secret | 做 | 資安 best practice — 過期 / 洩漏 key 該能刪 |
| ✓ secret 操作寫 activity_log | 做 | 補 audit gap、IR-002 不寫 value 只記 key+動作 |
| ✗ 加 disable_secret（soft-delete） | 不做 | Secret 沒「啟用 / 停用」語義、加 status 反而給錯誤安全感（DB 裡還在但被「停用」）。要不用就刪、要換就 set 蓋掉 |

**修法**：

1. **[src/routes/secret.js](src/routes/secret.js) POST 改 upsert**：
   ```sql
   INSERT INTO secrets (...)
   VALUES (...)
   ON CONFLICT (user_id, key) DO UPDATE
     SET encrypted_value = EXCLUDED.encrypted_value,
         description = COALESCE(EXCLUDED.description, secrets.description),
         updated_at = NOW()
   RETURNING ..., (xmax = 0) AS inserted
   ```
   `xmax = 0` 用來判斷實際是 create 還是 update、決定 HTTP status (201 vs 200) 跟 activity_log action 標籤。description COALESCE 避免「呼叫端沒帶 description 時把原值蓋成 null」。

2. **[mcp/index.js](mcp/index.js) 新增 `ownmind_delete_secret` tool**：
   - tool description 含「永久刪除」「不可復原」「建議刪除前先用 ownmind_list_secrets 確認 key、避免誤刪」— 卡控 AI 行為
   - switch case 走 `callApi("DELETE", /api/secret/:key)` 對應 server 既有 endpoint
   - 加入 tool category 常數 `密鑰管理`

3. **secret_set / secret_delete activity_log audit**（IR-002 不洩漏 value）：
   - POST 成功時寫 `event='secret_set'`、details 只記 `{key, action: 'create'|'update'}`
   - DELETE 成功時寫 `event='secret_delete'`、details 只記 `{key}`
   - log 寫入失敗時吞掉 warn、不阻擋主流程

4. **11 條 reproduction tests**（IR-003）— [tests/secret-mgmt.test.js](tests/secret-mgmt.test.js)：
   - upsert SQL 含 `ON CONFLICT DO UPDATE` + `EXCLUDED.encrypted_value` + `updated_at = NOW()`
   - MCP tool 定義 + switch case + DELETE callApi 路徑
   - tool 描述含「不可復原」警告
   - activity_log 寫入 + 事件名 + **details 絕對不含 value / encrypted_value**（IR-002 防呆）

**鐵律觸發**：IR-002（不洩漏 value 到 log）/ IR-003 / IR-005 / IR-008 / IR-022 / IR-027（用程式卡控、不靠提醒）/ IR-031 / IR-032 / IR-038（補 audit 觀測管道）。

**驗證**：本地 `npm test` 940/940 pass（v1.17.90 是 929、+11 新測）。

**升級指引**：server + client 都需重新部署：
- server：upsert SQL + activity_log audit 都在 server route
- client（MCP）：要 ship 新 `ownmind_delete_secret` tool 才能讓 AI 用上

**已知未解**：v1.17.90 backlog 還有「8 筆 iron_rule save 缺 compliance」沒追、留 v1.17.92。

## v1.17.90 — pitfalls 漏觀測 73% 是誤報 — sensitive event 加 iron_rule type filter

**背景**：v1.17.89 ship 完之後、Vin 要繼續挖 pitfalls。SSH 進 prod DB 撈那 30 筆「漏觀測」實際資料、發現**只有 8 筆是真的 iron_rule 缺 compliance、其他 22 筆全是 team_standard / standard_detail / project disable 被誤算進 sensitive 列表（誤報率 73%）**。

**Eric 5/11 09:50 那 11 秒 11 連發 disable 全是合理使用**：他停用 `team_standard` id=199（GitLab 移交規範）+ 它底下 10 個 `standard_detail` children、不是異常 pattern。pitfalls 把它列出來是邏輯 bug、不是 Eric 行為問題。

**根因**：[me.js:770-779](src/routes/me.js) sensitive CTE 兩條 OR：
- `memory_save AND details->>'type' = 'iron_rule'` ✓ 有過濾
- `memory_disable` ❌ 沒過濾 type — 因為 disable event 的 details 只有 `{id, reason}`、沒帶 type、要 JOIN memories 才查得到

**修法**（搭 v1.17.89 enrich 機制延伸）：

1. **[src/utils/enrich-activity.js](src/utils/enrich-activity.js)** — 改寫 disable/update enrich 邏輯：
   - **所有 type** 都 snapshot `disabled_type`（給 pitfalls SQL 用、不再依賴 JOIN）
   - 只有 iron_rule 才額外 snapshot `disabled_code` + `disabled_title`（admin 顯示用）
   - 行為改變：v1.17.89 是「非 iron_rule 不 snapshot 任何東西」；v1.17.90 是「所有 type 都 snapshot type、只 iron_rule snapshot code/title」

2. **[src/routes/me.js](src/routes/me.js) pitfalls SQL** — 兩段 sensitive CTE 的 memory_disable 分支都加 type filter：
   ```sql
   (a.event = 'memory_disable'
     AND COALESCE(
       a.details->>'disabled_type',           -- v1.17.89+ enrich 寫的
       (SELECT type FROM memories WHERE ...)  -- 歷史資料 fallback
     ) = 'iron_rule')
   ```

3. **Reproduction tests +5 條**（IR-003）：
   - disabled_type snapshot 對 preference / project / team_standard / standard_detail / iron_rule 各 type 行為驗證
   - me.js SQL 必含 iron_rule type filter（靜態斷言、防退化）

**Prod 驗證**：v1.17.90 SQL 套到 prod activity_logs：**30 筆 → 8 筆**。22 筆誤報全消、剩 8 筆都是真實的 iron_rule save 缺 compliance（AI 行為層問題、需另外追）。

**鐵律觸發**：IR-003 / IR-005 / IR-007（v1.17.87/89 改 pitfalls 兩輪、才挖到誤報這個更大的洞）/ IR-008 / IR-022 / IR-031 / IR-032 / IR-038（觀測補完 + 直接修 false positive 雜訊）。

**驗證**：本地 `npm test` 928/928 pass（v1.17.89 是 923、+5 新測）+ prod DB SQL dry-run 確認誤報歸零。

**升級指引**：server 端重新部署即可。Client 不變。Deploy 後新 disable 自動帶 `disabled_type`、歷史 v1.17.89 之前資料靠 SQL COALESCE 走 JOIN fallback。

**已知未解**：剩下 8 筆 iron_rule save 缺 compliance 是 AI 行為層問題（不是 server bug）— autoEmit 應該要寫 observed_trigger 但這 8 筆顯然沒寫到。可能是 client 版本 < v1.17.45（autoEmit 加入版本）。留 v1.17.91 backlog。

## v1.17.89 — 修「停用鐵律「(找不到)」」觀測黑洞（IR-038）

**背景**：v1.17.88 pitfalls 頁顯示 30 筆漏觀測，幾乎全部都是 `停用鐵律「(找不到)」` — admin 看不出到底停了哪條鐵律、稽核能力等於零。Vin 翻 log 抓到這個 pattern 後要求修。

**根因**：
1. Client MCP 在 `ownmind_disable` 時 [mcp/index.js:832](mcp/index.js) 只送 `{ id, reason }` 進 `/api/activity/batch`
2. Server [activity.js](src/routes/activity.js) 直接寫入 `activity_logs.details`、沒 enrich
3. 之後 admin 看 [/api/me/pitfalls](src/routes/me.js)，靠 subquery JOIN `memories` 表補 title/code
4. 失敗情境：id 非數字（regex `^\d+$` 不過）、記憶被刪、跨 user → subquery 回 null → 顯示「(找不到)」

**修法**（server 端 enrich、client 不動以保持向後相容）：

1. **新檔 [src/utils/enrich-activity.js](src/utils/enrich-activity.js)** — pure function `enrichActivityDetails(event, lookup)`：
   - 若 event 是 `memory_disable` / `memory_update` 且 target 是 iron_rule
   - 立刻 lookup `memories` 把 `code` + `title` snapshot 到 `details.disabled_code` / `details.disabled_title`
   - lookup 失敗（DB error、memory 不存在、id 非數字）一律吞掉、回原 details — enrich 不能阻擋主 INSERT
2. **[src/routes/activity.js](src/routes/activity.js) batch handler**：INSERT 前呼叫 enrich、把 enriched details 寫入 DB（之後看 activity_log 不用 JOIN 就有完整脈絡）
3. **[src/routes/me.js](src/routes/me.js) pitfalls SQL**：`COALESCE(details->>'disabled_title', JOIN memories)` — 優先讀 details snapshot（新資料）、找不到再 fallback JOIN（v1.17.88 之前的歷史資料）

**Reproduction tests 13 條（IR-003）**：[tests/disable-details-snapshot.test.js](tests/disable-details-snapshot.test.js) — 涵蓋 enrich 各邊界（iron_rule / 非 iron_rule / id 非數字 / lookup 丟錯 / details 是 null / non-disable event），加 batch handler 跟 pitfalls SQL 的靜態斷言。

**鐵律觸發**：IR-003（先寫測試）/ IR-005（無盲改、有讀 code）/ IR-007（持續性 bug：v1.17.87 改過一輪 disable observability 才挖到這條黑洞）/ IR-008（CHANGELOG/README/FILELIST 同步）/ IR-022（Server + Client 兩端確認：client 不動、server 接管 enrich）/ IR-031（package.json + 三語 README 版號）/ IR-032（三語系 README 同步）/ IR-038（觀測管道補完）。

**驗證**：本地 `npm test` 923/923 pass / 0 fail（v1.17.88 是 910，+13 新 test）。

**升級指引**：server 端重新部署即可。Client 不變、deploy 後新發生的 disable 事件就會自動帶 snapshot。歷史 30 筆「(找不到)」會在 14 天 retention window 後自然過期。

**已知未解**：Eric 在 2026/5/11 09:50:00-09:50:11 連發 11 條 disable（11 秒內），這個異常 pattern 跟本次修法無關、留作 v1.17.90 調查（需先確認 Eric 客戶端版號 + 為何短時間連停 11 條鐵律）。

## v1.17.88 — `/me` trailing slash redirect 小修

**背景**：Vin 回報 `https://kkvin.com/ownmind/me`（沒尾斜線）連不上、必須打 `/ownmind/me/`。Express `app.use('/me', express.static(...))` 對 mount path 本身不自動補 trailing slash — `/me` 直接 404、`/me/` 才 hit index.html。

**修法**：[src/app.js](src/app.js) static mount 前加條件式 redirect handler。原本想直接 `app.get('/me', res.redirect(301, 'me/'))` 但 Express 預設 strict routing=false、`/me/` 也會 match 變成無限循環。改成：

```js
app.get('/me', (req, res, next) => {
  if (req.originalUrl.endsWith('/')) return next();  // 已有 / → 給 static
  res.redirect(301, 'me/');  // 沒 / → 301 補上（相對路徑避開 nginx prefix 問題）
});
```

**為什麼相對路徑**：用 `'me/'` 而非 `'/me/'`。kkvin.com 跑 nginx 反代到 `/ownmind`、Express 內部 URL 看不到 `/ownmind` prefix。如果用絕對 `/me/`、Location header 會是 `/me/`、user browser 拼到 origin 變成 `https://kkvin.com/me/`（沒 prefix）。用相對 `me/` 對當前 URL `/ownmind/me` 來說、browser 拼出 `/ownmind/me/`。

**Reproduction tests 3 條（IR-003）**：
- [tests/me-trailing-slash.test.js](tests/me-trailing-slash.test.js)
- 用 mini express app + `fetch redirect:'manual'` 驗 301 + Location header
- 也驗 source code 含條件式 endsWith 邏輯（防止未來退化）

**鐵律觸發**：IR-003 / IR-005 / IR-008 / IR-026 / IR-031 / IR-032。

**驗證**：本地 `npm test` 910/910 pass / 0 fail（v1.17.87 是 907，+3 新 test）。

**升級指引**：server 端要重新部署（src/app.js 改）。User 端不變、deploy 後直接打 `/ownmind/me` 自動跳到 `/ownmind/me/`。

## v1.17.87 — 踩坑紀錄 tab + memory.js 7 筆漏觀測修正（IR-038 觀測管道 + IR-027）

**背景**：v1.17.86 之後個人 /me 頁面三條合規警告（9 筆漏觀測 + 2 筆未驗證 + 1 筆 orphan session）顯示在每個 user 自己畫面。Vin 提出兩個架構性問題：

1. 個別 user 看自己的「合規警告」沒意義 — 那是系統 bug 或 AI 行為問題、不是 user 該緊張的事
2. 跨 user 比對才看得出 pattern（例如 9 筆全部來自 3 條 handler）

調查發現另一個矛盾：[src/routes/me.js:447](src/routes/me.js) 把 `handoff_create` 列入 sensitive event、但 [src/routes/activity.js:108](src/routes/activity.js) `autoEmitObservedTrigger` 故意不觀測 handoff（Codex round 4 過度推論 review 限制）。兩端設計不一致導致 handoff 永遠進「漏觀測」警告但 server 永遠不會自動補。

**修法（v1.17.87 整套）**：

1. **個人 /me 頁拿掉三條合規警告**（[src/routes/me.js](src/routes/me.js)）：
   - `compliance_unobserved` / `compliance_unverified` / `orphan_session` 都搬到新 tab
   - 保留 `heartbeat_absent` / `source_inconsistent` / `unobservable_source`（這些是 user 自己環境問題、確實該通知）

2. **sensitive event 列表拿掉 handoff_create**（[me.js:443-456](src/routes/me.js)）：跟 `activity.js` autoEmit 設計選擇對齊。handoff content 是 user 主觀內容、不該被當 compliance 觸發點。

3. **新增 `GET /api/me/pitfalls` endpoint**（[me.js:730+](src/routes/me.js)）：
   - 任何 user 可見（不限 super_admin）— 跨 user 合併呈現系統健康度
   - 三 section：unobserved / unverified / orphan_session
   - 每筆 row 四欄位：`when`（時間）/ `what`（發生情況）/ `impact`（影響）/ `fix_hint`（建議修法）
   - 支援 `window=7d/30d/90d/all` 下拉切換
   - JOIN `users` 拿 name 顯示「誰做的」

4. **新增「🕳️ 踩坑紀錄」tab**（[src/public/me/index.html](src/public/me/index.html)）：
   - tab 列加新按鈕、tab 容器三個 section
   - `<details>` + `<summary>` 原生 HTML5 折疊、不靠 JS framework
   - 點 summary 展開看完整四欄位

5. **memory.js save iron_rule + disable 兩條 handler 寫 server-side compliance log**（[src/routes/memory.js](src/routes/memory.js)）：
   - save handler `type=iron_rule` → 立刻 INSERT `iron_rule_compliance` (rule_code=IR-006, source=`system_server_auto`, action=`observed_trigger`)
   - disable handler `type=iron_rule` → 同上
   - 試錯時 try/catch 不擋主流程
   - 這修了原本 9 筆漏觀測中的 7 筆根因（4 筆 memory_save iron_rule + 3 筆 memory_disable，剩 2 筆 handoff_create 由 #2 修法從 sensitive list 拿掉）

**結果**：升級到 v1.17.87 後：
- 個人 /me 頁面**乾淨**、沒有合規警告打擾 user
- 新 tab 跨 user 看得到所有踩坑、點擊展開看完整脈絡 + 建議
- memory.js 新事件**自動寫 compliance log**、不會再進「漏觀測」清單
- 歷史 9 筆 + 1 orphan session 仍在 pitfalls tab 顯示（直到 30 天滾動視窗過期、或未來加 mutation endpoint 改 status 為 `resolved`）

**Reproduction tests 17 條（IR-003）**：
- [tests/me-pitfalls.test.js](tests/me-pitfalls.test.js)：
  - me.js sensitive event 不含 handoff_create（剝註解後判定）
  - 個人頁 myAuditFindings 不再 push 三條合規警告（保留 heartbeat 等）
  - pitfalls endpoint：route 註冊 / 跨 user JOIN / 三 section query / 四欄位 / window param
  - memory.js：save+disable handler INSERT iron_rule_compliance / IR-006 / observed_trigger / try-catch
  - me.html：tabs 按鈕 / tab 容器 / 三 section / window 下拉四選項 / loadPitfalls function / `<details>` 折疊 + 四欄位 label

**鐵律觸發**：IR-003 / IR-005 / IR-007（防同類雷：兩端設計衝突的 handoff_create 已對齊）/ IR-008 / IR-022（server + client html 同步）/ IR-026 / IR-027（個人警告無效→改成 admin tab 邏輯卡控）/ IR-031 / IR-032 / IR-038（觀測管道 — 核心動機）。

**驗證**：本地 `npm test` 907/907 pass / 0 fail（v1.17.86 是 890，+17 新 test）。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Important #1**：`(s.details->>'id')::int` 對非數字 id 會 cast error 整個 endpoint 500。改 `CASE WHEN ... ~ '^\d+$' THEN ::int END` 防呆。
- **Minor #3**：orphan session 的 `raw.summary` 是別 user 的 session 內容、跨 user 可見會洩漏。截 40 char + 末端 …（pitfalls 是 pattern-spotting、不是內容披露）。
- **Minor #4 預期行為說明**：v1.17.87 補了 server-side `system_server_auto` observed_trigger，新 save/disable 事件會從 `unobserved` 移出。但 `unverified` 邏輯是「has_any AND NOT has_matching_manual_comply」— 仍要 AI 主動 manual comply。所以**短期間 unverified 數量會增加**（unobserved → unverified 遷移），直到 AI 行為調整補 IR-006 manual comply。屬於預期、不是 bug。

**升級指引**：server 端要重新部署（me.js + memory.js 都改）。Client 端只有 me.html 改、user 重新整理瀏覽器即可看到新 tab。

## v1.17.86 — `upgrade_complete` beacon：升完不靠 self-check 就能確認真版號（IR-038）

**背景**：v1.17.85 修了 FAIL fallback，但 Vin 從 `/me` 用量報告（撈 `collector_heartbeat.scanner_version`）看到 Adam / Eric / Michelle 都在 1.17.84，**而 `install_check_logs` 那個表卻沒任何他們的 post_install / post_upgrade self-check report**。

兩個 source 對不上 → 升級完成的事實只在 `collector_heartbeat` 看得到，`install_check_logs`（admin dashboard 主要查詢來源）完全沒紀錄。可能原因：
- self-check 跑了但 upload 401 / 5xx → 寫 `.upload-spool.jsonl` 等下次 retry，但 user 升完就 quit Claude Code，永遠沒下次觸發 self-check 來 drain spool
- 跨多版升級（v1.17.66 → ... → 1.17.84）self-check 中途某步卡住
- Windows 環境特殊問題讓 self-check process 被中斷

v1.17.85 FAIL fallback 不解決這個 — Adam / Michelle 的場景沒被 FAIL() 中斷、是「升完了但 self-check 上傳這條最後一步沒成功」。

**修法**：升級成功末段（`OK done` 之後、`self-check.cjs` 之前）先打一個輕量 `upgrade_complete` beacon：

1. **`scripts/interactive-upgrade.sh`** + **`.ps1`** — 加 `send_upgrade_complete_beacon` / `Send-UpgradeCompleteBeacon`：
   - Payload 簡單（trigger / client_version / platform / machine / ts），**不包含 checks**
   - curl / Invoke-RestMethod 5 秒 timeout，fire-and-forget
   - 失敗走同樣的 `.upload-spool.jsonl` fallback 等下次 drain
   - 比 `self-check.cjs --trigger=post_upgrade` **早送 + 簡單到不會卡**

2. **server 端不用改**：`upgrade_complete` 不在 v1.17.85 加的 `isBeaconTrigger()` 過濾清單，client_version 自然保留真版號。

**三個觀測信號分工**：

| trigger | 時機 | payload | client_version 行為 |
|---|---|---|---|
| `install_started` / `update_started` | 升級開始（不知道目標版號） | minimal + sentinel `"install-script"` | server 強制 NULL（v1.17.85） |
| `upgrade_complete` (新增) | 升級結束（OK done 之後） | minimal + 真版號 | server 保留真版號 |
| `post_upgrade` self-check | 升級結束的完整 verify report | full checks | server 保留真版號 |

即使 `post_upgrade` self-check 三步全失敗，server 至少看得到 `upgrade_complete` 證明 user 升上去了。

**Reproduction tests 6 條（IR-003）**：
- [tests/upgrade-complete-beacon.test.js](tests/upgrade-complete-beacon.test.js)：bash beacon 失敗時 spool fallback 含真版號 / interactive-upgrade.sh 末段必須呼叫 / PS1 必須有 function 跟 trigger 字串 / server 端真版號保留 / 跟 install_started sentinel 行為相反

**鐵律觸發**：IR-003 / IR-005 / IR-008 / IR-022（兩端對稱）/ IR-026 / IR-031 / IR-032 / IR-038（觀測管道補洞 — 核心動機）。

**驗證**：本地 `npm test` 890/890 pass / 0 fail（v1.17.85 是 883，+7 新 test）。

**Code review 抓到的修正**（superpowers:code-reviewer + IR-007 同類雷不留下版）：
- **Important I1（reviewer 建議放 v1.17.87、我選 fold 進這版）**：beacon 上傳失敗時 spool fallback 等下次 self-check 才 drain。但 user 升完即 quit Claude Code → 永遠沒下次 → spool 卡本機、server 永遠看不到。修法：[hooks/ownmind-session-start.sh](hooks/ownmind-session-start.sh) 開頭加 fire-and-forget 背景呼叫 `retrySpool`，任何新 Claude Code session 起來都會 drain，延遲縮短成「下次開 Claude Code 就 server 看得到」。徹底收掉這條 root cause class。

**升級指引**：純 client 端 + server 行為不變（既有 `isBeaconTrigger()` 清單剛好不過濾 `upgrade_complete`，免改）。用戶下次升級自動拿到新 beacon 跟 SessionStart drain。

## v1.17.85 — install_failed 觀測盲點補強 + beacon trigger 不污染 client_version（IR-038 + IR-022）

**背景**：Vin 跑 admin query 看用戶版本分布，看到 Adam (id=3) / Michelle (id=6) 的 `last_known_version` 是字串 **`"update-script"`** 不是版號，第一眼以為資料污染。深入查發現：
1. `"update-script"` 是 v1.17.78 加的 `update_started` beacon 的 **sentinel 值**（升級剛開始時不知道目標版號，用字面字串占位）— 這是預期行為
2. 但這個 sentinel 直接寫進 `install_check_logs.client_version` column → admin query 撈到的 last_version 就是 sentinel、不是真版號
3. **更嚴重的觀測盲點**：Adam 5/11 03:50 跑 `update_started` beacon 之後**沒任何 post_install / manual / errors spool 紀錄**。升級顯然失敗、但完全沒留任何錯誤證據。Trace 發現 `interactive-upgrade.sh` 雖然多數 FAIL path 之前有 call `report_error`，但仍有漏網（`no_ownmind` / `no_git` / `cd_failed` / `install` / `verify_local` 等），加上 unexpected exit（syntax error / SIGTERM）完全沒人攔

**修法（兩端對稱、IR-022）**：

1. **Client 端** [scripts/interactive-upgrade.sh](scripts/interactive-upgrade.sh) + [scripts/interactive-upgrade.ps1](scripts/interactive-upgrade.ps1)：
   - `FAIL` / `Fail` 函式統一補 fallback `report_error` 呼叫
   - kind 帶 `_terminal` 後綴（如 `upgrade_failed_terminal_no_ownmind`）讓 admin 分辨「終點觀測」vs caller 先 call 的「_step 級觀測」
   - 「caller 已 call + FAIL fallback」會寫兩條 errors record（重複觀測無害、好過漏網）
   - 跟既有的 v1.17.79 報錯 helper 整合，無新依賴

2. **Server 端** [src/routes/debug.js](src/routes/debug.js)：
   - 偵測 trigger 是 beacon 系列（`install_started` / `update_started` / `install_failed*` / `update_failed*` / `upgrade_failed*`），`client_version` 強制寫 NULL
   - `install_check_logs` 仍保留 row（觀測管道完整），但 `client_version` column 只放真實版號
   - 未來 admin query 不用過濾 sentinel — NULL 自然排除

**結果**：
- 升級流程任何環節失敗都會留 errors record，admin query 看得到根因
- `install_check_logs.client_version` 不再被 sentinel 污染，撈 last_version 直接準
- 不 backfill 歷史（污染量小、約 12 筆 5/8 之後的 beacon record）

**Reproduction tests 9 條（IR-003）**：
- [tests/install-failed-beacon.test.js](tests/install-failed-beacon.test.js) 3 條：`FAIL "no_ownmind"` / `FAIL "verify_local"` 自動寫 errors record；caller 已 call report_error 的場景不被破壞（雙觀測共存）
- [tests/debug-route-beacon-version.test.js](tests/debug-route-beacon-version.test.js) 6 條：beacon trigger + sentinel `"install-script"` / `"update-script"` → NULL；正常 self-check report → 保留真版號；邊界 case 不過度過濾

**鐵律觸發**：IR-003 / IR-005 / IR-007（防同類雷：FAIL 函式自帶觀測、未來新 FAIL path 自動覆蓋）/ IR-008 / IR-022（兩端對稱）/ IR-026 / IR-031 / IR-032 / IR-038（觀測管道補洞 — 核心動機）。

**驗證**：本地 `npm test` 881/881 pass / 0 fail（v1.17.84 是 872，+9 新 test）。

**升級指引**：兩端同時動。Server 端要重新部署（auth + debug route 改寫）。Client 端用戶下次升級自動拿到 FAIL fallback。

## v1.17.84 — Windows file-lock 偵測 + check-sync.sh L2 lock-tolerant fallback（vin-windows-test 第七輪）

**背景**：vin-windows-test 第七輪實測 v1.17.83 升級失敗：

```
有新版ownmind?
→ Ran skill /ownmind-upgrade
L1: behind 1 commit
L2: error - cannot read client version
L3: in_sync
OVERALL: needs_upgrade
→ User: OK 升級
→ 升級失敗：package.json 被另一個程序佔用
```

**雙重 root cause（Windows-specific）**：

1. **OwnMind MCP node process 持有 file handles** — Claude Code session 內 cmd.exe + start.cmd → node mcp/index.js running，持有 `~/.ownmind/mcp/node_modules/*.js` 的 read handle。Windows mandatory locking → git pull / npm install 改寫被拒（EBUSY / EACCES）
2. **check-sync.sh L2 讀本機版本仰賴 `node -e require()`** — Node module resolver 對 file lock 敏感，cache 邏輯有時讓 require() 失敗或回空。L2 直接報 `cannot read client version` → ownmind-upgrade skill 看到 error 但沒有具體可行動指示

**修法（兩端對稱）**：

### `scripts/check-sync.sh` — L2 lock-tolerant fallback
```bash
if [ -z "${CLIENT_VER}" ]; then
  CLIENT_VER=$(grep -m1 -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "${OWNMIND_DIR}/package.json" \
    | sed -E 's/.*"([^"]+)".*/\1/')
fi
```
- 純 stdio read，不走 Node module resolver / require cache
- Windows mandatory lock 對 read 通常友善（write lock 才嚴），grep 可讀

### `scripts/interactive-upgrade.{sh,ps1}` — file-lock 偵測 + 明確指示
- 新增 helper：`is_file_lock_error` (sh) / `Test-FileLockError` (ps1)，掃 log 找 `EBUSY|EACCES|EPERM|Permission denied|in use by another|another process|file is locked|resource busy|access is denied`
- npm install 失敗時：先檢查是不是 lock 錯誤，是的話：
  1. `Report-Error -Kind upgrade_file_locked` (IR-038 觀測)
  2. 錯誤碼換 `file_locked`（不是泛 npm_install）
  3. 訊息：`Files in use by another process (likely Claude Code). Close Claude Code completely, then re-run upgrade.`

**為什麼只 wire npm install**：git pull 主要操作 `.git/`，被 lock 的機率低；npm install 改寫 node_modules 才是 Windows 真實災區。`install.sh` re-run 也會走 npm install 路徑，被同一個 detection 包到。

**驗證**：
- 新增 `tests/upgrade-windows-file-lock.test.js`（7 條：check-sync.sh grep fallback / sh + ps1 各 3 條 lock pattern + report-error + Claude Code 訊息）
- npm test **872/872 pass / 0 fail**

**鐵律觸發**：IR-006 / IR-022（Server + Client 對稱 — 此次純 client）/ IR-031 / IR-032 / **IR-038（觀測管道擴及 platform-specific 失敗）✅**

**升級指引**：對既有 user 完全無感。下次 vin-windows-test 升級若 MCP process 還在跑，會看到明確訊息「Close Claude Code completely, then re-run upgrade」而不是泛 npm_install 失敗，admin 也能在 install_check_logs 看到 `error_upgrade_file_locked` 事件統計。

## v1.17.83 — JSONB null byte sanitize + spool retry cap（vin-windows-test 第六輪 500 風暴）

**背景**：vin-windows-test 第六輪升級成功 + 觀測資料進來了，但 server log 看到一連串 5xx：

```
17:46:44 install-check 寫入失敗 unsupported Unicode escape sequence
17:46:46 install-check 寫入失敗 unsupported Unicode escape sequence
17:46:47 install-check ... 200  ← 中間有成功的（不同 payload）
17:46:56 install-check 寫入失敗 unsupported Unicode escape sequence
17:46:56 install-check 寫入失敗 unsupported Unicode escape sequence  ← spool retry 又送同一筆
...連續 6 次同筆 payload 失敗
```

**雙重 root cause（兩端都需修）**：

1. **Server 端** `src/routes/debug.js`：把 body `JSON.stringify` 寫進 JSONB 欄位（`install_check_logs.full_log`）。Postgres JSONB **嚴格拒絕 null byte (` `)**，無論是 literal 字符或 JSON 6-char escape ` `。client mojibake / 髒環境變數 / log file 殘留 binary 都會引入 → 整筆 INSERT fail，回 5xx
2. **Client 端** `self-check.cjs retrySpool()`：看到 5xx 把原 line 寫回 spool，**沒記次數**，下次又重送 → 同一筆壞 payload 無限循環，浪費 bandwidth + 撐滿 server log

**修法（雙端對稱）**：

### Server: `src/routes/debug.js`
寫 JSONB 前所有 string 走 `sanitizeNullBytes`：
```js
const sanitizeNullBytes = (s) => (
  typeof s === 'string'
    ? s.replace(/ /g, '').replace(/\\u0000/g, '')
    : s
);
```
- 第一個 replace：strip literal NULL char
- 第二個 replace：strip JSON-encoded ` ` 6-char escape（JSON.stringify 對 NULL 的編碼）
- 保護 4 個欄位 + summary + full_log

### Client: `scripts/install-helpers/self-check.cjs retrySpool()`
- 每筆 spool entry 加 `_attempts` 計數，retry 失敗時 `+1`
- 達到 `MAX_SPOOL_ATTEMPTS` (=5)：drop entry + `stderr` 印 `[spool] drop after N attempts: <trigger>`
- 上傳成功：直接刪（同舊版）
- 回傳新欄位 `dropped: N` 給 caller 統計

**驗證**：
- `tests/install-check-null-byte-sanitize.test.js`（4 條：machine 含 NULL / 深層 checks 含 NULL / summary 含 NULL / 純 ASCII regression）
- `tests/spool-retry-cap.test.js`（3 條：5 次 5xx 後 drop / 未達上限保留 + 計數 increment / 中途成功時 drop）
- npm test **865/865 pass**（v1.17.82 → v1.17.83 +7 條）

**鐵律觸發**：IR-006 / IR-022（Server + Client 對稱）/ IR-031 / IR-032 / **IR-038（觀測管道防無限循環）✅**

**升級指引**：對既有 user 完全無感。下次 client 上傳含 null byte payload 不再爆 5xx；若 payload 有結構性問題，5 次後自動 drop 而非無限重送。

## v1.17.82 — Stdout 全英文化 + self-check 專業格式（解 mojibake、產品品質）

**背景**：vin-windows-test 第六輪實測升級成功，但 PowerShell console 把 bash 輸出的 UTF-8 中文當 cp950 解碼，整螢幕 mojibake：

```
INFO:detect:�ˬd OwnMind �w�˪��A�]C:\Users\Vin\.ownmind�^
INFO:upgrade:�w�w�ˡA�浹 interactive-upgrade.ps1
```

Vin 觀察：「我不希望顯示亂碼，可以用英文顯示，self-check 訊息要專業一點，要像是專業軟體」。

**Root cause**：bootstrap.ps1 → 跑 bash → bash 用 UTF-8 輸出 → PS console codepage 是 cp950 → mojibake。最乾淨的解法是 **stdout 一律 ASCII (英文)**，不 fight encoding chain。

**修法（涵蓋全部 user-facing 腳本 stdout）**：

| 檔案 | 改動 |
|---|---|
| `scripts/bootstrap.{sh,ps1}` | INFO/OK/ERROR 後訊息全英文 |
| `scripts/interactive-upgrade.{sh,ps1}` | 升級每階段 INFO/OK/ERROR 訊息全英文 |
| `install.{sh,ps1}` | 安裝每階段 + winget / git / npm 失敗訊息全英文 |
| `scripts/update.{sh,ps1}` | sync 訊息全英文 |
| `scripts/install-helpers/self-check.cjs` | `printConsole()` 重設計成 industry-standard log 格式 |

### Self-check 新格式（professional, ASCII-only）

```
OwnMind self-check
--------------------------------------------------
[ OK ]  mcp_files            ~/.ownmind/mcp/index.js
[ OK ]  package_version      v1.17.82
[ OK ]  mcp_node_modules     99 modules
[ OK ]  server_health        https://kkvin.com/ownmind/health -> 200
[ OK ]  api_key_format       valid (len=22)
[ OK ]  api_credentials      authenticated
[ OK ]  git_hooks            3 hooks installed
[ OK ]  scheduler            launchd agent loaded

Summary:  8 passed, 0 warnings, 0 failed
Log:      ~/.ownmind/logs/self-check-...log
Upload:   succeeded
--------------------------------------------------
```

對齊 npm / docker / CI tool 工業標準 — `[ OK ] / [WARN] / [FAIL]` 三狀態，移除 emoji 跟 `=====` 雙線（換成 `─`），列對齊。

### 不動的部分
- 內部 log 檔內容（admin 看的，繁中 OK，無 encoding hazard）
- 程式碼註解（中文 OK，不是 stdout）
- IR rule / memory entries（個人化中文）
- Admin dashboard UI（另一回合）

**驗證**：
- npm test **858/858 pass**（一條原本 assert.match `/長度/` 的 test 改成 `/length|too short/i`）
- 沒有 prod-side 改動

**鐵律觸發**：IR-008 / IR-031 / IR-032 / IR-036（白話對應）/ IR-037（不中英混雜 — 這版執行徹底，stdout 純英文，但內部記憶/IR/註解保留繁中對 Vin 友善）

**升級指引**：對 user 完全無感（功能不變）。下次升級 vin-windows-test 不會再看到 mojibake。Mac/Linux user 看到一致的英文輸出。整體看起來像 npm/docker 級的專業工具。

## v1.17.81 — update.ps1 StackOverflow 根因修法 + update.{ps1,sh} 觀測管道補洞（vin-windows-test 第五輪）

**背景**：vin-windows-test 第五輪測試他的 AI 助手用 `find` 搜「*update*」抓到 `update.ps1`，跑下去：
```
OwnMind 同步更新中（Windows）...
   skills 已更新（ownmind-memory + ownmind-upgrade）
   升級規則已同步到偵測到的 AI 工具
   hook scripts 已同步
   usage scanner 已就緒
Process is terminated due to StackOverflowException.
```

兩個問題交錯：

### 問題 1：StackOverflowException（exit 253）
**Root cause**：`update.ps1` 4 處用 `@"..."@` 雙引號 heredoc 包 node JS 腳本。雙引號 heredoc 在 PS 內會做變數展開（`$var`、`$(...)`）。內含的 JS code 有大量 `$variables` 跟 `$(JSON.stringify(...))` 等 pattern，在 `Set-StrictMode -Version Latest` 路徑會觸發 PS 遞迴展開，**整個 PS process 死於 StackOverflow，沒任何錯誤訊息**。

**修法**：4 處 heredoc 全改 `@'...'@` 單引號 — 完全 disable PS 變數/subexpression 展開。JS code 內所有 `$` 原樣保留，由 node 自己 parse。

### 問題 2：update.{ps1,sh} 完全沒接 IR-038 觀測管道
v1.17.79/80 把 errors/ spool wiring 上去 install + interactive-upgrade，但 `update.ps1` / `update.sh` 完全沒接。所以 vin-windows-test 第五輪 server 端**完全看不到他跑了什麼、什麼版本、為什麼死**。

**修法**：兩支都加：
- 開頭送 `update_started` beacon（fire-and-forget + spool fallback，同 v1.17.80）
- dot-source / source `report-error` helper
- 包住 node child process 呼叫的 try/catch 加 `Report-Error -Kind update_settings_inject_failed`

### 問題 3：腳本命名混淆 — AI 把 update.ps1 當升級用
update.ps1 / update.sh 只是 light sync（skill + hook 檔案複製），但檔名「update」讓 AI 誤判為升級流程的入口。

**修法**：兩支檔頭加明顯註解：
> ⚠️ 這支只做 skill / hook / settings 同步，**不是完整升級流程**。
>    要升級 OwnMind 版本請改跑 `bootstrap.{sh,ps1}`。

下次 AI grep 看到這支會認得不該拿來當升級用。

**驗證**：
- 新增 `tests/update-script-observability.test.js`（8 條：禁雙引號 heredoc / 至少有單引號 heredoc 訊號 / update_started beacon / report-error 引入 / 檔頭提到 bootstrap — 兩支腳本各 4 條）
- npm test **858/858 pass / 0 fail**

**鐵律觸發**：IR-006（reproduction test 先寫）/ IR-007（vin-windows-test 第五輪持續性 bug — 同一條觀測盲點再次出現）/ IR-008 / IR-031 / IR-032 / **IR-038（觀測管道擴及 light path）✅**

**升級指引**：對 user 完全無感。下次 AI 助手如果跑 update.ps1 不會再 StackOverflow，且即使中途失敗 server 也看得到 update_started beacon + 失敗 kind，admin 可追蹤。

## v1.17.80 — install_started beacon 失敗 spool fallback（vin-windows-test 第四輪）

**背景**：vin-windows-test 確認自己升到 1.17.78，但 server DB 完全沒看到任何 beacon / heartbeat / install_check_logs 資料更新（最後 16:39:59 之後 0 row）。診斷出 v1.17.78 的 `Send-InstallBeacon` / `send_install_beacon` 是 **fire-and-forget**：

- PowerShell 版用 `try { Invoke-RestMethod } catch { }` 把錯誤吞掉
- bash 版用 `curl ... || true` 把錯誤吞掉
- 兩邊**都沒寫進 retry spool**，network blip / 401 / 5xx 直接資料丟失

v1.17.79 修了 errors/ spool 但這條沒涵蓋 — beacon 不算 fatal-path，是「該被觀測但不該擋」的 ping 訊號。

**修法**：beacon POST 失敗時 append body 到 `~/.ownmind/logs/.upload-spool.jsonl`（複用 v1.17.66 的 self-check spool）。下次 self-check `retrySpool()` 自動補傳：

### `install.ps1` Send-InstallBeacon
- POST 成功 → `return`
- POST 失敗 → catch + `[System.IO.File]::AppendAllText(spoolFile, body + "\n", UTF8NoBom)`
- BOM-less UTF-8（複用 v1.17.12 寫法，Node JSON.parse 不炸）

### `install.sh` send_install_beacon
- `if curl ...; then return; fi`（成功）
- 失敗走 `printf '%s\n' "$body" >> .upload-spool.jsonl`

**驗證**：
- 新增 `tests/install-beacon-spool-fallback.test.js`（4 條：Send-InstallBeacon 含 spool 寫入路徑 + BOM-less append / send_install_beacon 同 + return-on-success 結構）
- npm test **850/850 pass / 0 fail**

**鐵律觸發**：IR-006（reproduction test 先寫）/ IR-007（vin-windows-test 第四輪持續性 bug）/ IR-008 / IR-031 / IR-032 / **IR-038（觀測管道防漏）✅**

**升級指引**：對既有 user 完全無感。下次升級時若 beacon 上傳失敗（user 機器網路暫斷 / proxy / VPN）會自動進 spool，下次 self-check 補傳；不會再像 vin-windows-test 那樣 server 端完全看不到資料。

## v1.17.79 — 統一錯誤 spool 機制 + interactive-upgrade dirty tree 自動處理（vin-windows-test 第三輪）

**背景**：v1.17.77/78 修了 start.cmd fallback 跟 install_started beacon，但 vin-windows-test 第三輪測試發現他升級到 v1.17.78 沒成功（DB 看 collector_heartbeat 還停 1.17.75）。診斷出兩個結構性盲點：

1. **AI 助手 local edit 擋住升級** — 上輪他的 AI 編輯 mcp/start.cmd 加 fallback 沒 commit，下次 `git pull --ff-only` 直接被 reject、整個升級卡住
2. **client 端各種失敗都沒回報管道** — install / upgrade / hook / scanner / start.cmd 失敗都靜默死掉，server 完全看不到。v1.17.78 的 install_started beacon 只覆蓋 install 開頭，runtime 失敗（如 start.cmd 找不到 node）依然盲

**修法（廣域觀測管道）**：

### 1. `errors/` spool 統一機制
- 所有失敗點寫 `~/.ownmind/logs/errors/<unix_ms>-<kind>.json`（或 cmd.exe 寫 `.txt` key=value 格式）
- self-check.cjs 加 `drainErrorSpool()`：把目錄裡的所有檔案上傳到 `/api/debug/install-check`（v1.17.78 已放寬 endpoint），成功就刪、失敗下次再試
- Drain 觸發點：每次 self-check（含 install/upgrade 結尾、scheduler 跑 scanner、user 手動 trigger）

### 2. Cross-platform helpers
- `scripts/install-helpers/report-error.cjs` — Node 主力 helper（HOME 路徑 sanitize / context-file 讀尾 30 行 / atomic write）
- `scripts/install-helpers/report-error.sh` — bash function `report_error <kind> <detail> [context]`，內部呼叫 .cjs
- `scripts/install-helpers/report-error.ps1` — PowerShell `Report-Error -Kind ... -Detail ... [-ContextFile ...]`

### 3. interactive-upgrade.{sh,ps1}：dirty tree 自動處理
- 偵測 `git status --porcelain` 非空
- drop `upgrade_dirty_tree` error report（含 dirty file 清單）
- `git fetch && git reset --hard origin/main` 強制對齊（backup 已在前一步完成，安全網 OK）
- 既有 clean 路徑走 `git pull --ff-only` 不變

### 4. 失敗點 wire（每個 fatal-path 落 error report）
- `install.sh` / `install.ps1`：winget / git clone / git pull / npm install
- `interactive-upgrade.{sh,ps1}`：git pull / npm / verify
- `mcp/start.cmd`：找不到 node 時 echo `key=value` 到 errors\<ts>-mcp_start_no_node.txt，下次 self-check drain
- self-check 自身的 fail check 會經由 install-check spool 走（已存在）

**為什麼分 .json + .txt 兩種格式**：cmd.exe 寫 JSON 要處理 escape 太痛苦，讓 cmd 寫簡單 key=value，drainErrorSpool 內 `parseKeyValueText` 統一轉換。`.sh` / `.ps1` / `.cjs` 都呼叫 report-error.cjs 寫 `.json`。

**驗證**：
- 新增 `tests/error-spool-mechanism.test.js`（15 條：spool 寫檔 / 特殊字元 / context-file / drain 上傳刪檔 / drain 5xx 保留 / drain no-creds / drain no-dir / dirty tree 三條 sh + 三條 ps1 / start.cmd 寫 errors/）
- npm test **846/846 pass / 0 fail**（v1.17.78 → v1.17.79 多 15 條）

**鐵律觸發**：IR-006（reproduction test 先寫）/ IR-007（vin-windows-test 第三輪）/ IR-008 / IR-022（Server + Client 同時涵蓋 — 此次純 client 端結構性改動）/ IR-031 / IR-032 / **IR-038（觀測管道完善）✅**

**升級指引**：對既有 user 完全無感。下次升級碰到 dirty tree 會自動對齊（之前會 fail）；start.cmd 找不到 node 時不再靜默壞掉；admin dashboard 開始看到全 client 端各種失敗事件。

## v1.17.78 — install_started beacon 補 IR-038 觀測盲點（vin-windows-test 第三輪）

**背景**：vin-windows-test (user_id=8) 安裝後查 DB 發現 `install_check_logs` **0 row**。Root cause：

- `install.ps1` 中段任何 fatal error（npm install 被 ExecutionPolicy 擋、winget 失敗、git clone 失敗）都會 `Write-Error + exit 1`
- end-of-file 的 `self-check.cjs` 是「success path 才會跑」 — 中段死掉就沒紀錄
- vin-windows-test 真實案例：他卡在 npm install 那段（v1.17.76 修 ExecutionPolicy 之前），self-check 從來沒跑到 → admin 看不到他試過裝

v1.17.76 修了 ExecutionPolicy block 點，但中段其他失敗仍是同樣盲點。**IR-038 直接適用**：「修 bug 前必須先確保有足夠的觀測資料能持續追蹤該 bug」。

**修法（兩端對稱補洞）**：

### Server: `src/routes/debug.js`
- `POST /api/debug/install-check` 放寬欄位驗證：只強制 `ts`，`checks` / `summary` 改選填
- 接受 beacon-style minimal payload（`{ ts, trigger, client_version, platform, machine }`）
- 完整 self-check report（含 checks/summary）仍向後相容

### Client: `install.ps1` + `install.sh`
- API key/URL 確認後立刻送 `install_started` beacon（fire-and-forget，5s timeout）
- 失敗不擋 install（network 沒通也照樣裝得起來）
- 即使中段死掉，admin 至少看得到 user 8 試過、什麼版本、哪台機器、什麼 platform

**驗證**：
- 新增 `tests/install-started-beacon.test.js`（7 條：minimal beacon 接受 / 完整 report 向後相容 / 沒 ts reject / checks 非 array reject / status 不合法 reject / install.ps1 含 beacon code / install.sh 含 beacon code）
- npm test **831/831 pass / 0 fail**

**鐵律觸發**：IR-006（reproduction test 先寫）/ IR-008 / IR-022（Server + Client 同改）/ IR-031 / IR-032 / **IR-038（觀測管道完善）✅** ← 這版的核心目的

**升級指引**：純機制改善，user 完全無感。下次新 user 安裝就會有 install_started beacon 進 DB；vin-windows-test 那筆歷史 gap 不能補（資料沒了），但**未來不會再發生**。

**關於 token_events.native_cost_usd 的後續說明**：上輪報告誤判 — 這欄位是 client scanner 的 advisory data（可空），server-authoritative cost 在 `token_usage_daily` 由 nightly recompute（每日 03:00 Asia/Taipei）算。user 8 第一個 03:00 還沒過，`token_usage_daily` 才是空的（不是 pricing 缺）。`model_pricing` 表 Sonnet 4.6 已存在 3/15 USD/MTok。

## v1.17.77 — 修 v1.17.76 沒守到的下一層：start.cmd fallback + User PATH 持久化（vin-windows-test 第二輪）

**背景**：v1.17.76 修了「裝 OwnMind 時自動裝 node」，但 vin-windows-test 安裝完後 Claude Code 還是無法連到 OwnMind MCP。他的 AI 助手診斷出根因：

- winget 把 node 裝到 `C:\Program Files\nodejs\`，PATH 只更新 Machine scope
- **Claude Code 早就在跑**（PATH frozen 在啟動時），spawn `cmd.exe /c start.cmd` 時繼承的 PATH 是 stale 的
- `where node` 找不到 → MCP server 永遠起不來
- vin-windows-test 那邊的 AI 自己改了 `start.cmd` 加 fallback 才繞過 — 但這修在使用者本機，**沒回灌到 source = 下個新 user 還是中**

**修法（兩層守住）**：

### `mcp/start.cmd`（runtime fallback，守住「user 還沒重啟 Claude Code」窗口）
```
1. where node                                       (PATH 最快路徑)
2. C:\Program Files\nodejs\node.exe                 (winget 預設)
3. %ProgramFiles%\nodejs\node.exe                   (相容非 C: 系統碟)
4. %LOCALAPPDATA%\Programs\nodejs\node.exe          (winget --scope user)
```
全部 miss 時錯誤訊息列出每個試過的路徑 + 提示重啟 Claude Code。

### `install.ps1`（install-time 持久化，下次重啟後就不用 fallback）
- Install + version check 通過後，把 node 安裝目錄寫入 **User PATH**（`SetEnvironmentVariable scope=User`）
- User PATH 跟 Machine PATH 都不在 = append；已在任一個 = skip（idempotent）
- 寫失敗不致命（fallback 還在）

**驗證**：
- 新增 `tests/start-cmd-node-fallback.test.js`（5 條 contract test）
- npm test **824/824 pass / 0 fail**

**鐵律觸發**：
- IR-006（reproduction test 先寫）✅
- IR-007（Persistent Bug Protocol — vin-windows-test 第二輪回報，把 local 修補回灌 source）✅
- IR-008 / IR-031 / IR-032（package.json + 三語 README + FILELIST/CHANGELOG 同步）✅
- IR-022（Server + Client 兩端檢查 — 此次純 client 改動）✅
- IR-038（觀測資料 — 上次發現 install_check_logs 應有但沒有；此 commit 不修，列為下一輪）

**升級指引**：
- 既有已裝 user：跑 OwnMind 升級流程，會更新 start.cmd（runtime fallback 立即生效）+ install.ps1（下次裝才用得到）
- 全新 user：bootstrap 走完，PATH 會持久化、start.cmd 也有 fallback —**重啟 Claude Code 後即可使用**（不必重開 terminal）

## v1.17.76 — 缺 Node.js / git 時 install.ps1 + install.sh 自動安裝（vin-windows-test 回報）

**背景**：vin-windows-test 在 Windows 全新環境第一次跑 install.ps1，因為沒裝 Node.js 直接 `Write-Error + exit 1`，user 只看到「請到 nodejs.org 安裝」就卡住。同檔案第 42-61 行對 sqlite3 已有完整「winget auto-install + fallback」pattern，但 pattern **沒套到 node / git** — 對最常見的「全新 user」情境最不友善。從實際安裝 log 採證還抓到三個延伸問題：

1. **node 缺失只 Write-Error exit** — sqlite3 那段 pattern 沒套到 node / git
2. **winget 裝完當前 PowerShell session PATH 沒生效** — user 必須關 terminal 重開才能繼續
3. **PowerShell 預設 ExecutionPolicy 擋 npm install** — 中段 `npm install` 被擋住、`node_modules` 沒建好

**修法**：

### `install.ps1`
1. **入口設 `Set-ExecutionPolicy -Scope Process Bypass`** — 只影響當前 process，避免 user 預設 Restricted policy 擋 npm。
2. **`Reload-Path` helper** — 從 `Machine` + `User` scope 重組 `$env:Path`，winget 裝完直接生效，user 不必重開 terminal。
3. **`Install-WithWinget` helper** — 抽 sqlite3 那段 pattern 成可重用 function，wire 給 `git` (`Git.Git`) 和 `node` (`OpenJS.NodeJS.LTS`)。失敗時帶手動安裝 URL fallback。
4. **Node 版本驗 v20+** — winget OpenJS.NodeJS.LTS 偶爾 manifest 命名漂移到 v24（vin-windows-test log 確認），所以驗版本只擋過舊（< v20）不擋過新。

### `install.sh`
- **mac**：缺 node 時嘗試 `brew install node`（fallback 給 nodejs.org / brew.sh 連結）。
- **linux**：缺 node 時提示 apt / dnf / nvm 三選一指令（不自動 sudo）。
- **windows (Git Bash)**：缺 node 時提示改跑 install.ps1。
- **node 版本驗 v20+** — 跟 ps1 對齊。

**驗證**：
- 新增 `tests/install-prerequisite-auto-install.test.js`（7 條 contract test：ExecutionPolicy / winget OpenJS.NodeJS.LTS / Reload PATH Machine+User / winget Git.Git / Node v20 check / mac brew install node / linux apt|dnf 提示）
- npm test 819/819 pass / 0 fail（先 red 後 green、TDD 流程，IR-006）

**鐵律觸發**：
- IR-006（修 bug 前先寫 reproduction test）✅
- IR-008（commit 同步更新 README/FILELIST/CHANGELOG）✅
- IR-022（OwnMind 功能修改必須同時檢查 Server + Client 兩端 — 此次只改 client install scripts，Server 無影響）✅
- IR-031（package.json + 三語 README 版號同步）✅
- IR-032（OwnMind README 三語系必須同步更新）✅

**升級指引**：對既有 user 完全無感（已裝過 node 的人 detection 直接跳過）。新 user 第一次裝會看到「未偵測到 Node.js → 嘗試用 winget 自動安裝 OpenJS.NodeJS.LTS」訊息，全程不需手動干預。

## v1.17.75 — 文件化 Claude Code 體驗降級的根本原因（β 路線：保留 hook / 不再投資補救）

**背景**：v1.17.71 → v1.17.74 連續 4 版投資「OwnMind 在場感」hook 線（PostToolUse hook 寫 /dev/tty / fallback file），但 Vin 實測 + 對 claude-code-guide subagent 諮詢後得出 authoritative 結論：

- **/dev/tty 在 Claude Code spawn 的 hook subprocess 一律 ENXIO**（Mac/Linux 都不可用、app 環境更慘 — 連 controlling terminal 都沒）
- **hook 所有通道（stderr / stdout / additionalContext）都進 AI 那一側**，沒有「直接給 user 看」的內建管道
- **Issue #11120**「顯示 hook stdout」被 Anthropic **closed as not planned**（明確不打算做）
- **Claude Code 設計哲學**：chat 訊息流是 AI 獨佔，MCP / hook 不該繞過 AI 直接往 user UI 塞東西
- 但 Vin 在 **Gemini CLI** 跑同一個 OwnMind MCP server，**banner 自然嵌在訊息流、user 看得到** — 證實 OwnMind server 端設計沒問題、是 Claude Code 的 UI 哲學特殊

**結論**：OwnMind 的 banner 設計從 server 端做對了。**Gemini CLI / Codex CLI / Cursor / Copilot / OpenCode / Windsurf 等其他 MCP client 都會自然 work**（UI 不摺疊 + AI 老實轉述）— 只有 Claude Code 兩端都拒絕（UI 摺疊 + Claude 經常吞）。v1.17.71-74 那條 hook 線本質是「OwnMind 替 Claude Code 補它自己的 UX 缺陷」，**OwnMind 沒義務這麼做**。

**修法**：選 β 路線 — 保留 hook 當降級補救（不 revert，避免破壞已升級用戶），但**清楚文件化** Claude Code 體驗降級的事實，不再為了補 Claude Code 投資新 hook 通道。

1. **三語 README** 新增 `## Client Experience Matrix` / `## OwnMind 在不同 AI 客戶端的體驗` / `## 異なるAIクライアントでのOwnMind体験` 區塊（IR-032）：
   - 對照表清楚列出每個 client 的 banner 體驗 + 為什麼
   - Gemini CLI / Codex CLI / Cursor 等標 ✅ 最佳體驗（UI 不摺疊 / stdout 直通）
   - Claude Code 標 ⚠️ 降級體驗（UI 摺疊 + AI 獨佔 chat），鏈到 Anthropic Issue #11120
   - 解釋現有 hook 是「事後在場感」（next SessionStart 補印），不是即時
   - **建議使用 Claude Code 以外的客戶端**獲得最佳體驗

**對 Vin 的建議路線（不在這個 commit 做、列為長期方向）**：
- δ：把 OwnMind 投資轉去其他能贏的地方 — admin dashboard 月報 / IR-027 攔截型卡控（不是提醒）/ 給 Anthropic 提結構性 issue（MCP server 沒 user-visible 通道）

**驗證**：
- npm test 812/812 pass / 0 fail（無 code 改動、純 docs）
- 三語 README 內容對照（IR-032）

**鐵律觸發**：IR-008 / IR-026 / IR-031 / IR-032 / 透明度原則（誠實揭露技術限制）。

**升級指引**：純文件改動。用戶不會感覺到 client 行為差異 — 但**會在 README 看到「為什麼自己用 Claude Code 看不到 OwnMind banner」的明確說明**。建議改用 Gemini CLI / Codex CLI 等其他 MCP client 獲得最佳體驗。

## v1.17.74 — 深化結構性 contract test：把 1 條變 8 條、覆蓋 broadcast / multi-part / 空 parts / 壞 parts 變體（v1.17.73 m-1 / m-6）

**背景**：v1.17.73 加了一條結構性 contract test（兩種 tool_response shape 產出 block 必須一致），但只覆蓋一種 banner 文字（kind + tip 雙 banner）。Code review 點到（v1.17.74+ m-1）：broadcast / multi-part / 空 parts / 壞 parts 都沒測，那些路徑的 path-specific bug 還是漏。

**修法**：把 contract test 表化（`contractCases` array），用 `for` loop 為每個 case 生成獨立 `it`，覆蓋 8 種變體：

| # | case | 預期 |
|---|---|---|
| 1 | 單條 kind banner | 抽到 |
| 2 | 雙條 banner（kind + tip） | 抽到 |
| 3 | 廣播 banner（📢 OwnMind 系統通知） | 抽到 |
| 4 | 廣播 + 一般 banner 混合 | 抽到 |
| 5 | banner 拆到多個 content parts | 抽到 |
| 6 | 空 parts array | 不該抽到 |
| 7 | 壞 part（type 有但 text 缺） | 不該抽到 |
| 8 | 純文字沒 banner | 不該抽到 |

每個 case 都同時驗：(1) 兩種 shape 一致決定要不要寫 pending file、(2) 預期抽到時兩種 shape 的 block 內容必須完全相同、(3) 預期不抽到時兩種 shape 都不該寫 file。

**順便修 v1.17.73 m-6**：原本 contract test 用 `fs.unlinkSync(pendingFile)` 在兩次 runHook 之間清，沒檢查 file 是否存在 — 對「expectBanner: false」case 會炸（檔不存在）。改成 conditional：`if (aHasFile) fs.unlinkSync(pendingFile)`。

**Mutation test 驗證拆雷威力倍增**：

| Mutation | v1.17.73（單條 contract） | v1.17.74（8 條參數化） |
|---|---|---|
| legacy 路徑斷掉（回 `[]`） | 3 條紅 | **7 條紅** |
| broadcast trigger 改成只認 `📢 OwnMind 系統 XXX`（更嚴格） | 2 條紅 | 2 條紅 |

leg 路徑 mutation 多抓 4 條（kind / tip / broadcast / broadcast+banner / multi-part 變體）。

**誠實揭露 contract test 盲點**：mutation B（broadcast 識別改嚴）下，[廣播 + 一般 banner 混合] case **沒紅** — 因為一般 banner 還是被抓到、block 還有內容，雖然 broadcast 部分兩種 shape 都掉了但比對相等。「兩 path 一致 ≠ 行為正確」。靠原本「支援廣播 banner」的絕對比對測試補位才抓到。

**Lesson learned（記給未來）**：
- contract test（relative invariant）跟 absolute test（固定預期值）是互補關係，不能彼此取代
- contract test 抓 path-specific 漂移；absolute test 抓 path-independent 行為崩壞
- 一個結構良好的測試套要兩種都有，比例上 absolute 多、contract 少（contract 主要是給 multi-path 函數防 path-divergence 用）

**驗證**：
- npm test 812/812 pass / 0 fail（v1.17.73 是 805、+7 contract case，原本的 1 條取代成 8 條 → 淨 +7）
- 雙重 mutation test 跑通（legacy 路徑 / broadcast trigger）

**鐵律觸發**：IR-007（深化拆雷）/ IR-008 / IR-026 / IR-031 / IR-032。

**升級指引**：純測試重構，hooks 行為零改動。用戶不會感覺到差異。意義在於更廣泛的 path-specific bug 會被多條 contract case 同時抓到。

## v1.17.73 — 結構性拆 v1.17.71/v1.17.72 那種「fixture 集體偽陽性」雷（IR-007 follow-through）

**背景**：v1.17.72 修了 v1.17.71 那個「19 條 fixture 全部用同一錯誤 shape → 803/803 測試全綠但 prod 100% 壞」的 bug。但 v1.17.72 是點修補 — 只加了 1 條 IR-007 regression test 守住 (A) shape 那條路徑。如果未來有人手滑、把這條測試刪掉或改成跟其他一樣的 shape，又會回到 v1.17.71 的雷型（fixture 集體偏向某一 shape → 另一條路徑壞掉沒人發現）。Code review 把這列為 v1.17.73+ backlog M-1。

**修法**：把 fixture 結構抽成 helper、多條測試混搭兩種 shape、加 contract test，確保兩條路徑（MCP / legacy）任何一條壞掉都會被多條測試抓到。

1. **[tests/ownmind-tty-echo.test.js](tests/ownmind-tty-echo.test.js)**：
   - 新增 `mcpToolResponse(parts)` / `legacyToolResponse(parts)` 兩個 helper（fixture builder）
   - 把現有 banner 抽取相關測試遷移到 helper：4 條改用 `mcpToolResponse`（prod MCP 真實 shape），2 條（測試名明確談「content」的）保留 `legacyToolResponse`，IR-007 regression test 維持 prod 真實 captured payload
   - **新增結構性 contract test**「兩種 tool_response shape 在同一句 banner 文字下產出一致 block」— 用同一句 banner 餵兩種 shape，比對 block 必須一致；任何 path-specific bug 立刻被抓到

**Mutation test 驗證拆雷有效**：
- 故意把 extractBanners 的 legacy 路徑改成回 `[]`（破壞 (B) 路徑）→ **3 條測試紅**（contract test + 2 條明確標 legacy 的測試），不只 1 條
- 對比 v1.17.71 ship 時 19 條測試全綠通過（因為全部偏 (B) shape）— 現在多路徑混搭，**單路徑壞掉一定爆紅**

**驗證**：
- `npm test` 805/805 pass（v1.17.72 是 804、+1 contract test）
- Mutation test：legacy 路徑斷掉 → 3 紅；mcp 路徑斷掉 → 對稱結果（驗證對稱性）；還原 → 全綠

**鐵律觸發**：IR-007（核心：結構性拆雷，不只點修補）/ IR-008 / IR-026 / IR-031 / IR-032。

**升級指引**：純測試重構 + helper 抽取，hooks 行為零改動、prod 邏輯零改動。用戶不會感覺到差異。意義在於**未來再有 fixture/prod 不一致這類 bug，會被多條測試一起爆出來，不會再 803/803 全綠通過**。

## v1.17.72 — 修 v1.17.71 在場感 100% 失效（IR-007 雷型）

**背景**：v1.17.71 ship 後實測「在場感」完全沒出來。Vin 在新對話視窗用 OwnMind tool 都看不到 banner，跟 v1.17.71 commit message 講的「直寫 user terminal、不靠 AI 自律」結果相反。連續排查兩條路徑（`/dev/tty` 寫入是否成功、`banner-pending.jsonl` 是否累積 fallback record）都顯示 hook 跑了但完全沒抽到 banner。

**Root cause**：tests fixture 跟 prod 真實 PostToolUse stdin JSON 結構不一致 — 測試全綠但 prod 100% 抽不到 banner。

| | Hook 期望（fixture 用的） | Claude Code prod 真實送的 |
|---|---|---|
| `tool_response` 結構 | `{ content: [{type, text}, ...] }` | `[{type, text}, ...]`（直接 array） |

[hooks/ownmind-tty-echo.cjs](hooks/ownmind-tty-echo.cjs) 的 `extractBanners` 抓 `tr.content`，但 prod 的 `tr` 本身就是 array、`tr.content` 是 undefined → `contentParts = []` → `fullText = ''` → `banner_count: 0` → hook 直接 exit、連 fallback 都不寫。19 條測試全綠的原因是所有 fixture 都用 `{tool_response: {content: [...]}}`，跟 prod 不一致。**典型 IR-007 雷型 — 測試保護不到 prod**。

**修法**：

1. **[hooks/ownmind-tty-echo.cjs](hooks/ownmind-tty-echo.cjs)** `extractBanners`：同時支援兩種 `tool_response` 結構（直接 array → MCP tool / `.content` array → 其他 tool / 舊版）。改動 12 行 + 註解。
2. **[tests/ownmind-tty-echo.test.js](tests/ownmind-tty-echo.test.js)** 新增 1 條 IR-003 reproduction test，用真實 prod PostToolUse stdin 截下來的結構（含 `session_id` / `hook_event_name` / `tool_use_id` 等真實欄位），先紅後綠驗證 fix。

**驗證**：
- `npm test` 804/804 pass / 0 fail（v1.17.71 是 803、+1 IR-007 regression test）
- Local prod-spike：把 source 同步到 `~/.ownmind/hooks/ownmind-tty-echo.cjs`、清空 `banner-pending.jsonl`、觸發 `mcp__ownmind__ownmind_search` → jsonl 從 0 行 → 1 行、`block` 內容是預期的「【OwnMind v1.17.71】\n  記憶搜尋\n  技巧提示：...」格式
- 確認 `/dev/tty` 在 Claude Code spawn 的 hook subprocess 拋 `ENXIO`（No such device or address）→ `writeToTty` 必失敗、必走 fallback。這是 Claude Code 環境的客觀限制、不是 bug。

**鐵律觸發**：IR-003（先寫 reproduction test）/ IR-005（不 blind edit、加 trace 觀測再修）/ IR-007（核心 — 修 v1.17.71 自己埋的雷）/ IR-008 / IR-026 / IR-031 / IR-032 / IR-038（先 trace JSONL 觀測 stdin / banner_count，確認 root cause 後再動 source；trace 殘留已清）。

**升級指引**：純 client 端、server 不需重新部署。用戶升到 v1.17.72 後 `~/.ownmind/hooks/ownmind-tty-echo.cjs` 自動更新；既有 `~/.claude/settings.json` 的 PostToolUse hook 設定不用改。下次任意 OwnMind tool 呼叫，banner 會寫到 `~/.ownmind/logs/banner-pending.jsonl`，**重啟 Claude Code 開新 session** 時 SessionStart hook 補印到 stderr → user 看到。

**已知限制（v1.17.73+ backlog）**：`/dev/tty` 在 Claude Code hook subprocess 不可開啟，v1.17.71 的「即時在場感」設計前提在 Claude Code 環境下不成立。目前是「事後在場感」— 補印在下次 session 開頭、不是即時。要做到真即時要另尋通道（例如：user 自己 tail 一個專屬 log file、或 push notification）。

## v1.17.71 — OwnMind 在場感（presence）— 直寫 user terminal 繞過 AI 過濾（IR-027）

**背景**：v1.17.0 起 MCP tool result 末尾附「【OwnMind vX.Y.Z】XXX：YYY」banner 想讓 user 看到 OwnMind 持續運作。但 Claude Code UI 把 tool result 摺疊成卡片、user 完全看不到；AI 也常吞掉不轉述到 chat。Vin 反映「我在新對話視窗中還是沒出現這種訊息」。連續幾版（v1.17.69 合併單一 text part / Codex 第二意見建議降頻）都沒解決根本問題：**訊息走 AI / tool result 通道一定會被吃**。

**Vin 三條規格**：
1. 合規回報頻繁也 OK，所有 OwnMind 動作都要 user 看見
2. 同次觸發多條 banner 合併成一個招牌區塊
3. **嚴禁被 AI 過濾或吃掉** — fallback 不能走 stderr / stdout / additionalContext

**修法**：新增 PostToolUse hook 直寫 user terminal device，繞過 Claude Code hook output 系統。

1. **新增 [hooks/ownmind-tty-echo.cjs](hooks/ownmind-tty-echo.cjs)**（跨平台 Node helper）：
   - 從 stdin 讀 PostToolUse JSON、抓 tool_response.content 裡所有「【OwnMind vX】」 + 「📢 OwnMind」 開頭的 banner
   - 同次觸發合併成單一招牌區塊（招牌 header + 縮排 list、不重複 prefix）
   - 主路徑：`/dev/tty`（mac/linux）或 `\\.\CONOUT$`（Windows）— 直寫 terminal device、繞過 Claude Code
   - Fallback：寫 `~/.ownmind/logs/banner-pending.jsonl`（JSON Lines）給 SessionStart 補印
   - 不寫 stderr / stdout（PostToolUse stderr→AI / stdout→丟掉，都不符合規格 #3）
   - 永遠 exit 0、不擋 tool 流程

2. **新增 [scripts/install-helpers/add-post-tool-use-hook.cjs](scripts/install-helpers/add-post-tool-use-hook.cjs)**（idempotent）：
   - settings.json 不存在 → 建立
   - 已有其他 PostToolUse hook → append、保留既有
   - 已有 OwnMind hook → skipped、不重複加
   - 寫入前 `settings.json.bak.<ts>` backup、atomic tmp+rename、失敗 rollback

3. **修改 [install.sh](install.sh) + [install.ps1](install.ps1)**：MCP 設定後跑 helper 把 PostToolUse hook 加進 `~/.claude/settings.json`。

4. **修改 [hooks/ownmind-session-start.sh](hooks/ownmind-session-start.sh)**：開頭讀 `banner-pending.jsonl` 補印 + 清空。SessionStart 的 stderr 是 user-visible 通道（跟 PostToolUse 相反）。

**Reproduction tests 19 條（IR-003）**：
- [tests/ownmind-tty-echo.test.js](tests/ownmind-tty-echo.test.js) 11 條：banner 抽取、招牌區塊合併、廣播 block、多 content parts、空輸入 / 壞 JSON、fallback JSON Lines、**stderr/stdout 必須空白**（規格 #3 hard guarantee）、主路徑 tty 寫入
- [tests/add-post-tool-use-hook.test.js](tests/add-post-tool-use-hook.test.js) 8 條：settings.json 不存在 / 無 hooks 區塊 / 已有其他 PostToolUse / idempotent skipped / 壞 JSON not modified / backup 機制 / 絕對 path / matcher 正確

**鐵律觸發**：IR-003 / IR-005 / IR-007（防同類雷）/ IR-008 / IR-022（client 兩端 .sh + .ps1 同步）/ IR-026 / IR-027（核心：用邏輯卡控取代「AI 應該轉述」這種提醒式設計）/ IR-031 / IR-032 / IR-038（fallback 觀測管道）。

**驗證**：本地 `npm test` 803/803 pass / 0 fail（v1.17.70 是 784，+19 新 test）。額外做 local spike：用 heredoc 餵假 JSON 給 hook、強制 fallback 路徑、確認 `banner-pending.jsonl` 寫入正確的招牌區塊格式（header 單獨一行 + 縮排 list）。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Important**：`banner-pending.jsonl` 沒大小上限、non-tty long-running script 會無限長 → 加 1 MB rotate（超過就 rename 成 `.old` 覆蓋舊的，~10k records 上限）
- **Important**：原本 SessionStart 補印用 bash while loop 每行 spawn node，50+ banner 積壓會卡住 → 改抽出 [hooks/lib/flush-pending-banners.js](hooks/lib/flush-pending-banners.js)，stdin 一次讀完整檔
- **Minor**：拿掉 hook entry 裡的 `name` field（Claude Code schema 沒這個欄位，雖被容忍但不該依賴；改用 `command` 字串裡的 `ownmind-tty-echo` substring 識別 idempotency）

**升級指引**：純 client 端、server 不需重新部署。用戶升到 v1.17.71 後 `install.sh`/`install.ps1` 會自動把 PostToolUse hook 加進 `~/.claude/settings.json`（既有設定保留 + backup）。**重啟 Claude Code 後**下次任意 OwnMind tool 呼叫起，直接在 terminal 看到「【OwnMind v1.17.71】記憶搜尋…」banner，不靠 AI 自律。

## v1.17.70 — 升級備份自動清除（IR-027 邏輯卡控）

**背景**：`interactive-upgrade.sh` / `.ps1` 升級時會把舊版本備份到 `~/.ownmind.bak.<timestamp>/`，每份約 50 MB。`bootstrap.sh` / `bootstrap.ps1` 修復路徑的 log 訊息一直寫「3 天後可手動刪除」，但**全 repo 沒有任何邏輯實際清**，使用者忘了就無限累積。Vin 機器上累積到 **19 份 / 894 MB**（從 4/23 到 5/8 共 15 天）。違反 IR-027「提醒無效，邏輯才有效」。

**修法**：在升級成功末段補 sweep（IR-027 邏輯卡控）：

1. **[scripts/interactive-upgrade.sh](scripts/interactive-upgrade.sh)**：`OK "done"` 之前 `find $HOME -maxdepth 1 -type d -name '.ownmind.bak.*' -mtime +N -exec rm -rf {} +`，預設 N=7、可用 `OWNMIND_BACKUP_RETENTION_DAYS` 環境變數覆蓋。Sweep 失敗（權限 / 磁碟）不影響升級結果。
2. **[scripts/interactive-upgrade.ps1](scripts/interactive-upgrade.ps1)**：對稱實作，`Get-ChildItem $HOME -Directory -Filter '.ownmind.bak.*' | Where LastWriteTime -lt $cutoff | Remove-Item -Recurse -Force`。
3. **[scripts/bootstrap.sh](scripts/bootstrap.sh) + [bootstrap.ps1](scripts/bootstrap.ps1)** 的 log 訊息從「3 天後可手動刪除」改成「下次升級自動清除超過 7 天的舊備份」。

實際效果：每次跑升級都順手把 7 天前的舊備份刷掉，使用者零負擔。

**Reproduction tests 8 條（IR-003）**：
- 新增 [tests/sweep-old-backups.test.js](tests/sweep-old-backups.test.js)：用 `fs.utimesSync` 建假 fixture 驗 `find -mtime +N` 在 macOS BSD / Linux GNU 上行為一致；驗 `-maxdepth 1` 不會誤殺巢狀目錄、不會誤殺名稱類似但 prefix 不同的目錄（如 `.ownmind`、`.ownmind.cache`）；驗 retention 0 / 空目錄 edge case；驗 interactive-upgrade.sh / .ps1 含 sweep 邏輯、bootstrap log 訊息已換掉「可手動」字樣。

**鐵律觸發**：IR-003 / IR-005 / IR-008 / IR-022（client 兩端 .sh + .ps1 同步、server 不變）/ IR-026 / IR-027（重點：用邏輯卡控取代提醒）/ IR-031 / IR-032。

**驗證**：本地 `npm test` 784/784 pass / 0 fail（v1.17.69 是 776，+8 新 test）。

**升級指引**：純 client 端、server 不需重新部署。用戶下次跑升級就會自動清；現有的舊備份**這次升級立刻被清掉**（因為 sweep 邏輯是「升級到 v1.17.70 時跑」，不需要等下一輪）。

## v1.17.69 — MCP 回傳合併單一 text part（修 Claude Code 看不到技巧提示）

**背景**：Vin 回報「之前都會出現的技巧提示，現在 Claude Code 看不到，其他工具（Codex / Cursor / Antigravity）都看得到」。

**根因**：v1.17.0 起 [mcp/index.js:1139](mcp/index.js)（修法前）把 MCP 工具回傳組成 **4 個獨立的 `{ type: "text", text: ... }` parts**：broadcast / 前綴行 / JSON body / 技巧提示。多數 MCP client 會把全部 parts 順序合起來顯示，但 **Claude Code UI 對 tool result 用摺疊卡片渲染時，多 part 之間的視覺被吃掉、最後一段（tip）完全看不到**。技術上 server 一視同仁送相同 payload，AI 端也都收得到全部 parts，純粹是 client UI 渲染差異。

**修法**：把 4 個 part 合併成單一 text part，所有 client 渲染一致。新增 [mcp/lib/compose-tool-response.js](mcp/lib/compose-tool-response.js) 純函式封裝合併邏輯，[mcp/index.js](mcp/index.js) 改呼叫它。視覺版型維持跟 v1.17.68 之前各 client 看到的一樣（tag 跟 body 用「：」連接、body 跟 tip 之間留一個空白行）。

**Reproduction tests 8 條（IR-003）**：
- 新增 [tests/mcp-tool-response-shape.test.js](tests/mcp-tool-response-shape.test.js)：驗 `composeToolResponse` 必回單一 text part、各段視覺分隔、有無 broadcast / tip 都不會多空白
- 更新 [tests/tip-every-call.test.js](tests/tip-every-call.test.js)：原本 assert `contentParts.push(...)` pattern，改成 assert `composeToolResponse({ tip: getRandomTip(), tipTag: ... })` pattern；不變的是 tip 必須無條件附（不能再有 `% 10` 之類的閘門）

**鐵律觸發**：IR-003 / IR-005 / IR-008 / IR-022（純 client 修法、server 端不變）/ IR-026 / IR-031 / IR-032。

**驗證**：本地 `npm test` 776/776 pass / 0 fail（v1.17.68 是 768，+8 新 test）。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Important（visual regression）**：第一版把 tag 跟 body 用「：」inline 連接（`記憶搜尋：{...}`），多 KB JSON body 會被擠成超長一行、視覺上比舊 4-part 結構差。修法：tag 後接「：\n」當 header 行、body 換到下一行（`記憶搜尋：\n{...}`），跟舊 4-part 各 client 看到的版型一致。

**升級指引**：純 client 端修法，server 不需重新部署。用戶跟 Claude / Codex 說「升級 OwnMind」即可，下次 MCP 工具呼叫起 Claude Code UI 就會看到完整的回傳含技巧提示。

## v1.17.68 — settings.json `--update` 殘留地雷 + 401 觀測管道（IR-007 + IR-038）

**背景**：v1.17.67 修完 Windows scanner task 註冊問題後，Adam 用量報告 token 還是 0，scanner 跑出來全 5 個 client 一起回 401「無效的 API Key」。深入查 server 發現 Adam 的 `~/.claude/settings.json` 裡 `OWNMIND_API_KEY` 整個值是字串 `"--update"`（8 字元），不是合法的 API key。

**根因**：v1.17.9 之前 `install.ps1` 沒過濾 flag-like positional args，**舊版 `interactive-upgrade.ps1` 把 `--update` 當位置參數傳給 `install.ps1`，被當成 API key 寫進 `settings.json`**。Adam 是 2026-03-26 建帳號的早期用戶，當時版本沒有 args 過濾，他的 settings.json 從那天起就壞了。v1.17.9 之後修了 args 過濾，**讓未來不會再寫壞**，但**沒寫 migration 把已經中招的存量挖出來**。

**為什麼 6 週沒人發現**：
- Adam 的 token_events 表 0 筆（從建帳號到現在沒成功上傳一次）
- Adam 的 install_check_logs 表也是 0 筆 —— self-check 上傳本身吃 401，連 self-check 「我有問題」這個訊號都傳不到 server
- 自我檢查的 `api_credentials` check 只看 server 回 200/401，不看 key 字串本身格式 → red 但訊息只說「auth 401」，沒指出根因
- server 端 auth.js 401 path 沒留結構化 log，admin 從 docker logs 只看到「POST /api/usage/events 401 3ms」這種 access log，看不出是誰、key prefix 也沒留

**修法**：

1. **client 端：[scripts/install-helpers/self-check.cjs](scripts/install-helpers/self-check.cjs)** 加 `checkApiKeyFormat`（不打 server，純看 key 字串長相）：
   - 已知壞值清單：`--update` / `--upgrade` / `--install` / `--help` / `true` / `false` / `null` / `undefined` / `${OWNMIND_API_KEY}`
   - flag-like：以 `-` 開頭直接 fail
   - 長度 < 16 fail（合法 UUID 36 / custom prefix ≥ 20）
   - 含空白 / BOM / 控制字元 fail
   - 排在 `api_credentials` 之前，user 看到 `api_key_format: fail` 時 detail 直接點出歷史踩坑 + 修法路徑（admin UI 重發 / 重設 settings.json）

2. **server 端：[src/middleware/auth.js](src/middleware/auth.js)** 401 path 加 `logger.warn('auth_failed', {...})`（IR-038 觀測管道）：
   - 結構化欄位：`route` / `ip` / `masked_key`（前 4...後 4 + len） / `ua`（截 80 char）
   - `masked_key` 透過新 `maskApiKey()` 純函式產生：空 key → `<empty>`、< 8 char → `<too-short:N>`、長 key → `eb80...e0dc (len=36)`，admin 能反查 users 表又不會把 key 全文寫進 docker logs（PII 友善）
   - 沒帶 Bearer header 也 log（`masked_key=<no-bearer>`）
   - auth.js 第 4 個參數加 `deps={}` 給測試注入 logger / query，不影響 production 呼叫

3. **Reproduction tests 17 條（IR-003）**：
   - [tests/self-check.test.js](tests/self-check.test.js) 加 10 條 `checkApiKeyFormat` 測試（含 Adam 的 `--update`、各種已知壞值、flag-like、太短、含空白 / BOM、合法 UUID、合法 custom prefix）
   - [tests/auth-401-observability.test.js](tests/auth-401-observability.test.js) 新增 7 條（`maskApiKey` 邊界 + auth middleware 401 / no-bearer log shape）

**鐵律觸發**：IR-003 / IR-005 / IR-007 / IR-008 / IR-022 / IR-026 / IR-031 / IR-032 / IR-038。

**驗證**：本地 `npm test` 768/768 pass / 0 fail（v1.17.67 是 750，+18 新 test）。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Important（info-leak）**：`maskApiKey` 原本門檻 `< 8` 走 `<too-short:N>`，但 8 char key（如 Adam 的 `--update`）走到 `slice(0,4) + '...' + slice(-4)` 路徑會產生 `--up...date` —— admin 從 docker logs 把三個點移掉就拿到原文。提高門檻到 12（中間至少還有 4 char 被遮掉）；8 char 改走 `<too-short:8>`，自我檢查的 `checkApiKeyFormat` 會在 client 端先抓出來，server log 端不負責顯示這種 key 的 prefix。
- **Minor**：`x-forwarded-for` 取第一個 IP（forensics 要的是 client、不是 proxy chain）；`KNOWN_BAD` 加 `/help` `/?` 防 cmd 風格 flag 誤傳；auth.js 多加一行 comment 鎖 `fn.length === 3` 不變式（避免未來改 signature 把 middleware 變 Express error handler）。

**升級指引**：受影響用戶（v1.17.9 之前裝過、後來只升級沒重灌、settings.json 殘留 `--update`）跑 `~/.ownmind/install.ps1` 升到 v1.17.68 後，self-check 會在 `api_key_format` 欄位直接紅燈、訊息明確指向修法路徑。Admin 端 docker logs 也會看到 `auth_failed` 結構化 log，能主動發現未升級的用戶。

## v1.17.67 — v1.17.66 Windows scanner task hotfix + IR-007 防同類雷

**背景**：v1.17.66 上線後 Adam / Eric 兩位 Windows 用戶獨立回報 OwnMind 用量報告 token 數卡 0。診斷發現背景 token scanner 的 Task Scheduler 在他們機器上根本沒註冊。`self-check` 跑出 `scheduler ❌`，手動跑 `register-scanner-task.ps1` 才看到 PowerShell 直接 `throw`。

**根因**：[scripts/windows/register-scanner-task.ps1:103-107](scripts/windows/register-scanner-task.ps1)（修法前）v1.17.66 想加電池友善設定，用了 `-DontStartIfOnBatteries` 和 `-StopIfGoingOnBatteries` 兩個參數 —— 但這兩個都不是 `New-ScheduledTaskSettingsSet` 的合法參數名（正確名是 `-DisallowStartIfOnBatteries` 和反向 switch `-DontStopIfGoingOnBatteries`）。在 PS 5.1 + PS 7 都會直接 `throw`、整個 register 動作中斷、task 完全沒註冊。

而且 PowerShell 預設行為**本來就**是「電池上不啟動 + 切電池就停」，這兩個顯式設定根本多此一舉。

**為什麼 v1.17.66 的 reproduction test 沒擋住**：[tests/ps1-windows-compat.test.js:160-166](tests/ps1-windows-compat.test.js)（修法前）的 test 只 `assert.match` 那兩個壞 param 字串「存在」於檔案 —— 字串對 ≠ PowerShell 接受該 param。**測試驗了文字，沒驗語意**。這是 IR-007 Persistent Bug Protocol 要處理的同類雷。

**修法**：

1. **刪掉壞 param**：[scripts/windows/register-scanner-task.ps1](scripts/windows/register-scanner-task.ps1) 移除 `-DontStartIfOnBatteries` 和 `-StopIfGoingOnBatteries` 兩行；註解說明「PS 預設已是爛電池友善，不用顯式設定」
2. **反轉舊 test**：原本 assert「壞 param 存在」改成 `assert.doesNotMatch` 兩個壞 param **必須不存在**
3. **加 param 白名單驗證 test**（IR-007 防同類雷）：把 `New-ScheduledTaskSettingsSet` 區塊內所有 `-FooBar` 抽出來比對 PowerShell 官方參數白名單，未來再有人在這支腳本打錯 cmdlet param 立刻紅燈
4. **IR-038 觀測管道補強**：
   - [install.ps1:387-409](install.ps1) 跑 `register-scanner-task.ps1` 時 `Tee-Object` 把 stdout+stderr 寫到 `~/.ownmind/logs/register-task-<ts>.log`
   - [scripts/install-helpers/self-check.cjs:288](scripts/install-helpers/self-check.cjs) `detectSchedulerDetail` 新增 `readLatestRegisterLog()`，把最新一份 register log（最多 8KB）併入 `scheduler_detail.register_log`
   - 下次有人踩同類 PS bug，admin 從 `install_check_logs.full_log` 直接看得到 PS error stack，不用用戶手動跑指令貼回來
5. **修 v1.17.66 stale 訊息**：register-scanner-task.ps1 line 129 Write-Host 從「every 30 min」改成「every 120 min」（呼應 v1.17.66 的 interval 變更但漏改）

**鐵律觸發**：IR-003 / IR-005 / IR-007 / IR-008 / IR-021 / IR-022 / IR-026 / IR-031 / IR-032 / IR-038。

**驗證**：本地 `npm test` 750/750 pass / 0 fail（v1.17.66 是 749，新增一個 param 白名單驗證 test）。reproduction test 走完整 red-green：先反轉/新增 test 確認紅 → 修 .ps1 確認轉綠。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Critical**：白名單 test 的區塊比對 regex 抓到的是 `New-ScheduledTaskSettingsSet` 第一次出現的位置 —— 但這是註解區塊（line 102），不是實際 cmdlet 呼叫（line 114）。test 等於只在驗註解裡的 param 名，未來注入壞 param 到實際呼叫不會被抓。修法：regex 比對前先剝掉 `# ...` 註解。透過注入 `-BogusFakeParam` 到實際 cmdlet 確認 red → 移除注入確認 green，full TDD cycle 過。
- **Important**：`scheduler_detail.register_log.content` 走 `sanitizePath()`（PowerShell 錯誤訊息常帶絕對 path `C:\Users\<realname>\...`，user 名是 PII）。
- **Important**：install.ps1 多餘的 `New-Item` 移除（`~/.ownmind/logs` 已在 line 270-280 隨 `$GitHookDirs` 建好）。
- **Minor**：register-scanner-task.ps1 file header `每 30 分鐘執行一次` 補修為 120 分鐘。

**升級指引**：v1.17.66 受影響的用戶（升級後 token 用量報告卡 0）跑 `~/.ownmind/install.ps1` 再升一次即可，新版 register-scanner-task.ps1 會把 task 補上來。

## v1.17.66 — Windows 平台硬化 + 觀測管道修補（IR-038）

**背景**：2026-05-07~05-08 連續兩天 Eric/Adam 升 v1.17.65 都遭遇相同失敗劇本：升級主流程全 OK，但 `verify_local` 失敗連帶 `rollback` 失敗，仰賴雙重失敗才保住新版本。額外回報「OwnMind 觸發時不定時跳出 console 視窗，沒用 Claude 也跳」。深入調查發現是七個獨立 bug 累積，根因都在「shell / path / process spawn 假設了 Unix 行為」。這是第三波同類踩坑（v1.17.62 / v1.17.65 / v1.17.66），啟動 systematic-debugging Phase 4.5 架構性修補。

完整 spec：[openspec/changes/v1.17.66-windows-hardening/](openspec/changes/v1.17.66-windows-hardening/)。

**七個 bug + 修法**：

1. **#1 PowerShell `bash` 解到 WSL relay**（P0）
   - 觸發點：[scripts/interactive-upgrade.ps1:120,125,130](scripts/interactive-upgrade.ps1) 三處 bare `bash`
   - 根因：Windows 10/11 內建 `C:\Windows\System32\bash.exe`（WSL relay），沒裝 distro 也存在；PowerShell PATH 解析優先 System32
   - 修法：新增 [scripts/windows/lib/find-git-bash.ps1](scripts/windows/lib/find-git-bash.ps1) helper，三段式偵測（cache → 常見路徑 → where.exe 過濾）+ `bash --version` 確認是 Git Bash 而非 WSL

2. **#2 `execFile + shell:true` 在 Windows 被 cmd 包**（P0）
   - 觸發點：[scripts/install-helpers/self-check.cjs:195-197](scripts/install-helpers/self-check.cjs)
   - 根因：cmd.exe 把 PowerShell `Get-ScheduledTask | Select-Object` 的 `|` 當自己的 pipe operator，找 `Select-Object` 當外部命令失敗（Eric/Adam 兩台一字不差錯誤訊息）
   - 修法：新增 [scripts/install-helpers/safe-spawn.cjs](scripts/install-helpers/safe-spawn.cjs) helper（強制 `shell:false` + `windowsHide:true` + 5s timeout），self-check.cjs 改用 safeSpawn

3. **#4 升級失敗時 self-check 不被觸發、上傳 401 不重試**（P0）
   - 觸發點：[scripts/interactive-upgrade.ps1:122](scripts/interactive-upgrade.ps1) `Fail` exit 早於 line 172 self-check 呼叫；self-check.cjs 上傳失敗即丟
   - 根因：失敗路徑沒走 `try/finally` 結構；Adam 401 案例 server `install_check_logs` 表完全沒收到資料（最該收的時候反而靜默）
   - 修法：interactive-upgrade.ps1 整個流程包進 `try { ... } finally { Run-SelfCheckOnce }`；self-check.cjs 新增 `appendSpool` / `retrySpool` 機制（401 / 網路 / 5xx 寫進 `~/.ownmind/logs/.upload-spool.jsonl`，下次跑 self-check 開頭先補傳）

4. **#6 PowerShell `Out-File` 預設 UTF-16 BOM**（P1）
   - 觸發點：interactive-upgrade.ps1 六處 `| Out-File -Append $LogFile`
   - 根因：PS 5.x 預設編碼 Unicode（UTF-16 LE BOM），現代工具預期 UTF-8。Eric 的 upgrade log 中文 garbled
   - 修法：所有 `Out-File` 加 `-Encoding utf8`

5. **#7 Scanner Task Scheduler 跳 console 視窗**（P0）
   - 觸發點：[scripts/windows/register-scanner-task.ps1:78-100](scripts/windows/register-scanner-task.ps1)
   - 根因：`-LogonType Interactive` + console subsystem binary `node.exe` = Windows 必開 console window；`StartWhenAvailable` + 30 分鐘間隔 + catch-up 補跑 = 連跳幾個視窗
   - 修法：(a) 新增 [scripts/windows/run-hidden.vbs](scripts/windows/run-hidden.vbs) launcher（wscript.exe GUI subsystem），task action 改 `wscript.exe run-hidden.vbs node.exe scanner.js`，徹底隱藏；(b) `RepetitionInterval` 30 → 120 分鐘降頻 4×；(c) 加 `-DontStartIfOnBatteries` + `-StopIfGoingOnBatteries` 筆電友善

**架構性新增（Phase 4.5）— 三個共用 helper 防同類雷再現**：

- [scripts/windows/lib/find-git-bash.ps1](scripts/windows/lib/find-git-bash.ps1) — Git Bash 偵測，過濾 WSL relay
- [scripts/install-helpers/safe-spawn.cjs](scripts/install-helpers/safe-spawn.cjs) — Win32 friendly execFile 包裝
- [scripts/install-helpers/path-to-win32.cjs](scripts/install-helpers/path-to-win32.cjs) — MSYS `/c/X` ↔ Win32 `C:\X` 轉換（v1.17.67 修 Bug #3 verify-upgrade.sh 用）

**環境資訊收集擴充（IR-038 落實）**：

- self-check.cjs 新增 `collectEnv()`，每次上傳帶 `os_release / arch / node / home_format / msystem / shell_chain / encoding / bash_resolution / scheduler_detail`
- 全部資料 < 4KB，遠低於 server 端 `install_check_logs.full_log` 64KB 上限
- PII 友善：`home_format` 只記格式類別不傳實際 path，`node.exec_path` 走 sanitizePath
- 用途：admin dashboard 可直接看每台機器 bash 解析到 WSL relay 還是 Git Bash、PS 預設編碼是 UTF-16 還是 UTF-8、Task Scheduler 真實 state / last_run / next_run

**延 v1.17.67 的 bug 與功能**：
- #3 `verify-upgrade.sh:49` 餵 MSYS path 給 native `node.exe`（次要 bug，要 #1 修好才浮出）
- #5 Windows rollback 鎖檔（修了 #1 之後不會被觸發；要設計「停 MCP / Task Scheduler 再 rollback」protocol）
- Admin dashboard `install-check` 檢視頁（讓 v1.17.66 PR 規模可控、先讓 server 收 24~48h 真實資料）

**Reproduction tests（IR-003 + TDD red-green）**：

- [tests/ps1-windows-compat.test.js](tests/ps1-windows-compat.test.js) 加 11 條（Bug #1 / #6 / #7 / #4 try-finally）
- [tests/self-check.test.js](tests/self-check.test.js) 加 9 條（Bug #2 / #4 spool round-trip / collectEnv schema）
- 全部先紅、修完轉綠；抽樣 Bug #2 做完整 revert→紅→restore→綠 cycle 驗 reproduction 真能抓 bug
- 全 repo 749 / 749 pass / 0 fail

**鐵律觸發**：IR-003、IR-004、IR-005、IR-007、IR-008、IR-022、IR-027、IR-031、IR-032，並新增 IR-038 候選：「修 bug 前必須先確保有足夠的觀測資料能持續追蹤該 bug」。

**Eric / Adam 升級時請對照真機驗證的清單**（PR 描述會附）：
1. Find-GitBash 確實過濾 System32 WSL relay
2. interactive-upgrade.ps1 try/finally 保證 self-check 在升級失敗時仍跑
3. VBS launcher 真的隱藏 console 視窗
4. Task settings Battery 行為（拔電源不跑、跑到一半拔電源停）
5. detectBashResolution / detectSchedulerDetail / detectWindowsEncoding 三個 Windows-only collector
6. Spool 在「真實 server 401」時的補傳行為（目前 mock fetch 驗過）

## v1.17.65 — autostash fallback 死路徑修掉（清 v1.17.24 backlog）

**背景**：v1.17.23 引入 `git pull --autostash` 取代手動 stash／無 pop，並寫了 fallback「處理 git < 2.6 沒 --autostash 支援的舊版」。但 fallback 那條也帶 `--autostash` —— 主路徑會失敗的根因（git 太舊）在 fallback 一定再失敗一次，等於沒 fallback。Codex review 在 v1.17.23 抓到並 ack 過，但當時不阻擋上線、留進 backlog（[project_299](OwnMind 專案記憶)）。

**根因**：[mcp/index.js:1271-1282](mcp/index.js:1271)（修法前）兩個 try 區塊都帶 `--autostash`：

```js
try { await execFile('git', ['pull', '-q', '--rebase', '--autostash'], …); }
catch {
  try { await execFile('git', ['pull', '-q', '--autostash'], …); }  // ← 死路徑
  catch (e) { return fail('pull', e); }
}
```

**修法**：fallback 改 `git pull -q --ff-only` —— 不帶 `--autostash`、不帶 `--rebase`。

- 工作樹有未提交變更時，`--ff-only` 會明確拒絕 → 觸發 `logEvent('update_failed', step: 'pull')`，user 看 log 自己處理。
- 不再做手動 stash —— v1.17.22 已驗證沒 pop 會吞 user 變更（IR-007 Persistent Bug Protocol）。
- `--ff-only` 比裸 `git pull` 安全：避免自動產生 merge commit；要 fast-forward 才繼續。

**測試**：[tests/mcp-auto-update-cross-platform.test.js](tests/mcp-auto-update-cross-platform.test.js) 加 1 條 regression —— 從 mcpSource 抓主路徑後緊接的 fallback execFile 區塊，斷言不能再含 `--autostash`。修法前 fail（fallback args 是 `'pull', '-q', '--autostash'`），修法後 pass。

**v1.17.24 backlog 後續確認**：原 backlog 列三項，另外兩項早已隨他 PR 解掉，**這次只剩 autostash fallback**：
- ✅ 問題 2「lock cleanup 未來可能誤刪別 process 的 lock」── v1.17.60 已加 `_lockHeld` 旗標（[mcp/index.js:1184](mcp/index.js:1184) / `:1228`）。
- ✅ 問題 3「`update.ps1` / `update.sh` settings.json parse 失敗用空物件覆寫」── v1.17.60 已新增 [scripts/install-helpers/load-settings-safe.cjs](scripts/install-helpers/load-settings-safe.cjs)，parse 失敗 `process.exit(0)` 不洗檔；兩支 update script 全部改用 `loadOrSkip`。

## v1.17.64 — self-check 兩個小 bug 修正：endpoint 404 + auth header 401

**Vincent 反饋**：v1.17.63 上線後實測發現 self-check 的 `api_credentials` 檢查永遠 fail、上傳 log 也永遠失敗。Adam / Eric / Michelle 升完只會看到自己的本機被標壞，但其實是 self-check 寫錯了 — 不是他們的環境壞了。

**根因**：

1. `scripts/install-helpers/self-check.cjs:123` 把 `api_credentials` 檢查打到 `POST /api/init`，但 server 上根本沒這條路由（實際是 `GET /api/memory/init`，掛在 `src/app.js:73`），因此一律回 404。
2. 同檔 `:127` 跟 `:304`（上傳 log 的 fetch）帶的是自訂 header `X-OwnMind-API-Key`，但 `src/middleware/auth.js:10-12` 只認 `Authorization: Bearer <key>`，所以 server 看到請求直接擋下回 401。`mcp/index.js:276,349` 一直都是用 Bearer，是 self-check 落單寫錯。

**修法**（純 client-side 修正，server 不動）：

1. `scripts/install-helpers/self-check.cjs` `checkApiCredentials`：
   - URL 從 `/api/init` 改成 `/api/memory/init`。
   - method 從 `POST` 改回 `GET`（這條路由本來就是 GET、不需要 body）。
   - header 從 `X-OwnMind-API-Key` 改成 `Authorization: Bearer <key>`。
2. 同檔 `uploadReport`：上傳 `/api/debug/install-check` 的 header 同步改成 `Authorization: Bearer <key>`。
3. `tests/self-check.test.js` 加 2 條 regression test：
   - 攔截 `globalThis.fetch`，檢查 `checkApiCredentials` 真的打 `/api/memory/init` 並帶 Bearer header（不再帶舊的 `X-OwnMind-API-Key`）。
   - 401 回應仍然要判 fail（避免日後 server 換認證後 false pass）。

**驗證**：`node --test tests/self-check.test.js tests/debug-route.test.js` → 22 / 22 pass。

**升級指引**：v1.17.63 用戶（Adam / Eric / Michelle / Vincent）升 v1.17.64 後跑一次 `~/.ownmind/scripts/interactive-upgrade.{sh,ps1}` 或手動 `node ~/.ownmind/scripts/install-helpers/self-check.cjs --trigger=manual`，self-check log 會正確上傳 server，admin dashboard 才看得到誰真的有問題。

## v1.17.63 — 安裝/升級結尾自動 self-check + 上傳 log

**Vincent 反饋**：v1.17.62 修了 Adam 的 npm EINVAL，但發現 Adam 還有另一個 silent fail — 他的 Task Scheduler（Windows 排程器）從一開始就沒註冊好，scanner 從來沒跑、伺服器端從來沒收到他的 token 事件，使用一個多月才被發現。原因是 install.ps1 跑完印 ✅，但 ✅ 只代表「這個區塊沒 throw」、不代表後續元件真的會運作。需要一個自動驗證機制，每次安裝/升級後抓本機真實狀態。

**根因**：

1. `install.sh` / `install.ps1` 各區塊的 ✅ 印出來只表示該區塊執行到底，沒有實際驗證 launchd / Task Scheduler / systemd 真的收到註冊、scanner 能不能跑、git hooks 有沒有 +x。
2. 從 server 視角看不到使用者本機到底裝了什麼，只能等使用者主動回報才知道哪邊壞掉。
3. Adam 那種「以為裝好了、實際沒裝好」的 silent fail 在現有架構下要等很久才會被發現。

**修法**：每次安裝/升級結尾跑一遍 self-check，把當下本機所有元件的真實狀態抓下來。

**新增**：

1. `scripts/install-helpers/self-check.cjs` — 跨平台 Node 腳本，跑 7 項檢查：
   - `mcp_files`：`~/.ownmind/mcp/index.js` 在不在
   - `package_version`：`package.json` 是否合法 semver
   - `mcp_node_modules`：`mcp/node_modules` 非空
   - `server_health`：`GET /health`
   - `api_credentials`：`POST /api/init` 帶 API key 不能被拒
   - `git_hooks`：`pre-commit` / `post-commit` / `commit-msg` 三個鉤子在且可執行
   - `scheduler`：macOS 跑 `launchctl list`、Linux 跑 `systemctl --user is-active`、Windows 跑 `Get-ScheduledTask` 確認排程器真的註冊
   每項回 `pass` / `warn` / `fail` + 失敗修法指示。
2. `db/011_install_check_logs.sql` — 新表 `install_check_logs(user_id, ts, client_version, platform, trigger, machine, summary, full_log)`，存每次 self-check 上傳的 log。
3. `src/routes/debug.js` — 新 endpoint `POST /api/debug/install-check`：使用者 API key auth、payload 上限 64KB、寫進新表。
4. `tests/self-check.test.js` — 13 個測試（pure function + smoke check）。
5. `tests/debug-route.test.js` — 5 個測試（auth、成功寫入、缺欄位、過大 payload、DB 失敗）。

**修改**：

1. `install.sh` / `install.ps1` 結尾呼叫 self-check，trigger=`post_install`。
2. `scripts/interactive-upgrade.sh` / `.ps1` 結尾呼叫 self-check，trigger=`post_upgrade`。
3. `src/app.js` 掛 `/api/debug` 路由。

**Self-check 行為**：

- 每項檢查 5s timeout，整支 self-check 包 try/catch + `process.exit(0)` — 出錯**不擋**安裝/升級的「✅ 完成」訊息。
- 結果寫到 `~/.ownmind/logs/self-check-<timestamp>.log`（JSON）。
- console 印綠勾 / 黃驚嘆號 / 紅叉 + 失敗的修復指示。
- 自動上傳到 server `POST /api/debug/install-check`。Opt-out：`touch ~/.ownmind/.no-self-check-upload`。
- 隱私：上傳的 detail 字串先過 `sanitizePath()` 砍家目錄路徑。沒有 secrets / API key / commit message 內容。

**Server 端**：

- 新表 `install_check_logs`。Deploy 時要手動跑 migration（OwnMind 沒有 auto-migration runner）：
  ```
  ssh root@kkvin.com "docker exec -i ownmind-db psql -U ownmind -d ownmind" < db/011_install_check_logs.sql
  ```

**Dashboard UI 留下個 PR**：本 PR 先把資料收集起來。Admin 想看哪個 user 哪個 component 壞掉，目前用 SQL 直接查 `install_check_logs`：
```sql
SELECT u.name, l.ts, l.client_version, l.summary
FROM install_check_logs l JOIN users u ON u.id=l.user_id
WHERE l.ts > NOW() - INTERVAL '7 days'
ORDER BY u.name, l.ts DESC;
```

**升級方式**：v1.17.63 上線後，使用者下次跑 bootstrap 就會自動跑 self-check + 上傳。已經升到 v1.17.62 但還沒升 v1.17.63 的使用者要再跑一次 bootstrap 才會啟用。

## v1.17.62 — 修自動更新兩個 silent fail（Adam Windows / Michelle 心跳）

**Vincent 反饋**：production heartbeat 顯示 Adam（1.17.24 / win32）、Eric（1.17.45）、Michelle（1.17.20 / Mac）三個 user 卡很久沒上來。Server 已經 1.17.61，他們各卡 16~37 個版本之前。本來 backlog 是「等他們自己升級才能切 broadcast-filter fail-closed」（`project_290`），結果根本不會自己升級。

**根因**：

1. **Windows npm.cmd `EINVAL`（Adam 卡 1.17.24）**：Node v18.20.2 / v20.12.2 / v21.7.3 起為 CVE-2024-27980 安全修補，禁止 `child_process.execFile` 直接呼叫 `.cmd` / `.bat`，要 `shell: true` 才行。`mcp/index.js:1286` 的 `execFile(NPM_CMD, ['install', '-q'], ...)` 在 Adam 那邊就吃這個 EINVAL，整個自動更新中斷。從 activity log 看到 `update_failed step=npm error=EINVAL`。

2. **MCP process cached `CLIENT_VERSION`（Michelle 卡 1.17.20）**：`mcp/index.js:154` 把 `CLIENT_VERSION` 在 module-load 時當常數讀進來。MCP 是長跑 process，user 不關 AI 工具就一直開著。自動更新成功 → 磁碟上 package.json 是新版 → 但這個 process 記憶體裡還是舊 `CLIENT_VERSION`。`sendMcpHeartbeat` 用 cached 值且 `heartbeatSent` 旗標每個 process 只送一次心跳 → 長跑 process 永遠回報舊版號。Michelle 02:19 有 `update_applied`、09:11 五個工具同時心跳回報 1.17.20，就是這個。

**修法**：

1. `mcp/index.js:1286` `execFile(NPM_CMD, [...])` 加 `shell: IS_WINDOWS`。Mac / Linux 不受影響、Windows 走 shell 才能跑 `.cmd`。
2. `mcp/index.js` `runAutoUpdate` 在 `logEvent('update_applied', ...)` 之後重發一次心跳，用 `fs.readFileSync` 讀**磁碟上**的 `package.json`、回報新版號。同時不更新 cached `CLIENT_VERSION`（保守 — 只動心跳，process 內其他 callsite 用 cached 不變，下次 process 重啟自然會更新）。

**升級方式**：v1.17.62 上線後，**user 仍然要再跑一次 `bash ~/.ownmind/scripts/bootstrap.sh`** 把 disk 升到 1.17.62 並重啟 MCP（讓新代碼生效）。從 1.17.62 之後的自動更新就會自己處理 — 升級後立刻補心跳、Windows 也不會再 EINVAL。`project_290`（broadcast-filter fail-closed）解 blocker 之後可以切。

## v1.17.61 — /me 報告頁加 MCP 通道盲點提示

**Vincent 反饋**：`project_310` 第 5 項（非 MCP 介面盲點標示）。OwnMind 的 client 是 MCP server，只能看到走 MCP 通道的 AI 工具呼叫。但實際工作上很多 AI 使用是走網頁版（claude.ai / ChatGPT / Gemini Web 等）或非 MCP 終端，這些活動 OwnMind 完全看不到。報告頁卻沒有任何說明，使用者誤以為看到的就是全部活動。

**根因**：先前 `/me` 報告頁的 audit findings 只有在「14 天 0 activity」才觸發 `unobservable_source` finding，但實際上即使有少量 MCP activity，使用者可能一半時間在網頁版 AI、那半也是不可觀測。沒有固定提示說「我只看 MCP 通道」。

**修法**：`src/public/me/index.html` 在 4 個 tab 之上、`<main>` 最上方加一個 `.blindspot-notice` 區塊（淡藍色 left border，視覺輕量、不擋功能），告訴使用者：「OwnMind 看不到的活動：透過網頁 AI、未裝 OwnMind 的工具、或 MCP 通道以外的活動都不會出現在這個報告。實際 AI 使用量可能比這裡看到的多。」全部 tab（個人 / 團隊 / 專案 / 整體分析）都看得到。

**為什麼選固定提示而非 audit finding**：
1. 這是設計層問題（無完美解），不是「異常觸發」的事件 — fixed notice 比 dynamic finding 更誠實
2. 加 finding type `partial_blindspot` 要先決定「異常閾值」是什麼，閾值定錯反而誤導
3. 固定提示一次寫清楚、所有使用者都看得到、不需要計算就能落地

**沒做的部分**：`project_281` 第 E 項（dashboard machine 加 OS / scanner_version 副欄位）已經在 v1.17.17 一系列改動中實作完成，`src/public/index.html:1530-1536` 已渲染 `machine_meta`，backlog memory 過期。

## v1.17.60 — update.sh / update.ps1 settings.json 安全讀取 + 自動更新 lock 旗標

**Vincent 反饋**：v1.17.59 之後 `project_299` 還剩兩項技術債（第 2 跟第 3）一起清掉。第 1 項（`--autostash` fallback 對 2015 年前的 git 失效）太邊角不做。

**根因**：
1. **settings.json 損壞會被洗掉**：`update.sh` / `update.ps1` 各有四個 `node -e` 區塊在裝 hook 時讀使用者的 IDE 設定檔（Claude / Gemini / Copilot / Cursor）。其中 Gemini / Copilot / Cursor 三個用 `try { JSON.parse(...) } catch {}` 吃掉錯誤後帶著空 `{}` 繼續走，最後 `writeFileSync` 把空物件寫回原檔，使用者損壞但有資料的設定會被洗掉、無法救回。中等嚴重，沒實際 bug 報案但風險真的存在。
2. **自動更新外層 `catch` 可能誤刪別 process 的 lock**：`runAutoUpdate().catch` 一律 `unlinkSync(LOCK_FILE)`，目前 code path 都在拿到 lock 後才會 throw 所以沒事；但未來只要有人改動引入「拿 lock 之前 throw」的路徑（例如 stale lock 偵測或 `fetch MARKER_FILE` 失敗），外層 catch 就會把另一個 MCP process 正在持有的 lock 砍掉，兩個 process 同時做 `git pull` / `npm install`、衝突或損壞。低嚴重度但 preventive。

**修法**：
1. 新增 `scripts/install-helpers/load-settings-safe.cjs`：純函式 `loadOrSkip(path, fallback)`，檔案不存在回 fallback、檔案壞掉印警告 + `process.exit(0)`（直接退出 node、後面寫檔不會跑到、原檔保留）。`update.sh` 4 處 + `update.ps1` 4 處全部換成這個 helper。`exit(0)` 是因為 update 腳本不該因為一個 hook 區塊壞掉就整支爆掉、要繼續跑下一個區塊。
2. `mcp/index.js` `runAutoUpdate` 加 module-scope `_lockHeld` 旗標：`fs.openSync(LOCK_FILE, 'wx')` 成功才 set 為 `true`，cleanup 跟外層 catch 都先檢查旗標，只在自己持有時才 `unlinkSync`。

**測試**：`tests/load-settings-safe.test.js` 5 case：檔案不存在 / 有效 / 壞掉不覆寫 / 壞掉但 caller 後面想寫也不會洗掉原檔 / 讀不到（權限）。`process.exit(0)` 行為以 `spawnSync` 跑 subprocess 驗證 exit code 跟 stderr。

**升級方式**：純內部硬化，無 API 行為改變、無使用者操作。Server / client 升到 1.17.60 即可。

## v1.17.59 — `mcp/index.js` 三項硬化（記憶體上限 + 錯誤訊息消毒 + 滑動時間窗去重）

**Vincent 反饋**：v1.17.58 的 Codex review 之後 ack 過、留下的 5 項技術債清掉前三項（`project_310` 第 2 / 3 / 4）。

**根因**：
1. `complianceEvents` 陣列只在 init 時清空，long session 持續累積，理論上會無限大、最後吃光記憶體。
2. `autoComplyForToolCall` 的三個 `console.error` 直接把 `e.message` 噴到 stderr，可能含家目錄路徑、API key 樣式字串等敏感資訊。
3. `_autoComplyDedup` 用 `Math.floor(Date.now() / 60000)` 當 bucket key，分鐘交界（59→00）連打的兩次會被分到不同 bucket、兩次都通過去重檢查（計數膨脹）。

**修法**：
1. `shared/helpers.js` 新增 `pushBounded(arr, item, maxSize)` 環形緩衝 helper，超過上限自動丟最舊。`complianceEvents` 兩個 push 站點改用，上限 500 筆（常數 `COMPLIANCE_EVENTS_MAX`）。
2. `shared/helpers.js` 新增 `sanitizeErrorMessage(msg, maxLen=80)` — 把家目錄路徑換成 `~`、`sk-...` / `Bearer ...` 樣式字串換成 `<redacted>`、超長截斷補 `...`。`autoComplyForToolCall` 的 3 個 `console.error` 全部套用。
3. `shared/helpers.js` 新增 `shouldSkipDuplicate(map, key, ttlMs, now)` 滑動時間窗去重 helper：用 `Map<key, first_seen_ts>`，60 秒內看過就 skip、不 slide 時間戳（讓最終會過期）；每次呼叫順手 GC 過期項目。`_autoComplyDedup` 從 `Set` 改成 `Map`，dedup key 拿掉分鐘 bucket。

**測試**：`tests/mcp-hardening.test.js` 新增 17 個測試 case，涵蓋三個 helper 的快樂路徑、邊界、邊角案例（含分鐘交界 bug 的回歸測試）。

**升級方式**：純內部硬化，無 API 行為改變。Server / client 升到 1.17.59 即可。
## v1.17.58 — IR-024 邏輯卡控（commit-msg hook 阻擋 `Co-Authored-By`）

**Vincent 反饋**：IR-024（Git commit 絕對不加 `Co-Authored-By`）目前只在 dashboard 上顯示提醒，依賴 AI 自覺。違反 IR-027「提醒無效，邏輯才有效」。要求改成 git hook 強卡。

**根因**：之前 IR-024 是軟性規則 — 寫在 OwnMind dashboard 的鐵律列表，靠 AI 看到提醒主動避免。但實際上 AI 經常忘記、寫 commit 訊息時還是會加 `Co-Authored-By` trailer。沒有任何技術機制阻擋。

**設計決定（為什麼放全域）**：第一版原本想做 per-repo 的 hook（`scripts/git-hooks/` + npm postinstall 設 `core.hooksPath`），但 OwnMind 本身就是「全域 git hooks 產品」（`install.sh` 已把 `~/.ownmind/git-hooks/` 設成 global hooksPath，裡面有 `pre-commit` 跟 `post-commit`）。per-repo 的 local config 在 worktree（工作樹）會被 worktree config 覆蓋，根本贏不了全域設定。改放全域：跟 `pre-commit`、`post-commit` 同一套機制，自動覆蓋使用者所有 repo。

**修法**：
1. 新增 `hooks/ownmind-git-commit-msg` — bash 鉤子腳本。用 `grep -qiE '^[[:space:]]*Co-Authored-By:'` 偵測，case-insensitive、行首有 trailer 格式才擋（避免誤殺敘述文字）。三行錯誤訊息（IR-024 違反 / Vin 鐵律 / 強制覆蓋用 `--no-verify`）。
2. `install.sh` 加 5 行 — 仿 `pre-commit` 寫法把 hook 複製到 `~/.ownmind/git-hooks/commit-msg` 並 `chmod +x`。
3. `install.ps1` 加對應邏輯 — 用 `Copy-AsLf` 強制 LF 行尾（防 Windows `core.autocrlf` 把 sh script 轉 CRLF 導致 `Exec format error`）。
4. `tests/git-hook-co-authored-by.test.js` 7 個測試 — 涵蓋三種大小寫變體（`Co-Authored-By` / `Co-authored-by` / `co-authored-by`）、縮排、純文字 / `Reviewed-by` / 文字偶然提到「co-authored」三種不該擋的情況。
5. `package.json` 版號 1.17.57 → 1.17.58。

**升級方式**：使用者自動更新時會帶到新檔案；新版 `install.sh` / `install.ps1` 會在下次重跑時把 `commit-msg` 安裝到 `~/.ownmind/git-hooks/`。已安裝舊版的使用者需要重跑 `install.sh` 或 `install.ps1` 才會啟用 commit-msg hook（pre-commit / post-commit 不受影響）。

## v1.17.57 — 整體分析報告改正面肯定 + 拿掉冗餘描述句

**Vincent 反饋**：
1. 報告寫「Adam 一個人做了 491 輪，他如果離職這個專案會接不下去」這種把個人當風險的話不 OK，應該寫成正面肯定（貢獻極大、認真開發）。
2. 「📊 整體分析」標題下「過去 N 天的全團隊使用分析。機械段秒回；AI 洞察開頁自動觸發、伺服器端 cache 1 小時。」這句技術細節描述拿掉。

**根因（個人風險評價）**：`src/lib/llm-narrative.js` SYSTEM_PROMPT rule 3 的「✓ 具體」範例就是「Adam 離職這個專案會接不下去」，rule 6 也允許「指出某人扛太多」這類風險。LLM 直接照範例輸出。違反 Vin 的工作原則「分析報告若會被被分析者看到，預設要對事不對人」。

**修法**：
1. `src/lib/llm-narrative.js` rule 3 範例改正面肯定 — 「funit-v2 全部 491 輪由 Adam 一個人完成，是這個專案最主要的開發者，貢獻極大、開發很認真」。
2. rule 6 強化：明確禁止「某人扛太多」「某人離職就接不下去」「bus factor」這種把個人當風險的話；高貢獻者用「主要開發者、貢獻極大、開發認真」這類肯定語氣。
3. `src/public/me/index.html` 拿掉「過去 N 天的全團隊使用分析…」描述句（標題 📊 整體分析 已自說明）。
4. `tests/llm-narrative.test.js` 加新 test pin 正面肯定詞 + 個人風險禁用詞。

## v1.17.56 — 修 v1.17.55 的兩個顯示問題（Tokens 全空 + 長專案名）

**Vincent 反饋**：「為何沒有數字」「ai_kol (kol_content_system 新版：...) 的專案名稱還是太長」。

**根因 1（Tokens 全空）**：v1.17.55 用 `(user_id, tool, session_id)` JOIN `token_usage_daily`，但 prod DB `session_logs.session_id` **過去 60 天 0 筆有值**（writer 沒填）。token_events / token_usage_daily 由獨立的 token-collector 寫入，session_id 是真實 UUID 但跟 session_logs 對不上 — JOIN 永遠 NULL。

**根因 2（專案名長）**：「ai_kol」「ai_kol (kol_content_system 新版：...)」是同一個專案，被 `LOWER(TRIM())` 後 key 不同，分裂成兩列；長 key 的描述也直接顯示。

**修法**：
1. `src/routes/me-narrative.js` project_ranking 改用 `(user_id, tool)` bridge —
   先在 `usr_tok` CTE 加總每個 user × tool 的期間總 tokens / cost，再依 `proj` (user, tool, project) 的 turns 比例分配。是估算值但有意義。
2. 同時三個 SQL（narrative + me.js × 2）都加 `REGEXP_REPLACE(project, '\\s*[\\(（].*$', '')` 砍掉「( ... )」描述，全形半形括號都吃；自動合併分裂列。
3. `src/public/me/index.html` `renderProjectRankingTable` 表頭加 `*` 符號，下方註明「估算值（按各專案輪次比例分配）」，誠實標示。

**為何不直接修 session_logs writer**：那是 client side 的事（要等所有 client 升上去 + 等 14d 資料累積），estimation 是當下唯一能讓欄位有用的辦法；長期該補。

## v1.17.55 — 各專案活動量排行表加 Tokens + 成本欄

**Vincent 反饋**：「9. 各專案活動量排行 應該要有期間累計消耗的 token 數」。原表只顯示 sessions / 輪次 / 貢獻者，看不出哪些專案燒最多 token、最花錢。

**修法**：
1. `src/routes/me-narrative.js` 9.project_ranking SQL 加一個 CTE，從 `token_usage_daily` 用 `(user_id, tool, session_id)` JOIN，按 `last_ts ${tfTs}` 過濾期間，加總 5 種 tokens（input + output + cache_creation + cache_read + reasoning）和 `cost_usd`。
2. `src/public/me/index.html` `renderProjectRankingTable`：表格加「Tokens」「成本」兩欄，tokens 沿用既有 `fmtBig`（1.2M 格式），成本顯示 `$X.XX`（不滿 $1 用 4 位小數），無資料顯示「—」。

**為何選 token_usage_daily 而非 token_events 直接 JOIN**：
- daily 表 `cost_usd` 已用 `model_pricing` 算好，免重做計價邏輯。
- 用 `last_ts ${tfTs}` 過濾比掃 events 快很多（daily 已 dedupe 到 session × date）。
- session_logs 用 LEFT JOIN，沒 token 資料的 session 顯示「—」不會被排除。

**測試**：`tests/me-narrative.test.js` 用 fakeQuery 回空 rows，schema 不變仍綠。

## v1.17.54 — 整體分析 LLM prompt 改寫（友善白話 + 踩坑三段式）

**Vincent 反饋**（v1.17.53 ship 後）：
1. 「第二名 Michelle 是潛在大使人選」— 「大使」是行銷術語管理者看不懂
2. 「10. 各專案最常踩什麼坑」每條只有一句話，沒講影響也沒講怎麼改善
3. AI 把自己的流程心得（「我觸發了完整 brainstorming skill」）當成「踩坑」寫進報告

**問題根源**：`src/lib/llm-narrative.js` 的 `SYSTEM_PROMPT`：
1. 範例用「潛在大使人選」這種行銷詞，LLM 模仿就會輸出行話
2. `project_friction` schema 只是字串陣列，沒位置放「影響」「改善」
3. 規則 5 只說「萃取實質踩過的坑」，沒禁止 AI 把自己的流程心得當坑

**修法**：
- `src/lib/llm-narrative.js` SYSTEM_PROMPT：
  - Rule 2 範例改寫：「第一名 Vin 用了 40% 的 AI 工作量，第二名 Michelle 也很常用，用了 25%，是在團隊中最常用 AI 完成工作的人」
    （加排名 + 給實際比例 + 把名次轉成角色定位 + 不用「大使」「分流」「扛」這類行話）
  - Rule 5 schema 改三段式：`{ what, impact, mitigation }`，明確指定每段要寫什麼，
    沒明確證據時填「影響不確定」/「需找 PM 釐清根因」（不要編）
  - 新增規則 7：禁用行話清單（大使／賦能／對齊／閉環／bus factor／分流／扛）
  - Rule 3/4 既有範例同步改白話（去掉「bus factor=1」、「賦能」這類詞）
- `src/public/me/index.html` `renderNarrativeInsights()`：
  - 新增 `renderFricItem()` 渲染三段式：what 加粗、影響/改善各一行 13px 灰字
  - 向下相容：舊版字串資料（cache 還在的話）仍能渲染

對使用者的好處：
- 報告讀起來像同事在講話、不像顧問報告
- 每個踩坑都看得出「為什麼要在意」「下一步要幹嘛」
- AI 自言自語不再混進真正的痛點清單

## v1.17.53 — 誠信表 UX 強化（問題優先排序 + 雜訊過濾 + 違反高亮）

**Vincent 反饋**（v1.17.52 ship 後）：「per-user 拆完後表變得很長，
按使用者字母排還是要自己掃；應該讓問題第一眼看到。」

**問題**：v1.17.52 把誠信表拆 per-user 後，30 條鐵律 × 多 user 時：
1. 多數 cell 是 0（user 沒觸發過該鐵律），表變得又長又稀疏
2. 排序按使用者名稱字母 → 違反次數高的列散落各處，要自己滑
3. 違反次數跟其他數字同色，視覺上沒有警示

**修法**：在 v1.17.52 per-user 設計上疊三項 UX 強化：
- `src/routes/me-narrative.js` compliance query：
  - 加 `WHERE (s.comply + s.skip + s.violate + s.observed) > 0` 過濾全零列
  - `ORDER BY` 改成 `s.violate DESC, u.name NULLS LAST, s.rule_code`，違反次數高的排最前
- `src/public/me/index.html` `renderComplianceTable()`：
  - 違反次數 > 0 時 cell 加紅色加粗（`#dc2626` + `font-weight:600`）

per-user title JOIN 邏輯沿用 v1.17.52，不動。

## v1.17.52 — 整體分析誠信表加「使用者」欄

**Vincent 反饋**（v1.17.51 ship 後）：「如果每個人的 IR 都不一樣，應該要列出是哪位 user 的 IR。」

**問題**：v1.17.51 雖然帶上了 IR title，但仍是團隊合計（GROUP BY rule_code），
然後用 `DISTINCT ON` 任意挑某個 user 的 title 當共用。當不同 user 的同 code
鐵律 title 不同時（例如客製版本），會挑到誤導性標題。

**修法**：
- `src/routes/me-narrative.js` compliance query 改 `GROUP BY (user_id, rule_code)`
  JOIN `memories` 用 `(user_id, code)` 配對，每筆都是「該 user 自己的鐵律 title」
- `src/public/me/index.html` `renderComplianceTable()` 多一欄「使用者」
- 排序：使用者名稱 → IR 代號

每個 user 沒對應 memories 紀錄時 title 留白（不誤導）。

## v1.17.51 — 整體分析誠信表 IR 代號加白話說明

**Vincent 反饋**（v1.17.50 ship 後）：「這些 IR 是每個人都不同？可以多寫一句話去說明，這樣沒頭沒尾看不懂。」

**問題**：v1.17.47 的整體分析（敘事）誠信表只列 `IR-024` 這種代號，
讀者沒看過鐵律本人會完全不懂指什麼。個人分析早就有 title 顯示，
敘事這支 SQL 沒 JOIN `memories`，title 沒帶上來。

**修法**：
- `src/routes/me-narrative.js` compliance query 改成 CTE：
  stats（活動統計）+ titles（`DISTINCT ON (code)` 取 `memories.iron_rule.title`，
  跨使用者用最新更新的版本作為共用標題）
- `src/public/me/index.html` `renderComplianceTable()` 改用個人分析同款排版：
  代號粗體在上、title 灰字小字在下（`<br><small>`）

每個 user 鐵律可能不同（含客製版本），LEFT JOIN 對不上 title 時保持空白不顯示。

## v1.17.50 — 整體分析事件代號加白話說明

**Vincent 反饋**：「這些英文代號可以加上簡短說明嗎？例如 `update_check`（檢查 OwnMind 版本）」

新增 `EVENT_LABELS` 對照表，整體分析的「動作類型」「軟體更新健康度」兩段
表格從 1 欄改 2 欄：左邊 `<code>` 顯示原始代號（給 debug／搜 log 用），
右邊用灰色文字加白話說明（給 user 看）。

涵蓋 21 個事件代號（init / memory_* / handoff_* / iron_rule_* /
update_* / sync_conflict / verification / error）。

## v1.17.49 — security: 預設密碼不再公開洩漏

**Vincent 反饋**：「登入頁不應該把預設密碼寫在畫面上。」

**問題**：登入頁副標 + 改密碼頁 input placeholder 直接把 `Password42760988`
寫死在 HTML 裡。任何人打開 `/ownmind/me/` 就看得到，新建帳號的初始保護等於零。

**修法**：
- 公開的登入頁 + 改密碼頁移除明碼（改成「請聯絡管理者取得預設密碼」）
- admin 端 `POST /api/admin/users` 在「沒指定密碼、套用 shared default」時，
  response 多一個 `default_password` 欄位（一次性返回）
- admin 後台 UI 收到後跳 alert 顯示明碼，提醒用安全管道告知 user
- 其他情境（admin 自設密碼、admin 角色）不回傳

**未來改進方向**（不在本版範圍）：
- 改成每位 user 隨機產生一次性密碼，不再用 shared default
- 改成 email-based password reset link

## v1.17.48 — /me 整體分析 上線後三項修正

v1.17.47 部署後實測抓到問題：

1. **長條圖 bars 渲染成 1px 細線** — `.narrative-bar .nbar` 的 `flex:1`
   在 column wrapper 沒固定高度時，`flex-basis:0` 會吃掉 inline `height:Xpx`。
   改用 `width:80%` 固定 + 把 column wrapper 抽到 CSS 選擇器並補 `height:100%`、
   `justify-content:flex-end`，bars 才能依資料長出正常高度。
2. **改名「敘事報告」→「整體分析」**（tab + H2 + 註解）
3. **LLM prompt 強化** — 原本產出「使用者排名可以幫助管理員了解使用者行為」這種
   廢話。prompt 加正反例示範（廢話 vs 具體），要求洞察必須找 bus factor／
   風險／盲點，next_actions 必須含對象 + 指令式動作，避免空泛。

## v1.17.47 — /me 敘事報告（HackMD 風格 14 天分析）

新增 `/ownmind/me` 第四個 tab「📊 敘事報告」：12 段團隊使用分析。

**機械段（秒回，純 SQL）**

人員排行 / 版本對照 / 日時週分布 / 動作類型 / 鐵律 / 更新健康度 / 專案排行 / 各專案合規。

**LLM 段（開頁自動觸發、伺服器端 cache 1 小時）**

- 一句話結論 + 各段「白話講」 + 給管理者的洞察 + 下一步動作 + 各專案踩坑萃取
- 走 llm-switch（OpenAI-compatible）`https://kkvin.com/llm-switch/v1`，`model='auto'`，`response_format=json_object`
- Server 端 cache by `sha256(narrative_data)`，TTL 1 小時，全團隊每 range 每小時最多打 1 次 LLM
- friction notes 給 LLM 前 redactPII（email / IP）

**新檔**

- `src/lib/llm-narrative.js` — llm-switch wrapper（buildMessages + parseLLMJson + computeDataHash + callLLMSwitch）
- `src/lib/narrative-cache.js` — in-memory hash cache
- `src/routes/me-narrative.js` — 兩個 endpoint
- `tests/{narrative-cache,llm-narrative,me-narrative}.test.js` — 24 個新測試

**設定**

管理者需在 production `.env` 加 `LLM_SWITCH_API_KEY`（見 `.env.example`）。
沒 key 時 endpoint 回 503，機械版報告仍可用。

## v1.17.46 — /me 專案排行 UI 精簡

**Vincent 反饋**：「我的份這欄位拿掉，另外也不用說什麼偶發測試。」

**修法**

- `src/public/me/index.html`：
  - 移除「我的份」欄位（header + cell + desc 文案）
  - 移除「N 位偶發測試略過」註記，noise contributors 不再顯示
- `src/routes/me.js`：清掉 `my_sessions` / `my_handoffs` 累計欄位（前端已不用）

## v1.17.45 — 自動觀測搬到伺服器端（不再依賴客戶端版本）

**Vincent 反饋**：「我的本機 OwnMind 還是 v1.17.22，自動觀測只寫在客戶端，
所以最近 14 天 6 個高風險動作都沒被觀測到。其他人也卡舊版（Adam 1.17.16），
這個邏輯應該搬到伺服器端。」

**修法**

新增 `src/routes/activity.js` 的 `autoEmitObservedTrigger()`：
活動紀錄進伺服器時，若是高風險事件，自動補寫一筆 `iron_rule_compliance`
（action='observed_trigger', source='system_server_auto'）。

對應規則：
- `memory_disable` (target type=iron_rule，伺服器查 memories.type 確認) → IR-006
- `memory_save` (details.type=iron_rule) → IR-006
- `memory_update` (target type=iron_rule，伺服器查 memories.type 確認) → IR-006
- 不對 handoff_create 自動觀測（Codex round 4 過度推論問題仍適用）

**配套**

- `src/routes/me.js` 鐵律遵守表 + gap audit 把 source 比對改成
  `NOT LIKE 'system_%'`，讓 client `system_auto` 跟 server `system_server_auto`
  都被歸類成「自動觀測」、不混入「人工驗證」統計

**好處**

不再依賴客戶端版本：即使 Adam 卡 1.17.16、Vincent 本機沒升，他們的活動只要
傳到伺服器，伺服器就會自動補觀測紀錄。徹底落實 IR-027「邏輯卡控不靠端版本」。

## v1.17.44 — 前端 unverified label 對齊後端中性文案

Codex round 7 抓到的小不一致：v1.17.43 已把 unverified message 中性化，
但前端 TYPE_LABEL 還寫「AI 未主動回報遵守」（仍偏 AI 行為歸因）。

修：`src/public/me/index.html` TYPE_LABEL.compliance_unverified 改成
「未驗證合規（僅系統觀測）」對齊後端文案。

## v1.17.43 — Compliance gap 加 rule_code 關聯比對 + 文案中性化

**Codex round 6 review 抓到的兩個 P1**

### P1.1 has_manual_comply 加 rule_code 關聯
之前 `has_manual_comply` 只看「±10 分鐘內任一 manual comply」就清 gap，會誤判。
例如：14:00 停用 IR-006，14:05 對 IR-008 主動回報遵守 → 系統誤以為 IR-006 也有人驗證過。

修法：sensitive CTE 加 `expected_rules` 欄位（陣列）：
- `memory_disable` → `['IR-006']`
- `memory_save type=iron_rule` → `['IR-006']`
- `handoff_create` → `['IR-008', 'IR-009', 'IR-024']`

`has_matching_manual_comply` 改成：找出 ±10 分鐘內 `action='comply'` AND `source != 'system_auto'`
AND **`rule_code = ANY(expected_rules)`** 的紀錄才算數。

### P1.2 unverified 文案中性化
之前訊息：「AI 沒主動回報，AI 該養成主動 ownmind_report_compliance 的習慣」
→ 太像在訓練 AI，使用者讀起來像內部備忘錄。

改成：「N 個高風險動作僅由系統自動觀測到，沒有對應鐵律的人工驗證紀錄」
→ 描述事實、不帶教訓語氣。

## v1.17.42 — Compliance gap 拆兩種等級（漏觀測 vs 未驗證）

**Vincent 反饋**：拆 vs 不拆對比後選拆，理由：
> 「不拆等於系統幫 AI 擦屁股，跟『不靠 AI 自覺』訴求矛盾」

**修法**

把原本單一 `compliance_gap` 改成兩種獨立的 audit findings：

| Finding | 嚴重度 | 條件 | 動作建議 |
|---|---|---|---|
| `compliance_unobserved` | 🔴 高 | 高風險動作 ±10 分鐘**完全沒**任何合規紀錄（連系統觀測都沒抓到）| 系統可能有 bug，要排查觸發機制 |
| `compliance_unverified` | 🟡 中 | 有系統觀測（observed_trigger）但無 AI 主動回報的 comply | AI 該養成主動回報習慣 |

**為什麼拆**

之前把兩種混成一個，`observed_trigger` 一寫進來就把所有 gap 蓋成 0，看儀表板會誤以為「全部守規」。實際上很多是「系統有看到但 AI 沒驗證」。

拆開後：
- 0 高警 = 系統健康，能抓到所有觸發
- 中警出現 = 推 AI 改善主動回報習慣

## v1.17.41 — Codex round 4 review 後 auto-compliance 誠信修補（P1+P2 全做）

**Codex 抓到的核心誠信問題**：
> 「v1.17.40 把 system 觀測寫成 action='comply' 是自欺。Disable iron_rule 不證明
> 全層同步、handoff_create 不證明 commit 守規」

**修法 6 項**

### P1（必修，誠信問題）

- **action 從 'comply' 改成 'observed_trigger'**（系統自動 path）
  誠實標示「系統觀測到 tool 被呼叫」，不假裝「已驗證遵守」
- **移除 `handoff_create → IR-008/009/024` 自動觸發**（過度推論，commit 規則該靠 git hook）
- **`compliance_gap` audit 加 source filter**：observed_trigger 只關「漏觸發」gap，不算驗證合規
- **鐵律遵守表加「系統觀測」獨立欄位**，遵守率只算 AI 自報部分，不混 system_auto

### P2（建議）

- 移除 `.catch(() => {})` silent，改 `console.error('[autoComply] failed: ...')`
- `complianceEvents` 加 dedup：用 `(rule_code, tool, 1分鐘 timestamp bucket)` key，
  避免同一動作被 AI manual + system auto 重複算
- auto path 補呼叫 `appendCompliance()` 對齊 manual ownmind_report_compliance

**三層語意現在區分清楚**

| Action | 來源 | 算「遵守率」？ |
|---|---|---|
| `comply` | AI 主動 ownmind_report_compliance | ✅ 算 |
| `skip` | 同上 | ❌ 不算 |
| `violate` | 同上 | ❌ 不算 |
| `observed_trigger` | 系統 tool handler 自動 | ⏸ 獨立統計，不混入遵守率 |
| `verified_comply`（未來預留）| git hook 等程式驗證 | ✅ 最嚴謹 |

## v1.17.40 — Compliance call 從 AI 自覺改成系統強制（IR-027 邏輯卡控落地）

**Vincent 反饋**：
> 「我每次跟你 commit、停用 memory、新增 IR-036、新增 backlog memory… 都該主動呼叫
> ownmind_report_compliance 但我沒有。」「把 compliance call 變成系統強制。」

**修法**

`mcp/index.js` 在 CallToolRequestSchema handler 內 `await handleTool` 成功後，
新增 `autoComplyForToolCall(name, args, result)` — 根據 tool name + args 自動 emit
對應的 `iron_rule_compliance` events，**不再讓 AI「忘了講」就漏紀錄**。

**對應規則**

| Tool call | 自動 comply 哪些鐵律 |
|---|---|
| `ownmind_disable`（停用 iron_rule） | IR-006 全層同步 |
| `ownmind_save`（type=iron_rule） | IR-006 |
| `ownmind_update`（target type=iron_rule） | IR-006 |
| `ownmind_handoff_create` | IR-008 + IR-009 + IR-024 |

**source='system_auto' 標記**

每筆 system 自動 emit 的 compliance event 都帶 `source: 'system_auto'`，跟
AI 主動呼叫的（無 source / 'ai'）區別。dashboard 未來可分開統計「系統自動 vs
AI 自報」，但 audit 端兩者都算數（gap 偵測會關掉）。

**效果**

- compliance_gap audit 從現在起對 memory 操作系列幾乎不會再報
- 即便 AI 完全不呼叫 ownmind_report_compliance，DB 也會有完整鐵律觸發紀錄
- 真正解到「邏輯卡控」 — 對齊 IR-027

## v1.17.39 — Codex round 3 review 後 audit 全面修補（P1+P2+P3）

**Vincent 指示**：「P1/P2/P3 全都修」

**修法（5 項對應 Codex review）**

- **P1.1 orphan_session 加日期 gate**
  - 之前 v1.17.37 之前的歷史 sessions 全部誤標
  - 加 `AND created_at >= '2026-05-07'`（v1.17.37 ship 日）

- **P1.2 compliance_gap 縮窄 sensitive event**
  - 之前 `memory_update` 太常見會大量誤報
  - 改成只看 high-confidence：`handoff_create` / `memory_disable` / `memory_save where type=iron_rule`

- **P2.1 heartbeat tool name 用 LOWER(TRIM(...)) 比對**
  - 之前 activity tool 跟 heartbeat tool 大小寫不同就漏判
  - 加大小寫不敏感比對 + 過濾 `unknown` / `mcp` 這種 placeholder

- **P2.2 audit_findings 持久化（high severity）**
  - 之前 on-the-fly 計算，user 沒打開報告就看不到
  - 改成 `severity='high'` 的 findings 寫進 `audit_logs` 表（24h 內 dedup）
  - 未來可接 broadcast / email 通知管線

- **P3 blind-spot detection**
  - 新增 `unobservable_source` finding：帳號 > 7 天但 14 天內 0 activity / 0 token / 無 heartbeat
  - 新增 `team_blindspot` finding（super_admin only）：列出可能用非 MCP 介面（claude.ai web / ChatGPT）工作的成員

## v1.17.38 — Server-side 反向稽核 5 項（Codex review 後實作）

**背景**：Codex adversarial review 指出 compliance / token_events / session_log
本質都是「靠 client 自首」，AI/scanner/process 任一環節失敗就漏。
Vincent 要求「不能靠 user 主動處理，AI 要能主動判斷追蹤」。

**新增 5 個 server-side audit（在 `/api/me/report` 即時計算，回 `me.audit_findings`）**

1. **`compliance_gap`** — 高風險 activity（handoff_create / memory_disable /
   memory_update）前後 ±10 分鐘沒對應 iron_rule_compliance event → 標 medium/high
2. **`heartbeat_absent`** — 最近 7 天有該工具的 activity 但 collector_heartbeat
   超過 24 小時沒回報 → 標 high（直指 Adam Windows scanner 失靈場景）
3. **`source_inconsistent`** — 某天有 activity_logs 但 0 token_events → 標 low/medium
4. **`orphan_session`** — session_logs 對話輪次 ≥5 但 details.compliance 是空陣列
   → 標 low（AI 整段沒回報合規）
5. **`ir027_candidate`**（super_admin only）— user 建立超過 7 天仍 must_change_password
   = TRUE → 可能根本沒登入 /ownmind/me/

**前端**：個人 tab 最頂顯示警示卡片（紅高 / 黃中 / 藍低），含人話訊息 + 統計。

**設計原則**：on-the-fly 計算（非持久化 audit_findings 表），減少 schema 變更
+ 一律最新。未來資料量大可遷成 nightly job + persistent table。

## v1.17.37 — Session log 自動帶 project + 多種退出 signal 都記錄（IR-027 邏輯卡控）

**Vincent 反饋**：「叫 user 每次跟 AI 講『寫 session_log』違反 IR-027 邏輯才有效。
系統應該自己處理。」

**問題**

- 之前 emergencySessionLog 不寫 project 欄位 → 報告頁無法歸到專案
- 只訂 SIGTERM/SIGINT，但 SIGHUP（terminal close）、SIGQUIT、kill -9 都漏接
- 結果：很多 session 結束沒有產生 session_log，user 又得手動叫 AI 寫

**修法**

- `mcp/index.js` 啟動時自動從 `CLAUDE_PROJECT_DIR` / `OWNMIND_PROJECT_DIR` /
  `process.cwd()` 取 `path.basename()` 當 `AUTO_PROJECT`
- emergencySessionLog 寫入 details 時帶 `project: AUTO_PROJECT` +
  `duration_turns`（估算）
- 多訂 SIGHUP / SIGQUIT signal handler
- 加 `process.on('exit', ...)` 同步 fallback：kill -9 沒有 signal 但 exit 仍會
  觸發；只能寫本地 JSONL（async upload 不及完成）
- 防重複：emergencySessionLog 一進就 set sessionLogged

**對 RING 等專案的影響**

未來 user 在 ring-linebot 目錄開 Claude Code → MCP 啟動 → AUTO_PROJECT='ring-linebot'
→ 不論怎麼結束都會寫帶 project 的 session_log → 報告頁正確歸類。

## v1.17.36 — 專案來源加 handoffs（修 RING 看不到）

**Vincent 反饋**：「RING 為什麼沒在專案裡？」

**Root cause**：之前專案來源只看 `session_logs.details.project`，但 Vincent
做 RING 時都只寫 handoff（交接）給下個 session，沒走「結束總結」流程，
所以 RING 在 session_logs 裡 0 筆。

**修法**

- 後端：加 `projectHandoffQ` 從 `handoffs` 表撈每個 user 對每個專案的交接數，
  跟 session_logs 結果合併到同一個 projects map
- 排序改：`turns DESC, handoffs DESC, sessions DESC`（先看量化，再看交接活動）
- 「主要負責人」「其他貢獻者」邏輯：若該人 turns=0 但 handoffs>0，
  顯示成「N 次交接（無 session_log）」
- 前端專案表加「交接」欄

## v1.17.35 — 團隊趨勢圖支援切換 metric（Session / Token / 對話輪次）

**Vincent 反饋**：團隊頁趨勢圖只能看 Session 數，希望可以切換看 Token 量或對話輪次。

**修法**

- 後端：團隊每位成員 + 三張 trend chart 都新增 tokens / turns 欄位
  - `tokens` = SUM(input + output + cache_creation + cache_read + reasoning_tokens) from `token_events`
  - `turns` = SUM(`details.duration_turns`) from `session_logs`
  - 用 FULL OUTER JOIN 合併三個 dataset，避免某 metric 沒資料的 bucket 被丟掉
- 前端：
  - 團隊每位成員表加 Token 數 / 對話輪次 兩欄（K/M 縮寫顯示，hover 看完整數）
  - 趨勢區塊上方放下拉選單切換：Session 數 / Token 數 / 對話輪次
  - barChart 加 fmtBig() 處理大數（13.5K / 2.4M）+ tooltip 顯示完整數

## v1.17.34 — 自訂日期範圍 + 專案名稱大小寫合併

**Vincent 反饋兩點**：
1. 想自己指定起訖日（不只 7d/14d/30d/all preset）
2. 「ownmind」跟「OwnMind」明明同一個專案，被拆兩列

**修法**

- 後端 `/api/me/report`：
  - 支援 `?start=YYYY-MM-DD&end=YYYY-MM-DD` 自訂範圍（end 涵蓋當日整天）
  - 格式驗證 ISO 才接受、否則 fallback 到 preset
  - 專案名稱用 `LOWER(TRIM(...))` 當 group key 合併大小寫變體；
    顯示用 `MIN()` 取一個原字串
- 前端：
  - range select 多 `自訂…` 選項，揭露起 / 訖 date input + 套用按鈕
  - 選 custom 時預設帶 14 天前 → 今天
  - 切到 preset 直接 reload；切到 custom 等使用者按「套用」

## v1.17.33 — 鐵律/活動紀錄分頁 30 筆 + 活動範圍內全列出

**Vincent 反饋**：
1. 鐵律 31 條、活動 200+ 筆，捲不完
2. 活動紀錄應該時間範圍內全列出，不要硬截 200 筆

**修法**

- 後端 `me.activity`：移除 `LIMIT 200`，回傳時間範圍內全部 activity
- 前端：兩個表都加分頁器（30 筆/頁）
  - 上一頁 / 下一頁按鈕、顯示「N–M / 總數（第 X / Y 頁）」
  - 切換 range 時自動回到第 1 頁
  - 不到 30 筆時不顯示分頁器

## v1.17.32 — 個人 tab 加活動紀錄區塊 + 鐵律遵守列出全部 + 遵守率

**Vincent 反饋兩點**：
1. 想看自己過去這段期間的「全部活動」流水，個人 tab 最下方加一塊
2. 鐵律遵守表只列觸發過的，希望列**所有 active 鐵律**並算遵守率

**修法**

- 後端 `/api/me/report`：
  - `me.compliance`：改 LEFT JOIN `memories` 列出 `type=iron_rule, status=active` 全部 31 條；
    沒觸發過的 comply/skip/violate 都 0
  - 新增 `me.activity`：最近 200 筆 activity_logs（含 event / tool / source / details）
- 前端 `/ownmind/me/`：
  - 鐵律表加「遵守率」欄，計算 `comply / (comply + skip + violate)`，依比率著色
    （≥80% 綠 / ≥50% 橘 / <50% 紅 / 無紀錄灰）
  - 個人 tab 最下加「我的活動紀錄」card，列時間 / 事件 / 工具 / 來源 / details
    （依時間倒序、最多 200 筆）

## v1.17.31 — 專案「其他貢獻者」過濾偶發測試（Vincent 回報）

**Vincent 反饋**：「Adam 是 user 不是開發者，為什麼算他進 OwnMind 貢獻者？」

**Root cause**：Adam 4/24 寫了 1 筆 session_log 標 project='ownmind' 8 輪
（可能測試或誤標）。前一版只要寫過 session_log 就算協作，semantic 不準。

**修法**：「其他貢獻者」加門檻 `max(20 輪, 專案總輪次 × 10%)`，低於視為偶發測試。
- OwnMind 148 輪 → 門檻 20 → Adam 8 輪略過、UI 標「+1 位偶發測試略過」
- funit-v2 491 輪 → Adam 是主要負責人，正常顯示

## v1.17.30 — bar chart 加平均線 + 專案改顯示主要 vs 其他貢獻者（Vincent 回報）

**Vincent 反饋兩點**：
1. bar chart 沒平均值參考 → 看不出「這天比平均高還低」
2. 「OwnMind 是 Vincent 的專案，為什麼 owners 列出 Adam？」

**修法**

1. **bar chart 加平均線**：
   - 紅色虛線橫跨整張圖、右上方標「平均 N」
   - 平均只看非零值（避免週末、未開始日把平均拉低）
2. **專案表改成「主要負責人」+「其他貢獻者」兩欄**：
   - 後端 API 改回傳 `contributors: [{name, sessions, turns}]`（依 turns 排序）
   - 前端取第 1 名當主要負責人、其他人列為「協作」
   - 例：OwnMind 專案 → 主要 Vincent (140 輪)，其他 Adam (8 輪)

## v1.17.29 — bar chart 加數字標籤（Vincent 回報）

每根 bar 上方顯示數值（0 值不顯示避免雜訊）。`.bar-chart` 高度從 220 → 240px、
新增 `padding-top: 18px` 留數字空間。

## v1.17.28 — hotfix /ownmind/me/ bar chart 全空（Vincent 截圖回報）

**症狀**：登入進報告頁後，「每日活動量」「時段分布」「一週節奏」三張柱狀圖
都只有底部的標籤、沒有任何 bar。

**Root cause**：
- `.bar-row` 用 `display: flex; flex-direction: column` 但沒給高度
- 內部 `.bar` 用 inline `height: ${h}%`，% 找不到固定高度的 parent → 0
- 等於 bar 永遠 0px

**修法**（純 CSS）：
- `.bar-row` 加 `height: 100%; justify-content: flex-end`，確保 row 等高且 bar 從底部往上長
- `.bar-label` 改 absolute position 在 row 下方（不佔 bar 的高度）
- `.bar-chart` 加 `padding-bottom: 24px` 留 label 空間

## v1.17.27 — hotfix /ownmind/me/ API path 寫錯（Vincent 截圖回報）

**症狀**：登入畫面按「登入」吐 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

**Root cause**：`src/public/me/index.html` 用 `/api/me/...` 直接打 root，
但 nginx 只 rewrite `/ownmind/...` → `/...`。前端打 `https://kkvin.com/api/me/login`
沒對應 route，nginx 回 default HTML 頁，前端 `r.json()` 解析失敗。

**修法**：所有 fetch 從 `/api/me/...` 改 `/ownmind/api/me/...`，跟 admin 一致。

## v1.17.26 — admin 建 user 時自動套預設密碼

**背景**：v1.17.25 補了存量 user 的預設密碼，但「admin 後台新增 user」流程
還沒對齊。admin 沒指定密碼建出來的 user 進不了 /ownmind/me/。

**改動**

- `src/routes/admin.js` POST /users：
  - 新增常數 `DEFAULT_USER_PASSWORD = 'Password42760988'`
  - admin 沒指定 password 且 role='user' → 自動套預設密碼 + `must_change_password = TRUE`
  - admin 指定 password → 維持原行為（不強制改）
  - INSERT 帶上 `must_change_password` 欄位
- `tests/me-report.test.js`：新增 1 case 確保預設密碼 + must_change_password 都有寫入

**測試**：644/644 pass

## v1.17.25 — /ownmind/me/ 改成帳密登入 + 強制首次改密碼

**背景**：v1.17.24 用 api_key 登入 UX 太差（user 要從設定檔翻 key、洩漏風險高）。
改成標準的 email + password 流程。

**改動**

- `db/010_user_password_login.sql`：新增 `must_change_password` 欄位 + 強化 email 索引
- `src/jobs/seed-default-passwords.js`：server boot 時補預設密碼給 `password_hash IS NULL` 的 user，
  預設 `Password42760988`、`must_change_password = TRUE`，idempotent
- `src/routes/me.js`：
  - `POST /api/me/login` — 接受 email+password，回 api_key + must_change_password flag
  - `POST /api/me/change-password` — 改完自動清 must_change_password 旗標
  - `/profile` 多回 must_change_password
- `src/public/me/index.html`：登入表單從「貼 api_key」改成「Email + 密碼」，
  must_change_password=true 時強制顯示改密碼表單再進報告
- `src/index.js`：boot 時呼叫 seedDefaultPasswords()

**user 流程**

1. 開 https://kkvin.com/ownmind/me/
2. 輸入 Email + 預設密碼 `Password42760988`
3. 系統強制顯示「改密碼」表單，輸入舊密碼 + 新密碼（≥8 字元）
4. 改完直接看報告，下次只要 Email + 新密碼

**測試**：643/643 pass，新增 6 個 reproduction case

## v1.17.24 — 用戶用量報告頁（/ownmind/me/）

**背景**：之前後台只有 admin / super_admin 能登入，user role 完全看不到自己 / 團隊
的活動量。Vincent 表示要開放讓 user 也能看「個人 + 團隊」用量報告，內容比照
HackMD 那份手動整理的版本，但即時資料、自助登入。

**設計決策**（跟 Vincent brainstorm 4 題拍板）

- Q1 = C：完全開放，互看活動 / 版本，不匿名化
- Q2 = B：全團隊專案都看得到（不含對話內容、只看數量）
- Q3 = B：獨立 URL `/ownmind/me/`，跟 admin 後台分開
- Q4 = 完整版（不是 MVP）

**新增**

- `src/routes/me.js` — `/api/me/profile` + `/api/me/report?range=7d/14d/30d/all`
  - 用 `auth` middleware（一般 auth，不擋 user role）
  - report 回 me / team / projects 三大區塊：個人活動 / 版本 / 專案 / 合規 +
    團隊成員列表 / 每日趨勢 / 時段熱力 / 一週節奏 / 事件類型 / 全工具版本
- `src/public/me/index.html` — 自助登入（貼 api_key 存 localStorage）+ 三 tab
  報告頁，內建 bar chart（純 CSS，無 mermaid 依賴）
- `tests/me-report.test.js` — 7 個 case 防退化

**改動**

- `src/app.js` — 掛 `/api/me` 路由 + 提供 `/me` 靜態頁（nginx rewrite 到
  `/ownmind/me/`）
- 三語系 README + CHANGELOG + FILELIST 同步

**測試**：638/638 pass

**對 user 的影響**

Eric / Michelle / Adam（user role）現在可以開 https://kkvin.com/ownmind/me/，
貼上自己的 api_key（從 `~/.claude/settings.json` 找 `OWNMIND_API_KEY`），看自己
的活動 + 全團隊聚合資料。Vincent / Eric（admin）也能用此頁，但他們也保留 admin
後台原有功能。

## v1.17.23 — Codex review 抓到的 v1.17.22 後續修補（5 項）

**背景**：v1.17.22 修了 Windows MCP auto-update silent-skip，但 Codex
adversarial review 又抓到 5 個問題，整理在這個 patch 一次處理。

**改動**

1. 🔴 **`scripts/update.ps1` argv index bug**
   - v1.17.22 寫法：`process.argv[1]` 取 settings path → 實際是 `.js` 檔本身
   - 結果：Windows 用戶 settings.json 注入 hook 整段失效
   - 修法：改用 `process.argv[2]` / `process.argv[3]`

2. 🔴 **`mcp/index.js` lock acquire 不 atomic**
   - v1.17.22：`existsSync` + `writeFileSync` 有 TOCTOU race
   - 修法：`fs.openSync(LOCK_FILE, 'wx')` exclusive create，
     EEXIST → `update_skipped reason=lock_held`，其他 → `update_failed step=lock`

3. 🟡 **`scripts/update.ps1` 漏了 Gemini / Copilot / Cursor hooks 注入**
   - v1.17.22 PS1 只覆蓋 Claude 部分（update.sh 的 1./2./3. 段）
   - 修法：補上 4./5./6. 段（Gemini CLI / GitHub Copilot / Cursor）

4. 🟡 **`mcp/index.js` git stash 沒 pop 會吞 user 變更**
   - v1.17.22：`git stash -q` 後 `git pull`，但沒 pop
   - 修法：用 `git pull --rebase --autostash`（git 2.6+ 一條命令解決）

5. 🟡 **`mcp/index.js` 外層 catch silent fail**
   - v1.17.22：`runAutoUpdate().catch(() => {})` 把意外吞光
   - 修法：catch 寫 `update_failed step=outer` + cleanup lock

**測試**：631/631 pass，新增 5 個 reproduction case。

## v1.17.22 — 修「Windows 用戶 MCP auto-update silent skip」（Eric / Adam case）

**背景**（從工作紀錄分析報告 2026-05-07 發現）

Eric (LAPTOP-G95HIQ3V) 卡 v1.17.17、Adam 卡 v1.17.16，
但 server 已經 v1.17.21。兩人 4/21 後完全沒有 update_check / update_failed
event，只有 init / memory_* 正常進 DB。

**Root cause（兩層）**

1. `mcp/index.js` line 1054 用 `process.env.HOME || ''`：Windows 通常沒設
   HOME（用 USERPROFILE），導致 `OWNMIND_DIR = '.ownmind'` 變相對路徑，
   `fs.existsSync('.ownmind/.git')` 永遠 false → **整個 auto-update silent skip
   沒任何 log 可觀測**。
2. 即使路徑對，`exec(bashScript)` 的 bash 語法（`touch`、`||`、`cd ~`、heredoc）
   在 Windows cmd.exe 全部不認，會立刻語法錯誤。

**修法**

- `mcp/index.js` 整段 auto-update 重構：
  - `OWNMIND_DIR` 改用 `os.homedir()`（跨平台、Windows 自動讀 USERPROFILE）
  - 廢棄 `exec(bashScript)`，改用 Node-native `execFile` 呼叫 git/npm 二進位
  - Windows 用 `npm.cmd`（execFile 不過 shell 找不到 `npm`）
  - 同步 skill/hook 步驟：Unix 跑 `bash update.sh`、Windows 跑
    `powershell update.ps1`
  - 條件不成立時新增 `update_skipped` event（reason: marker_today /
    no_git_dir / lock_held），終結 silent skip
- `scripts/update.ps1`（新檔，含 UTF-8 BOM）：對應 update.sh 的 PowerShell 版，
  同步 Claude Code skills、hook scripts、settings.json hooks
- 測試：
  - `tests/mcp-auto-update-cross-platform.test.js`（8 case）：os.homedir、
    update_skipped、execFile 跨平台、update.ps1 存在性
  - `tests/p3-update-event-semantics.test.js` 既有測試對齊新 Node-native 架構

**測試**：626/626 pass

**對 Eric / Adam 的影響**

下次 MCP 啟動時：
- 路徑解析正確 → 進入 auto-update 流程（之前永遠跳過）
- 寫 update_check event（之前 0 筆）
- 任何 step 失敗都寫 update_failed + step 名稱（之前完全 silent）
- 即使整體沒升起來，dashboard 也看得到「為什麼沒升」

## v1.17.21 — 修「compact mode 砍掉合規回報指令導致 iron_rule_compliance 0 紀錄」

**背景**（2026-05-07 從工作紀錄分析報告中發現）

`activity_logs` 中 `iron_rule_compliance` event 自 2026-04-21 起完全停止寫入
（之前累積 60 筆，4/22~5/7 是 0 筆），而 MCP tool `ownmind_report_compliance`
寫入端正常（手動測試會進 DB）。

**Root cause**

`src/routes/memory.js` 用 `?compact=true` 拉 init 時，第 653 行
`...(!compact && { instructions: INSTRUCTIONS_SOP })` 會把整段 SOP 拿掉。
SOP 第 193 行有「**每次鐵律被觸發後，必須呼叫 ownmind_report_compliance**」
這條指令；compact mode 等於把這條教學完全砍掉。SessionStart hook 用的就是
compact，新 session 的 AI 拿不到指令，隨時間自然漂移成「不再呼叫」。

Compact 從 3/30 上線，4/21 之前還有紀錄是因為 AI 從 skill 檔 / 歷史對話
記得這條規則；隨著 skills 重構，記憶逐漸流失。

**修法**

把合規回報指令固定附加在 `iron_rules_digest` 末尾。digest 在 compact mode
也會送（`iron_rules_digest: ironRulesDigestFinal` 沒 compact gate），語意上
digest = 鐵律清單，compliance = 鐵律觸發後的回報，兩者天然成對。多 ~80 tokens
換永久觀測。

**改動**

- `src/routes/memory.js` — `ironRulesDigestFinal` 末尾固定附加合規回報指令，
  涵蓋 comply / skip / violate 三個 action
- `tests/init-compact-compliance-instruction.test.js` — 3 個 regression case：
  digest 含 `ownmind_report_compliance`、digest 在 compact 也送、三 action 齊全

**測試**：618/618 pass

## v1.17.20 — Admin 工作紀錄頁 + 隱藏資料品質警示

**Admin Dashboard 新增「工作紀錄」頁籤**（super_admin only）

三來源時間軸，把全團隊每個人的活動串起來，super_admin 可查看：
- **活動**：`activity_logs` 中 event ≠ `iron_rule_compliance` 的事件（init / update / tool_call 等）
- **合規**：`activity_logs` 中 `iron_rule_compliance` 事件（鐵律遵守 / 違反）
- **Session**：`session_logs` 表的 AI session 摘要

預設顯示最近 30 天 / 100 筆，支援篩選：日期 range / user / tool / event_type / 全文搜尋（details / summary 走 ILIKE）。

**改動**

- `src/routes/admin-work-log.js`（新檔）— `GET /api/admin/work-log` + `/filters` endpoint，三來源 UNION ALL，依 ts DESC 排序，limit 上限 500
- `src/app.js` — mount router 在 `/api/admin/work-log`，順序在 `/api/admin` 之前避免被 catch
- `src/public/index.html` — 新「工作紀錄」tab（super_admin only）、篩選列、分頁載入更多按鈕；同時把「資料品質警示」card 加 `hidden`（日常不需顯示）
- `tests/admin-work-log.test.js` — 9 個 case：權限、UNION、篩選、limit cap、total_count

**測試**：615/615 pass

## v1.17.19 — 自動更新 lock 失敗納入失敗偵測（project_281 backlog item C）

**背景**：v1.17.18 的 P3 修法把 `git fetch / pull / npm install / update.sh` 每步都加了顯式
失敗 marker，但漏了第一步的 `touch "${LOCK_FILE}"`。disk full / readonly FS / 權限異常時 touch
會失敗，後續的 update pipeline 會在「沒 lock 保護」下繼續跑，理論上有機會與另一個並行的
SessionStart hook race。實務碰到機率低，但對齊 P3「每步顯式 trap」原則補完。

**改動**

- `mcp/index.js` — shell 首行 `touch "${LOCK_FILE}" || { echo "__OM_LOCK_FAIL__"; exit 9; }`，
  callback `failMarkers` 陣列補入 `__OM_LOCK_FAIL__`，lock 失敗會寫 `update_failed` step=lock
- `hooks/ownmind-session-start.sh` — `touch "$LOCK_FILE" || { log_event update_failed step=lock; exit 0; }`
- `tests/p3-update-event-semantics.test.js` — 新增 3 個 P3-lock regression case

**測試**：606/606 pass

## v1.17.18 — 修「升級後仍重複跳出升級提醒」

**背景**：每次 Claude Code SessionStart 都跳出 `[WARNING] OwnMind 有新版本 …` 廣播，
即使 client 已升級到最新仍持續顯示，需要 AI 手動 dismiss 才會停。Root cause 是兩個獨立 bug：

1. `hooks/ownmind-session-start.sh` 呼叫 `/api/broadcast/active` 沒帶 `client_version`，
   server 端 `src/lib/broadcast-filter.js` 的 `if (client_version)` 條件不成立 →
   `min/max_version` semver 過濾完全跳過 → 已升級用戶仍收到 `max_version=<prev>` 的歷史升級提醒。
2. `mcp/index.js` 的 `fetchBroadcastsSafely` 讀 `process.env.OWNMIND_VERSION`（從未設定），
   實際應該用同檔案頂端從 `package.json` 解出的 `CLIENT_VERSION`。
3. dismiss 責任之前掛在 AI skill 上（讀完 `OK:done:*` 後手動 POST），AI 漏做就不會 dismiss
   → 違反 IR-027「邏輯才有效」。

**改動**

- `hooks/ownmind-session-start.sh` — 抓 `package.json` 版號，當 `?client_version=` query 與
  `X-Ownmind-Version` header 一起送
- `mcp/index.js` `fetchBroadcastsSafely` — 改用 `CLIENT_VERSION`，env var 改 fallback
- `scripts/interactive-upgrade.sh` + `.ps1` — 在 `OK:done:*` 之前主動撈 `upgrade_reminder`
  廣播並逐一 POST `/api/broadcast/dismiss`，腳本主動清自己
- `skills/ownmind-upgrade.md` — 移除「Step 3：AI 手動 dismiss」段落，註明現在由腳本自動處理
- 既有 server 端 `/api/broadcast/active` 已支援 `?client_version` 與 `X-Ownmind-Version`
  header（`src/routes/broadcast.js:187-189`），無需改動

**新增測試**

- `tests/broadcast.test.js` — 新增 2 個 regression case：
  - `applies max_version filter when client_version is in query string`
  - `skips semver filter when client_version absent (back-compat)`
- 全部 53 個 broadcast cases 通過

**鐵律對齊**

- IR-027 邏輯卡控：dismiss 從 AI skill 移到腳本
- IR-031 三處版號同步：`package.json` → 1.17.18（SERVER_VERSION / CLIENT_VERSION 都從 package.json 讀，單一來源）
- IR-008 / IR-026：CHANGELOG / FILELIST 同步

## v1.17.17 — Dashboard 團隊一覽改造

**背景**：admin 在 dashboard 上看不到「最近 7 天每位成員整體在做什麼、守鐵律守得如何」。「Audit Log」這個名字也誤導，user 直覺以為是團隊活動紀錄，實際內容是 ingestion 異常事件。

**改動**

- 後端新增 `GET /api/usage/admin/team-overview` — 每位成員的最近活動、對話場次、最常做的專案、鐵律遵守率（從 `session_logs.details` 彙總）
- 後端新增 `GET /api/usage/admin/team-overview/:user_id/sessions` — 該成員最近 N 場 session 流水（含 `machine_meta` 副資訊：os / scanner_version）
- 後端 `collector_heartbeat` 表加 `os` 欄位（migration `db/009_collector_heartbeat_os.sql`）
- Client（mcp/index.js）heartbeat payload 加 `os: os.platform()`（darwin / linux / win32）
- 前端「團隊用量排行榜」加四欄：最近活動 / 對話場次 / 最常做的專案 / 鐵律遵守率
- 前端日期篩選器預設帶最近 7 天
- 前端「成員詳情」卡新增「最近對話」摺疊區（lazy load + race guard）
- 「Audit Log」改名「資料品質警示」+ 加說明列說明它不是團隊活動紀錄
- 機器名旁加 OS · scanner_version 副資訊（避免 Adam 機器叫「after」這類短名造成 UX 混淆；前端把 darwin/linux/win32 轉成 macOS/Linux/Windows）

**新增測試**

- `tests/team-overview-api.test.js` — 鐵律遵守率算法、票選專案、scoreboard endpoint（含 7 天預設、range echo、邊界 case）— 16 cases
- `tests/team-overview-sessions-api.test.js` — sessions endpoint、machine_meta fallback、limit 上限/0/負數 — 7 cases

**No schema migration 對既有資料**：`db/009_*.sql` 只是加新欄位（IF NOT EXISTS），既有資料不動。

**相容性**：v1.16 之前的 session 沒填 `details.project` / `details.rules_*` 的會被忽略不算（前端顯示「—」），不擋查詢。

**鐵律對應**：IR-022（Server + Client 兩端同改）、IR-031（package.json 同步推 1.17.17）、IR-008 / IR-026（CHANGELOG / README / FILELIST 同步）、IR-020（部署後瀏覽器實測）、IR-034（新 db/009_*.sql 由 Dockerfile `COPY db/` 自動涵蓋）。

## v1.17.16 — 修 update_ok 假陽性事件（dashboard 數據誠信問題，回報者 Adam case）

**背景**：Adam (Windows) 4/26 dashboard 顯示有 `update_check + update_ok` 兩個 event，看起來升級成功，但實際 client 還是 1.17.10（沒升）。追下去發現 OwnMind 的自動更新機制在兩個地方有同款 silent-fail bug：

1. `mcp/index.js`（每次 MCP server 啟動跑一次）
2. `hooks/ownmind-session-start.sh`（每個 SessionStart 跑一次，頻率更高）

**Root cause**：兩處的 shell pipeline 都把 `git pull / npm install / update.sh` 用 `2>/dev/null` 吞掉錯誤，最後 `if [ shell exit 0 ]` 就無條件寫 `update_ok`（mcp）/ `update_applied`（hook）。但下面三種情境都會 exit 0：

- `UPDATES=""` 沒新 commit 可拉（if 整段不跑，echo marker 仍 exit 0）
- `git pull` 失敗被 `2>/dev/null` 吞 + `||` fallback → exit 0
- `npm install` / `update.sh` silent fail → exit 0

`update_ok` 字面意思「升級成功」≠ 實際語意「shell 沒爆」 → dashboard 顯示「使用者已更新」但實際根本沒升。違反 OwnMind「透明度」原則。

**修正**

**mcp/index.js（client 端）**
- shell pipeline 改寫：每個關鍵 step（fetch / pull / npm install / update.sh）顯式 echo fail marker（`__OM_PULL_FAIL__` 等）+ `exit 11..14`
- `git log HEAD..origin/main` 維持 `2>/dev/null` 防 stderr 污染 UPDATES 變數
- callback 不再寫死 `update_ok`，改三分支：
  - `update_applied` — 真有拉到新 commit + npm install + update.sh 都 OK
  - `update_clean` — 沒新版可拉（合法 no-op）
  - `update_failed` — 任一 step 失敗，details 含 step 名稱 + exit code（**不上傳完整 stdout/stderr，避免洩漏使用者本機 path**）

**hooks/ownmind-session-start.sh（client 端）**
- 對齊 mcp/index.js 修法：每個 step 用 `if ! ...; then log_event "update_failed" "step" "..."; exit; fi` 包起來
- 同樣三分支：`update_applied` / `update_clean` / `update_failed`

**Dashboard label（server 端）**
- `src/public/index.html` ZH 對應表加 `update_clean: '無新版'` + `update_failed: '升級失敗'`，避免 dashboard 顯示英文 raw key

**新增測試**
- `tests/p3-update-event-semantics.test.js`（11 個 source-grep assertions）：
  - mcp/index.js 不能再寫死 `update_ok`
  - mcp/index.js + hook 都必須有 `update_applied` / `update_clean` / `update_failed` 三條路徑
  - shell 內必須有 fail marker
  - dashboard 必須有對應中文 label
- 防退化：未來 reviewer 漏修任一支都會被 test 抓到（這次 review 就是這樣抓到 hook 漏修）

**對使用者**
- 升級到 1.17.16 後，dashboard 上「Audit Log」看到的事件名稱會更精確：實際升級成功才是「已更新」、沒新版是「無新版」、失敗是「升級失敗」+ 具體哪個 step 出錯
- Adam 場景：升 1.17.16 後就不會再看到「假陽性 update_ok」誤導你以為他升級成功

**為什麼 v1.17.15 的 fix 漏了 hook**：v1.17.15 只 review MCP 路徑，沒注意到 hook 有同款 pattern。本次 code review 階段被 superpowers code-reviewer 抓到。learning：未來 review 涉及自動更新邏輯時，必查 `mcp/` + `hooks/` + `scripts/` 三個地方的對偶實作。

**IR-022 server + client**：純 client 修（mcp/index.js + hooks + dashboard label）；server 無改動。

---

## v1.17.15 — 修 Windows pre-commit hook "Exec format error"（回報者 Eric）+ 修 verify-upgrade.sh server round-trip

**背景一：Eric 在 Windows 上 commit 時跳錯**
```
error: cannot spawn C:\Users\Eric\.ownmind\git-hooks/pre-commit: Exec format error
```

OwnMind 的 git hook 安裝邏輯有三個累積問題：
1. **install.ps1 寫的 sh wrapper 缺 chain existing hooks 邏輯** — Mac/Linux 版有的 `git rev-parse --git-dir` 那段，Windows 版完全沒寫，導致 user 自己 repo 的 `.git/hooks/pre-commit` 被 OwnMind hook 完全覆蓋
2. **沒有 `.gitattributes` 強制 LF 行尾** — Windows checkout 時 `core.autocrlf=true`（Git for Windows 預設）會把 LF 轉 CRLF，shebang `#!/bin/sh\r` 找不到 `/bin/sh\r` → "Exec format error"
3. **沒偵測 `sh.exe` 是否可用** — VS Code 內建 git / WinGet `Microsoft.Git` / Scoop `git-with-openssh` 都不含 `sh.exe`；OwnMind 仍寫了 sh wrapper 出去 → 無法 spawn

**背景二：升級流程 server 驗測一直假性失敗**

`scripts/verify-upgrade.sh --server` 一直回 `write_failed`，但 server 正常。三個 bug 疊加：
1. 寫入前未呼叫 `/api/memory/init` 取 `sync_token`，被 server 409 拒絕（v1.17.0 開始強制）
2. 讀回用了不存在的 `GET /api/memory?include_test=true`（404）
3. `curl -sf` 在 4xx 靜默失敗，錯誤訊息誤導為「API_KEY 過期或 server 500」

**修正**

**Windows hook 安裝（client 端）**
- `.gitattributes` **新增**：強制 `*.sh` / `hooks/ownmind-git-{pre,post}-commit` / `git-hooks/{pre,post}-commit` 等檔案 `eol=lf`，根本解 CRLF 污染
- `install.ps1`：
  - 新增 `Copy-AsLf` helper：從 source 讀 bytes、過濾 `0x0D` (CR)、無 BOM 寫出（雙重保險）
  - 新增 `Test-ShAvailable` helper：偵測 `sh.exe` 是否在 PATH 或 Git for Windows 典型路徑（`usr\bin\sh.exe`）
  - hook 安裝改為 **直接 copy source**（`hooks/ownmind-git-pre-commit`），不再 inline 生簡陋版 → 自動帶 chain existing hooks 邏輯，與 Mac/Linux 對齊
  - 偵測不到 `sh.exe` 時 fail-fast：明確指出常見原因 + 解法（裝 Git for Windows）+ 跳過 hook 安裝以免壞所有 commit

**verify-upgrade.sh（client 端）**
- `--server` 模式：寫入前先 `GET /api/memory/init?compact=true` 取 `sync_token`，塞進 POST body
- 讀回改用 `GET /api/memory/:id`（從 write response 取 id），不再打不存在的 list endpoint
- `curl -sf` 改 `curl -s` + 捕捉 HTTP code，失敗時顯示實際 server 回應 + body 前 200 字
- 鐵律 digest 檢查改重用 step 2 的 init response，省一次 round-trip

**驗證**
- Mac 端 `bash verify-upgrade.sh --local / --server / --cleanup` 三模式全綠
- Windows 端待 Eric 重跑 `iwr .../install.ps1 | iex` 後實測 commit 不再爆

**為什麼選「fail-fast 而非自動裝 Git for Windows」**：Git for Windows 是大型 installer (~50MB)，沒有可靠的 silent install 流程；明確訊息 + 文件指引比黑魔法更符合「使用者零負擔」原則。

**IR-022 server + client 兩端**：純 client 修（install.ps1 + verify-upgrade.sh + .gitattributes）；server 無改動。

---

## v1.17.14 — Tier 2 (Cursor / Antigravity / OpenCode) Windows 支援（v1.17.12 留的 Tier 2 債）

**背景**：v1.17.12 修好 Windows 主線 Tier 1（Claude Code / Codex）usage scanner 的 BOM root cause，但 Tier 2（Cursor / Antigravity / OpenCode）Windows 仍永遠無法收集 session 計數。原因：
1. `opencode.js` 沒 win32 path branch — `DEFAULT_DB` 硬寫 POSIX `.local/share/opencode/`
2. `vscode-telemetry.js` + `opencode.js` 都靠 `sqlite3` CLI，Windows 預設沒裝 → ENOENT 直接 skip

**修正**

**Scanner adapter**
- `shared/scanners/opencode.js`：新增 `DEFAULT_DB_PATHS = {darwin, linux, win32}`，Windows 指向 `AppData/Roaming/opencode/opencode.db`
- `shared/scanners/vscode-telemetry.js`：ENOENT 錯誤訊息加具體裝法（`winget install` / `apt install` / sqlite.org URL）
- `shared/scanners/opencode.js`：同上 actionable error

**Install 腳本自動裝 sqlite3**
- `install.ps1`：偵測到沒 sqlite3 → 嘗試 `winget install --id SQLite.SQLite --scope user --silent`（Win10 1809+ 內建 winget）。失敗 fallback 印清楚手動裝法
- `install.sh`：新用戶偵測沒 sqlite3 → 按 OS 印正確裝法（Linux `apt install`、Mac `brew install`、Windows 轉 install.ps1）
- Mac 多半內建，所以只對真正缺少的平台 warn

**新增測試**
- `tests/tier2-windows-fix.test.js`（8 tests）— opencode win32 path + install 腳本 sqlite3 偵測 + actionable error 訊息
- 全 suite 566/566 綠

**對使用者**
- 新 install：Windows 端執行 install.ps1 會自動裝 sqlite3（winget 成功率高），只需重開 terminal 讓 PATH 生效。下次 scanner 跑就能收 Tier 2 data
- 已裝使用者：跟 AI 說「升級 OwnMind」或手動跑 install.ps1 / install.sh，scanner 下次 30 分鐘 trigger 就會順便用上 sqlite3

**為什麼不 bundle sqlite3.exe 進 repo**：binary (~1.5MB) 放版控不理想；winget 是 Windows 官方認可的 install 路徑、user 事後也可用同一條指令更新 sqlite，可維護性最好。

**IR-022 server + client 兩端皆觸及**：純 client 修（scanner adapter + install scripts）；server 無改動。

---

## v1.17.13 — 修 session_log 寫讀不一致（回報者 Michelle）

**背景**：Michelle 用 `ownmind_log_session` 寫入 id=221 後，用 `ownmind_get("session_log")` / `ownmind_search` 試搜 `ai_kol` / `Selenium` / `趨勢` 全部回空。追查發現**單一 root cause，兩個症狀**：

| 動作 | 實際操作 |
|---|---|
| `ownmind_log_session` 寫入 | → `INSERT INTO session_logs`（獨立表） |
| `ownmind_get("session_log")` 讀 | → `SELECT FROM memories WHERE type='session_log'` |
| `ownmind_search` 搜 | → `SELECT FROM memories WHERE content/title ILIKE` |

寫 A 讀 B — 兩個 get 都永遠 miss 剛寫的 session_log。

**修法**（server + MCP 端分叉整合，不動 `session_logs` 表避免 migration）

**Server — `src/routes/session.js` + 新 `src/lib/session-query.js`**
- `GET /api/session/recent` 加 `?q=` 參數，ILIKE search `summary` + `details::text`（Michelle 那類 session-topic 搜尋）
- SQL builder 拆成純函式 `buildSessionRecentQuery`，新 `tests/session-recent-query.test.js` 9 tests 守住

**MCP — `mcp/index.js`**
- `ownmind_get('session_log')`：偵測到 type 轉呼 `/api/session/recent?days=30&include_compressed=true`（讀到剛寫的 session_logs 內容）
- `ownmind_search`：`Promise.all` 同時查 `/api/memory/search` + `/api/session/recent?q=` → 合併成單一 `data` 陣列，session_logs 項目標 `_source: 'session_logs'` + `type: 'session_log'` 方便區分。新回應含 `memory_hits` / `session_hits` 計數給 AI 看清楚

**對 Michelle / 所有使用者**
升 v1.17.13 後下次 `ownmind_search "ai_kol"` 會同時搜 memories + session_logs，她的 session id=221（summary 含 ai_kol）會現身。`ownmind_get("session_log")` 會列最近 30 天的 session 紀錄。

**為什麼不動 `session_logs` 表**：activity / weeklyReport / report 都依賴此表 schema，migrate 進 memories 會 cascading break。MCP 端分叉是最小風險路徑。

**IR-022 server + client 兩端皆觸及**：server 端 query + route；MCP 端 tool handler 分叉。

**新增測試**：`tests/session-recent-query.test.js`（9 tests），全 suite 558/558 綠。

**未修（留 v1.17.14 或以後）**
- 🟡 Tier 2 (Cursor / Antigravity / OpenCode) 在 Windows 預設沒 `sqlite3` CLI 失敗 — 只影響 session_count 計數，不影響 Tier 1 token 統計

---

## v1.17.12 — 修 Windows usage scanner 全體卡關的 root cause（回報者 Vin observes）

**背景**：Admin 後台「團隊用量排行榜」顯示 Mac 使用者 ×2（Vincent, Michelle）用量正常，Windows 使用者 ×4（Sunny, Adam, Eric, pitt）**全部 0**。Eric 的 Task Scheduler 明明已排程，為何用量還是 0？Codex adversarial review 找到 smoking gun：

**Root cause — `install.ps1` 寫 BOM-prefixed settings.json**

PS 5.1 的 `Set-Content -Encoding UTF8` 在 Windows 10 預設環境會加 UTF-8 BOM (`EF BB BF`)。Node.js 的 `JSON.parse('\uFEFF{...}')` 直接 throw SyntaxError。

結果鏈式反應：
1. `shared/helpers.js` 的 `readCredentials()` catch 後回空字串
2. `hooks/ownmind-usage-scanner.js:97-100` 偵測 creds 空 → 立刻 log "credentials not found; skipping" + exit
3. 沒 heartbeat 送 → Admin 看到「未裝」
4. 沒 event 送 → 用量全 0
5. MCP server 啟動時同樣 readCredentials → MCP crash → 沒 MCP startup heartbeat

諷刺的是：`scripts/windows/register-scanner-task.ps1:64-69` 已經明註「避開 PS 5.1 UTF-8 BOM」用 `WriteAllText` 寫 `.node-path`，但 `install.ps1` 寫 settings.json 沒做同樣防護。Mac `install.sh` 走 heredoc 不帶 BOM，所以完全不受影響。

**修正 — Defense in depth**

**A. `install.ps1`：全面改用 `Write-Utf8NoBom` helper**
- 新增 helper：`[System.IO.File]::WriteAllText(..., new UTF8Encoding $false)` 明確指定 no-BOM
- settings.json（3 處）/ CLAUDE.md（2 處）/ Cursor mcp.json（2 處）/ git hook shell wrapper（2 處）全部改寫

**B. `shared/helpers.js`：`readCredentials` / `readJsonSafe` / `getClientVersion` 都 stripBom**
- 現有已中招的 Windows 使用者**不用重裝**；下次 scanner 跑 → readCredentials 能 parse → 開始送 heartbeat/event
- 未來再出現 BOM 污染（編輯器/其他 tool）也會被吸收

**C. `install.ps1`：註冊 Task Scheduler 後驗證 `$LASTEXITCODE + Get-ScheduledTask`**
- Adam 當時 Duration bug，`Register-ScheduledTask` 失敗但 install 印「已註冊」silent lie
- 現在失敗會清楚顯示 `(exit=N, task_exists=False)` + 給 debug 指令

**新增測試**
- `tests/credentials-bom-safe.test.js` — readCredentials / readJsonSafe BOM tolerance（6 tests）
- `tests/install-ps1-no-bom-outputs.test.js` — install.ps1 禁用 Set-Content 寫敏感檔（3 tests）
- `tests/install-ps1-scanner-task-check.test.js` — install.ps1 驗證 scanner task 真的註冊（1 test）
- 全 suite 549/549 綠

**對 Eric/Adam/Sunny/pitt**
升到 v1.17.12：
```
cd ~/.ownmind
git pull
cd mcp && npm install  # 新 readCredentials 生效
cd .. && powershell -ExecutionPolicy Bypass -File scripts\windows\register-scanner-task.ps1
```

或跟 AI 說「升級 OwnMind」（走 interactive-upgrade.ps1 全部做完）。

升級後下次 scanner 30 分鐘觸發就會正常送 heartbeat + event，Admin 裝機狀況 + 用量排行榜都會有數字。

**IR-022 server + client 兩端皆觸及**：純 client 修（helpers.js + install.ps1），但 bootstrap route 會 serve 給 `iwr|iex` 使用者，server deploy 後才吐新版。

---

## v1.17.11 — Task Scheduler Duration 再調小（回報者 Eric）

**背景**：v1.17.10 把 `RepetitionDuration` 從 `[TimeSpan]::MaxValue` 改成 `36500 天（100 年）`，以為解決了問題。Eric 實測回報：

> Task Scheduler：原本註冊 P36500D（100 年）超出 Windows 允許範圍失敗，但已自動 fallback 成「每 30 分鐘觸發」，功能正常

意思是 Task Scheduler COM 底層 validator 還是 reject 了 36500 天，吐 warning 再 fallback。功能沒斷但 warning 嚇人。

**Root cause**：Windows Task Scheduler COM validator 對 `RepetitionDuration` 有上限 **約 9999 天（~27 年）**，超過就 warn。`[TimeSpan]::MaxValue` / `36500 天` 都踩線。

**修正**
- `scripts/windows/register-scanner-task.ps1`：`-RepetitionDuration (New-TimeSpan -Days 36500)` → `-RepetitionDuration (New-TimeSpan -Days 9999)`（PowerShell 社群公認的 safe-forever 值）
- `tests/scheduled-task-duration.test.js`：把允許範圍改為 `1000 <= Days <= 9999`，避免以後又手滑設太大

**對使用者**
升到 v1.17.11 跑 `register-scanner-task.ps1` 就沒 warning 了。已有安裝的直接跟 AI 說「升級 OwnMind」或手動重跑：
```powershell
cd $HOME\.ownmind
git pull
powershell -ExecutionPolicy Bypass -File scripts\windows\register-scanner-task.ps1
```

---

## v1.17.10 — 修 v1.17.9 遺漏的三個 Windows 安裝警告（回報者 Adam）

**背景**：Adam 裝完 v1.17.9 回報三個警告。檔案都在（驗證通過），但警告嚇人且暴露三個真 bug：
1. **`Copy-Item cannot overwrite with itself ×4`** — install.ps1 把 `$OwnmindDir\shared\verification.js` 複製到 `$HOME\.ownmind\shared\`，但 `$OwnmindDir` 本來就是 `$HOME\.ownmind`，等於自己複製到自己。git hook JS 檔（3 個）同樣問題。install.sh 用 `-ef` 檢查 inode 避開，install.ps1 漏做
2. **`Register-ScheduledTask Duration 格式錯誤`** — `[TimeSpan]::MaxValue` 在某些 Windows build 超出 Task Scheduler 可接受範圍，整個 task 註冊失敗 → usage scanner 排程沒上 → heartbeat 每 30 分鐘送不出去（只剩 MCP startup heartbeat 能送）
3. **`首行 BOM 字元被誤解讀為命令`** — `iwr -useb bootstrap.ps1 | iex` 時，response 首字 `\uFEFF` 被 iex 當 cmdlet 呼叫，吐「不是有效命令」warning。雖無害但會嚇到使用者以為安裝失敗

**修正**
- `install.ps1`：新增 `Copy-IfDifferent` helper，用 `[System.IO.Path]::GetFullPath` 比對解析後路徑，同位置就 skip。verification.js + 3 個 git hook JS 全改用此 helper
- `scripts/windows/register-scanner-task.ps1`：`-RepetitionDuration ([TimeSpan]::MaxValue)` → `-RepetitionDuration (New-TimeSpan -Days 36500)`（100 年，符合 Microsoft docs 建議）
- `src/app.js`：新增 `stripBom` helper，boot 時 strip bootstrap.sh / bootstrap.ps1 的首字 `\uFEFF`；磁碟上檔案仍保留 BOM（`powershell -File` 讀檔路徑還是需要）

**新增測試**
- `tests/install-ps1-copy-safety.test.js` — 靜態檢查 install.ps1 有 self-overwrite guard
- `tests/scheduled-task-duration.test.js` — 靜態檢查不再用 `[TimeSpan]::MaxValue`，改用有限大值
- `tests/bootstrap-strip-bom.test.js` — 靜態檢查 src/app.js 有 stripBom 且磁碟 bootstrap.ps1 仍有 BOM
- 全 suite 539/539 綠，零 regression

**Adam 實測驗證**
裝完 v1.17.10 應該三個警告全消失；usage scanner 排程 30 分鐘會正常執行 → `collector_heartbeat` 更新 → Admin 「裝機狀況」看得到。

**IR-022 server + client 兩端皆觸及**：server 改 `src/app.js` serve 邏輯（需 deploy）；client 改 install.ps1 + register-scanner-task.ps1。

---

## v1.17.9 — 修 Windows 兩個獨立問題（回報者 Eric + Adam）

**背景 #1（Eric）**：Windows PowerShell 5.1（Windows 10 預設）讀 `.ps1` 時用系統 codepage（繁中 Windows 是 CP950）而非 UTF-8，中文字節被誤解讀，部分序列撞到 PowerShell 保留字元（反引號、引號）造成 parser 失敗。PowerShell 7+ 沒事，但不能預期每個使用者都升 pwsh。

**背景 #2（Adam）**：從 Git Bash / MSYS 呼叫 `install.ps1` 時，`$HOME` 被污染成 POSIX 格式 `/c/Users/Adam`，跟 Windows path 串接後變 `C:\c\Users\Adam\.gemini\settings.json.tmp` 怪路徑（多了一層 `c\`），node 寫檔到錯地方，設定檔全寫到不存在的目錄。另外 Adam 的 `install.ps1 --update` 走了舊版路徑，`--update` 被當成 API key。

**修正 #1 — UTF-8 BOM**
- `install.ps1` / `scripts/bootstrap.ps1` / `scripts/interactive-upgrade.ps1` / `scripts/windows/register-scanner-task.ps1` 全部加上 UTF-8 BOM（`EF BB BF`）
- 對 PowerShell 7+ 是 no-op，對 5.1 強制走 UTF-8 路徑

**修正 #2 — 環境正規化 preamble**
- 每支 `.ps1` 開頭加：
  ```powershell
  if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
    Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
  }
  ```
- 保證無論從哪個 shell 呼叫，`$HOME` 一律指向 Windows 格式 `C:\Users\xxx`，`Join-Path $HOME ...` 不再被 POSIX 路徑污染

**修正 #3 — install.ps1 flag 過濾**
- `$args` 在進位置參數前先過濾掉開頭 `-` 的項（`--update` / `-u` 等）
- 即使舊版 interactive-upgrade 還傳 `--update`，也不會被當成 API key 寫進 MCP config

**新增測試**
- `tests/ps1-utf8-bom.test.js` — 全 repo .ps1 必須以 UTF-8 BOM 開頭（含中文才檢查）
- `tests/ps1-windows-compat.test.js` — 4 支 .ps1 都有環境正規化 preamble；install.ps1 有 flag 過濾

**對已卡住的使用者**
腳本失敗已經自動還原舊版的話，一次性重裝最乾脆：
```powershell
Remove-Item -Recurse -Force $HOME\.ownmind
$env:OWNMIND_API_KEY='你的 key'
$env:OWNMIND_API_URL='你的 API URL'
iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```
Bootstrap 會抓到含 BOM + 環境正規化 + flag 過濾的 v1.17.9 乾淨 clone，之後升級自動走新路徑。

**IR-022 server + client 兩端皆觸及**：純 client 端修 — 但因 bootstrap route（v1.17.6 加的 public endpoint）會 serve `bootstrap.ps1`，server deploy 後使用者 one-liner 才會抓到 BOM 版。

---

## v1.17.8 — 本地記憶雲端 delta sync（A+C 方案）

**背景**：`~/.claude/projects/<slug>/memory/*.md` 是 Claude Code 每次 session 載入的 auto-memory，但這些檔案是一次性快照。當 Vin 用 `ownmind_save` 或 Admin UI 更新雲端記憶後，本地 md 不會自動刷新 — SessionStart 把過期的 MEMORY.md 當 context 餵給 AI，AI 根據 24 天前的快照下結論（實際案例：把 P2-P5 roadmap 當最新待辦，但雲端主線早已換成 token-usage-tracking）。

**新增（Server）**
- `src/lib/memory-sync.js` — 純函式：`parseSyncTypes` / `parseSince` / `buildSyncQuery`，可單元測試
- `src/routes/memory.js`：新增 `GET /api/memory/sync?types=iron_rule,project,feedback&since=<ISO>`
  - `types` 白名單過濾（只允許 iron_rule / project / feedback — 過期最痛的三類）
  - `since` 省略 → 只回 active（首次同步用）
  - `since` 帶上 → 回 `updated_at > since OR disabled_at > since`（含 tombstone）
  - 回傳 `{server_time, memories: [...]}`
  - 用 `ANY($2::text[])` 防 SQL injection

**新增（Client）**
- `hooks/lib/sync-memory-files.js` — Node script，stdin 吃 JSON 後：
  - 解出 `<memoryDir> = $HOME/.claude/projects/<CLAUDE_PROJECT_DIR slug>/memory/`
  - 首次若有手寫 MEMORY.md → 備份到 `MEMORY.md.pre-sync-backup-<ts>`
  - 寫 `<type>_<id>_<slug_title>.md` 含 frontmatter（name / description / type / cloud_id / updated_at）
  - `status='disabled'` 或本地 orphan（不在 active 集合）→ 刪掉
  - 重算 MEMORY.md：auto-sync marker + 按 type 分組 + 每行 `— updated YYYY-MM-DD`（C 部分 staleness badge）
  - `--fail` 模式：在 MEMORY.md 頂端插「⚠️ last sync FAILED」警告但不刪檔；連續 fail 不堆疊警告
- `hooks/ownmind-session-start.sh`：init API 之後串 sync endpoint + 呼叫 node script（fail-silent、不阻塞 session）

**測試**
- `tests/memory-sync-endpoint.test.js`（16 tests）— parser / query builder / whitelist / SQL shape
- `tests/sync-memory-files.test.js`（19 tests）— slugify / filename / 首次寫入 / 備份機制 / tombstone / fail mode / 二次 re-sync
- 全 suite 518 tests 綠，零 regression

**IR-022 server + client 兩端皆觸及**：server 是新 `/sync` endpoint + 純函式 lib；client 是新 node script + 改 shell hook。

**使用者零操作**：升到 v1.17.8 後下一次開 Claude Code session 自動同步。SessionStart 失敗或 server 連不上時用本地舊版但會在 MEMORY.md 插警告，AI 自己看得到「local 可能過期」。

---

## v1.17.7 — MCP 技巧提示每次都顯示（對齊 skill 文件承諾）

**背景**：skill 文件 `ownmind-memory.md` 寫「MCP tool 每次回傳自動附上一行隨機小技巧」，但 `mcp/index.js:996` 實際上用 `if (++tipCallCount % 10 === 1)` 每 10 次才顯示 1 次。文件 vs 實作不一致被 Vin 抓到。

**修正**
- `mcp/index.js`：拿掉 `tipCallCount` + modulo gating，每次 tool call 的 response 都會附 `【OwnMind vX.X.X】技巧提示：...`
- 現在用戶每次呼叫 MCP tool 都會看到一條隨機小技巧（從 50+ 條 TIPS 池裡隨機挑，避開上一次選過的）

**新增測試**
- `tests/tip-every-call.test.js`：靜態檢查 `mcp/index.js` 不再含 `tipCallCount % 10` gating，且 `contentParts.push(...技巧提示...)` 呼叫沒有被 modulo 條件包住

**為什麼不吵**：隨機 TIP 池有 50+ 條，每次挑一條又避開上次選過的，實際體驗是「每次都有小教學」而不是「同樣提示不停冒出」。

---

## v1.17.6 — Universal Bootstrap（一句指令搞定安裝/升級/修復）

**背景**：之前 install / upgrade 分成 4 支腳本（`install.sh` / `install.ps1` / `interactive-upgrade.sh` / `interactive-upgrade.ps1`），user 得自己判斷跑哪一支；新用戶更慘，完全不知道從哪開始。跨平台（Windows vs Mac）又多一層分岔。

**新增**
- `scripts/bootstrap.sh` + `scripts/bootstrap.ps1`：單一入口，自動三分支處理
  1. `~/.ownmind` 不存在 → `git clone` + `install.sh/.ps1`（轉發 `$@` / `@args` 作為 API_KEY / API_URL）
  2. 存在但不是 git repo（壞掉）→ 備份到 `~/.ownmind.broken.<timestamp>` + 重 clone + install
  3. 是 git repo（正常）→ 轉交 `interactive-upgrade.*`
- Express 新增 public routes：`GET /bootstrap.sh` + `GET /bootstrap.ps1`（不需 auth，給新機器用；boot 時 `readFileSync` 進記憶體，零 disk I/O per request）
- `skills/ownmind-upgrade.md` 擴充：新觸發詞「裝」「重裝」「修」「OwnMind 壞了」「install」「repair」；新 Mode D 合併進 Mode B 統一走 bootstrap

**修正（pre-existing bug，被 bootstrap 的升級路徑暴露出來）**
- `scripts/interactive-upgrade.ps1` 原本呼叫 `install.ps1 --update`，但 `install.ps1` 沒有 `--update` 參數 — 它會把 `--update` 當成 `$args[0]` (API_KEY)，Windows 升級 silent mis-config。現在改成和 bash 版一致：從 `~/.claude/settings.json` 讀 credentials，以 positional args 傳給 `install.ps1`。

**硬化（Codex review 建議）**
- `bootstrap.sh` 加 `set -o pipefail`，避免 `git clone | while read` 遮蔽 git 失敗
- `bootstrap.ps1` branch 2（壞掉修復）clone 後加 `$LASTEXITCODE` + `.git` 驗證（branch 1 本來就有）
- `src/app.js` 拿掉 `sendFile` 的 `dotfiles: 'allow'`，改為 boot 時一次 `readFileSync` 到記憶體並從 buffer 回應

**使用方式 — 任何平台、任何狀態**

對 AI 說一句：
- 「升級 OwnMind」 / 「裝 OwnMind」 / 「修 OwnMind」 / 「OwnMind 壞了」

AI 自動偵測 OS + 狀態後執行正確動作。

**或命令列 one-liner（不靠 AI）**

Mac / Linux / Git Bash（**已安裝、只升級**）：
```bash
curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash
```

Mac / Linux / Git Bash（**首次安裝**，要提供 API key + URL）：
```bash
curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash -s -- YOUR_API_KEY YOUR_API_URL
```

Windows PowerShell（**已安裝、只升級**）：
```powershell
iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```

Windows PowerShell（**首次安裝**）：
```powershell
$env:OWNMIND_API_KEY='YOUR_API_KEY'; $env:OWNMIND_API_URL='YOUR_API_URL'; iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```

**新增測試**
- `tests/bootstrap-script.test.js`：靜態檢查兩支 bootstrap 腳本的三分支、+x bit、logging 格式、curl-pipe 安全性
- `tests/bootstrap-routes.test.js`：Express integration tests（ephemeral listen + fetch）驗證 public routes 無 auth 回對的 content-type + body

**IR-022 server + client 兩端皆觸及**：client 是兩支 bootstrap 腳本；server 是兩個 public routes + 修好的 `interactive-upgrade.ps1`。

---

## v1.17.5 — Heartbeat 雙層防護（Client once-per-process + Server 30s rate-limit）

**背景**：v1.17.4 在 MCP server 啟動時加了 heartbeat 觸發。若某位使用者的 MCP 被配錯導致 crash-loop（啟動 → crash → 重啟），每次重啟都會發一次 heartbeat，理論上可以飆到每分鐘數十次。server 端 UPSERT 是 O(1) 不會炸，但 log 會被灌爆、DB 連線池壓力增加。

**修正（雙層 defense-in-depth）**

**A. Client 端：每個 MCP process 最多發 1 次 heartbeat**
- `mcp/index.js`：`sendMcpHeartbeat` 加 module-scope flag `heartbeatSent`。flag 設在 `await` 之前，所以平行/高速連續呼叫也會 short-circuit（不會競爭發多個 POST）。
- 副作用（好的）：v1.17.4 code review 的 M1「startup + ownmind_init 會 double-fire」自動解決 — startup 搶到 flag 後，ownmind_init 的呼叫直接 early return。

**B. Server 端：heartbeat UPSERT 在 30 秒內為 no-op**
- `src/routes/usage/events.js`：新增 `HEARTBEAT_RATE_LIMIT_SECONDS = 30` 常數。`writeHeartbeatIfPresent` 的 `ON CONFLICT ... DO UPDATE` 加 `WHERE collector_heartbeat.last_reported_at < NOW() - INTERVAL '30 seconds'` 子句。同一 (user, tool) 在 30 秒內重複收到 heartbeat，SQL 層直接不更新（單一 atomic query，無額外 round-trip）。即使 client 端 guard 失效，server 這層也擋得住。

**新增測試**
- `tests/heartbeat-once-per-process.test.js`：靜態檢查 `mcp/index.js` 有 module-scope flag + early-return guard + 設 flag 時序正確（必須在 await 之前）。
- `tests/heartbeat-rate-limit.test.js`：靜態檢查 `events.js` 的 UPSERT 含 WHERE 子句 + 命名常數（不是 magic number）。

**升級方式**
v1.17.4 → v1.17.5：跑 `bash ~/.ownmind/scripts/interactive-upgrade.sh` 或對 AI 說「升級 OwnMind」。Server 端需要 deploy（本版有 server code 改動）。舊版（< v1.17.4）使用者看到的 v1.17.4 廣播會把他們直接帶到 main 最新版（含本版修正），不需要另發廣播。

---

## v1.17.4 — MCP 啟動即發 heartbeat（自動安裝回報）

**背景**：v1.17.2 引入的 heartbeat 只在 `ownmind_init` 時觸發。只用 `ownmind_get` / `ownmind_save` 等工具、從不呼叫 init 的已安裝使用者，在 Admin 的「裝機狀況」永遠顯示「未裝」。

**修正**
- `mcp/index.js`：在 `new StdioServerTransport()` 之前加一行 `sendMcpHeartbeat()`。MCP server 每次啟動都 fire-and-forget 一次 heartbeat（不 await，不會 block 啟動）。UPSERT keyed by `(user_id, tool)`，重複呼叫只會刷新 `last_reported_at`，無害。
- 影響：所有支援 MCP 的 AI 工具（Claude Code / Cursor / Codex / Antigravity / OpenCode）啟動時自動回報 — 使用者無需手動動作。

**新增測試**
- `tests/mcp-startup-heartbeat.test.js`：靜態檢查 `mcp/index.js` 源碼，確保 top-level `sendMcpHeartbeat();` 呼叫存在於 `await server.connect(transport)` 之前。

**升級方式**
舊版（≤ v1.17.3）使用者跑一行指令即可：
```bash
bash ~/.ownmind/scripts/interactive-upgrade.sh
```

---

## v1.17.3 — MCP 支援多 AI 工具識別（OWNMIND_CLIENT_TOOL env var）

**背景**：v1.17.2 的 MCP heartbeat 把 `tool` hardcode 成 `claude-code`，導致 Cursor / Codex / Antigravity / OpenCode 等用戶用 MCP 時會被誤標為 claude-code，污染 dashboard 的 per-tool 統計。

**新增**
- `mcp/index.js`：新增 `CLIENT_TOOL` 常數，從 `OWNMIND_CLIENT_TOOL` 環境變數讀取，預設 `claude-code`。影響兩處：
  - `callApi` header `x-ownmind-tool`
  - `sendMcpHeartbeat` 的 `heartbeat.tool`
- **設定方式**：非 Claude Code 用戶在他們的 MCP config 加環境變數：
  ```json
  { "env": { "OWNMIND_CLIENT_TOOL": "cursor" } }
  ```

---

## v1.17.2 — 廣播強制通知 + 新用戶 onboarding + MCP heartbeat + 版本檢查閉環

**本版包含四個方向的強化：**

### 1. 廣播強制通知（防止 AI 靜默略過）

**背景**：廣播通知系統原本靠 `configs/CLAUDE.md` 指示 AI 顯示，但 AI 可以忽略。IR-027 要求「提醒無效，邏輯才有效」—用程式強制觸發。

**新增**
- `hooks/lib/render-session-context.js`：當渲染的廣播中有 `severity='warning'/'error'` 或 `type='upgrade_reminder'` 時，動態注入 `[SYSTEM] 強制行動要求` instruction block，強制 AI 在第一句回應中主動告知使用者。INFO 廣播維持被動顯示。
- `configs/CLAUDE.md`：新增「廣播通知處理規則」區塊，定義各 severity 的 AI 行為規範。
- `tests/session-start-render.test.js`：新增 4 個 TDD 測試（warning、error、upgrade_reminder、info 各一）。

### 2. 新用戶自動 Onboarding

**背景**：新用戶第一次 `ownmind_init` 時 profile/principles/iron_rules 全空，API 只回傳版本資訊，AI 沒辦法主動引導。

**新增**
- `src/utils/onboarding.js`：`buildOnboarding({ hasAnyMemory, onboardingCompletedAt, tool })` 純函式，偵測是否為新用戶並回傳引導資料。
- `src/routes/memory.js`：`/api/memory/init` 新增 `_onboarding` 欄位；首次儲存任何記憶時自動寫入 `users.settings.onboarding_completed_at`（永久標記，防止刪光後被重新引導）。
- `mcp/index.js`：`callApi` 加 `x-ownmind-tool: claude-code` header；`ownmind_init` 偵測新用戶 flag 時注入 `_onboarding_instruction` 強制 AI 問名字/工作並建立 profile。
- `configs/CLAUDE.md`：新增「新用戶 Onboarding 規則」。

**修補的 bug**
- **Bug 1（誤判）**：偵測邏輯從「只看 profile/principle/iron_rule 三種」改為「查使用者有沒有任何類型的 active memory」（10 種類型全納入），避免只有 `coding_standard`/`project` 等記憶的老用戶被誤判。
- **Bug 2（重複觸發）**：新增 `users.settings.onboarding_completed_at` 永久標記，避免用戶刪光記憶後重新被引導。

### 3. MCP Heartbeat（裝機狀態感知）

**背景**：裝機狀態 dashboard 只看 `collector_heartbeat`（由排程 scanner 寫入），所以**只裝 MCP 沒跑 `install.sh`** 的用戶會錯誤顯示為「未裝」。

**新增**
- `mcp/index.js`：每次 `ownmind_init` 呼叫後 fire-and-forget 發 heartbeat（`tool=claude-code`, `scanner_version=CLIENT_VERSION`, `machine=hostname`）到 `/api/usage/events`。失敗靜默不阻塞 init。
- **效果**：只要用戶有啟動 AI 用 OwnMind，dashboard 就會自動顯示為「已裝」，不需額外跑排程。

### 4. 版本檢查閉環（三層 drift detection）

**Goal**：user 說「查版本」→ 三層完整檢查 → 有新版主動問是否升級 → 同意就一路跑完 interactive-upgrade.sh。

**新增**
- `scripts/check-sync.sh` — 三層 OwnMind 健檢腳本：
  - **L1 Remote**：`~/.ownmind` git HEAD vs origin/main（偵測 auto-update 沒拉到的情況）
  - **L2 Server**：client `package.json.version` vs server `server_version`（semver 比，pre-release 視為低於 stable）
  - **L3 Deploy**：比對 `~/.claude/hooks/*`、`~/.claude/hooks/lib/*.js`、`~/.claude/skills/ownmind-*/SKILL.md` 跟 `~/.ownmind/` source 是否 byte-identical（抓 user 忘記跑 `update.sh` 的情境）
  - 結構化 STDOUT（`L1_REMOTE:`、`L2_SERVER:`、`L3_DEPLOY:`、`L3_DRIFT_FILE:`、`OVERALL:`）供 skill 解析
  - 永不 exit != 0，錯誤走 `error` 標籤
- `skills/ownmind-upgrade.md` 擴充：
  - 加「模式 A 查版本」觸發詞（「查版本」/「版本多少」/「我的版本」/「版號」/「check version」）
  - 模式 A → call `check-sync.sh` → 解析三層 → 報告 user + 有 drift 主動問「要我幫你升嗎?」 → user 同意就導流模式 B
  - 模式 B（升級）與模式 C（snooze）保留原邏輯

**背景**：原本只靠廣播推 + 使用者主動說「我要升級」。現在加上 **user 主動查版本** 這個入口，且補上 **L3 deploy drift** 偵測（解決 `~/.ownmind` 已新但 `~/.claude/hooks/` 沒同步的盲區）。

**測試**：手動模擬 drift（改 1 byte） → L3 正確列出 drifted 檔案；復原 → OVERALL:in_sync。

---

## v1.17.1 — security patch + install.sh hotfix + npm audit 修復

### npm 依賴安全升級（2026-04-23）

- `path-to-regexp` → 8.4.2（修復高危 ReDoS，`npm audit fix` 自動處理）
- `node-cron` 3.x → 4.2.1（移除內嵌 uuid 依賴，解決 moderate ReDoS）
- `uuid` 13.x → 14.0.0（修復 buffer bounds check CVE）
- `npm audit` 結果：0 vulnerabilities

---

## v1.17.1 — security patch + install.sh hotfix

### 安全強化（五項）

**C2 — /setup SETUP_TOKEN 保護**：`/setup` 端點改為必須在 request body 帶 `setup_token`，server 端驗證與 `SETUP_TOKEN` 環境變數是否吻合。未設定 `SETUP_TOKEN` 則端點直接回 403，防止初裝窗口期被搶佔 super_admin。

**C3 — ENCRYPTION_KEY fail-fast**：啟動時若 `ENCRYPTION_KEY` 未設或為預設值，強制 `process.exit(1)`，防止靜默 fallback 導致 secrets 以公開金鑰加密儲存。

**C5 — Sync token 強制驗證**：寫入操作未帶 `sync_token` 改為直接回 409，要求先呼叫 `ownmind_init`，防止持有 API key 的攻擊者繞過 MVCC 保護靜默覆寫記憶。

**C6 — Rate limiting + CORS 收斂**：加入 `express-rate-limit`（auth 路由 10次/15分鐘，所有 API 200次/分鐘）；CORS 改為只允許 `CORS_ORIGIN` 環境變數指定的 origin，未設定則禁止跨域。

**U3 — 移除 session.js 死代碼**：`SENSITIVE_PATTERNS` array 從未被 `sanitize()` 使用且含誤導性寬泛 regex，一併移除。

### Hotfix

**install.sh — safe_cp 避免升級情境 `cp` 同檔案錯**：加 `safe_cp` helper 用 `-ef` 判 source/dest 是否同 inode，相同就跳過，修復升級時 macOS `cp` 回「identical」導致 rollback 的問題。

---

## v1.17.0（2026-04-22）— Client 版本 Dashboard、廣播通知、互動升級

**Bug**：升級既有 `~/.ownmind` 時，`install.sh` 多處 `cp $OWNMIND_DIR/X $HOME/.ownmind/X/` 源 == 目的路徑 → macOS `cp` 回 `... are identical (not copied).` → exit 1 → `interactive-upgrade.sh` 觸發 rollback → 客戶端無法升級（SessionStart hook 不會同步到 broadcast 檔案）。

**Fix**：
- `install.sh` 加 `safe_cp` helper：先用 bash `-ef` 判 source/dest 是否同 inode，相同就跳過
- 5 處會 same-file 失敗的 `cp` 改用 `safe_cp`（verification.js、git hook JS、scanner entry、scanner/shared 模組、scanner wrapper）
- 其餘 cp（複製到不同目錄）維持原狀

**測試**：實機重跑 `install.sh` 完整通過；`~/.claude/hooks/lib/` + `ownmind-session-start.sh` 新版都 deliver 到位。

---

## v1.17.0（開發中）— Client 版本 Dashboard、廣播通知、互動升級

> 讓 admin 一眼看到裝機版本、推播提醒，讓 user 說「我要升級」就有 AI 自動完成。
> Spec / Plan：`docs/superpowers/specs/2026-04-22-client-version-broadcast-upgrade-design.md`、`docs/superpowers/plans/2026-04-22-client-version-broadcast-upgrade.md`

### P5–P7 — 互動升級 Script + 驗測 + AI 工具 Skill 分發

**P5：Upgrade Script**
- `scripts/interactive-upgrade.sh` — 結構化 stdout（`INFO/OK/ERROR/ASK:<code>:msg`），AI 可逐行轉述
- `scripts/interactive-upgrade.ps1` — Windows PowerShell 版，同結構
- 流程：pre-check → backup → git pull --ff-only → npm install → install.sh（從 `~/.claude/settings.json` 讀 creds）→ 重註冊 launchd/systemd/Task Scheduler → 驗測 → 清理
- **失敗自動 rollback**：`~/.ownmind.bak.<timestamp>` → `~/.ownmind`（任何步驟失敗都還原，user 不會壞掉）

**P6：Verification Script + memories.is_test**
- `scripts/verify-upgrade.sh --local` — MCP / skill / hook / VERSION 存在性
- `scripts/verify-upgrade.sh --server` — `/health` ping → 寫測試 memory（`__upgrade_test__<ts>__<host>`）→ 讀回 → init API 鐵律 digest 檢查
- `scripts/verify-upgrade.sh --cleanup` — 清 `is_test=TRUE AND title LIKE '__upgrade_test__%'`
- `POST /api/memory` 新增 `is_test` 欄位，**只允許 `__upgrade_test__` 開頭 title**（防止 user 繞過 sync）
- `DELETE /api/memory/test-cleanup?name_prefix=__upgrade_test__` — 雙重保險（is_test=TRUE + title LIKE + user_id 隔離）

**P7：AI Tool Skills 分發**
- `skills/ownmind-upgrade.md` — Claude Code skill（觸發詞：「我要升級」/「升級 OwnMind」；錯誤碼引導表）
- `skills/ownmind-upgrade-agents-snippet.md` — 給 Codex / Cursor / Antigravity / OpenCode / Windsurf / Gemini 的通用規則片段
- `install.sh` + `scripts/update.sh` **偵測目錄存在才裝**，跳過未安裝工具；以 `<!-- ownmind-upgrade-rule -->` marker 包住，重跑時自動去重

**測試**
- `tests/memory-upgrade-test.test.js`（3 tests）：is_test guard、test-cleanup route 存在、user_id 隔離
- `scripts/interactive-upgrade.sh` 實機 smoke test：fail-safe rollback 驗證通過
- **458 tests pass**（P4 後 455 + P5-P7 新增 3）

### 驗證覆蓋
- 所有 10 個 spec scenarios（A-K）已涵蓋
- Codex adversarial review：P1 13 findings / P2 7 findings 全數修復

### Deploy 步驟（ship v1.17.0 時跑）
1. `psql -f db/008_broadcast.sql`（migration）
2. `docker compose build --no-cache`（IR-018 + IR-023）
3. Push + 部署 → 瀏覽器實測（IR-020）：裝機狀況 tab、廣播管理、發測試廣播 → user 端在 Claude Code / Codex / Cursor 應看到
4. `git tag v1.17.0`（IR-031）+ push tag

---

### P4 — MCP Response 注入（Layer 2：跨工具通用）

**新增 Server endpoint**
- `POST /api/broadcast/inject` — 每次 MCP `ownmind_*` tool call 時 ping
  - Upsert `user_tool_last_seen`（判首次 / 4h gap）
  - 判 `is_first_of_day`（Asia/Taipei day boundary）+ `is_long_gap`（> 4h）
  - `forceInject = isFirstOfDay || isLongGap`（覆蓋 cooldown）
  - 未 force 時走每則廣播的 `cooldown_minutes`
  - Mark `user_broadcast_state.last_injected_at` 防刷屏
  - Response：`{ broadcasts: [...], force: bool }`，MCP client 直接拿去 prepend

**MCP Client 改動**
- `mcp/index.js` CallToolRequestSchema handler 新增 `fetchBroadcastsSafely()`：
  - 每次 tool call 完 → POST `/api/broadcast/inject`
  - 2 秒 timeout、失敗靜默（不該因廣播掛掉 tool）
  - `renderBroadcasts()` → prepend 到 content parts 最前面
  - 舊版 MCP client 自動相容（不接 `_broadcast` 欄位也能看到，因為就是 text）

**行為**
- User 每天第一次 call ownmind → 一定看到廣播
- 上次 call 超過 4h（午休 / 過夜）→ 再次注入
- 同 session 狂 call → cooldown 擋住不刷屏
- 每則廣播有自己的 cooldown_minutes（升級提醒 30 分、一般 1440 分）

**測試**
- 新增 5 個 test 於 `tests/broadcast.test.js`：missing tool 400、first-of-day force、4h gap force、cooldown 擋注入、unauthenticated 401
- **455 tests pass**（P3 後 450 + P4 新增 5）

---

### P3 — Claude Code SessionStart Hook 讀廣播（Layer 1）

**新增**
- `hooks/lib/render-session-context.js` — 純函式 `renderSessionContext(data, broadcasts)`；拆出 render 邏輯方便 unit test
- `hooks/lib/session-start-output.js` — Node CLI 包裝，給 hook shell script 呼叫
- `hooks/ownmind-session-start.sh` — 新增 `curl /api/broadcast/active?tool=claude-code`（fail-silent 3 秒 timeout）；render 改呼叫 lib 模組

**行為**
- 每次 Claude Code session 啟動，hook 把當前應顯示的廣播 prepend 到 `additionalContext` 最前面（`## 📢 OwnMind 系統通知`）
- 廣播 render 包含：severity badge / title / body（截 400 字 / 5 行）/ CTA hint / snooze 選項
- 最多 3 則，其餘顯示「另有 N 則廣播未顯示」

**部署**
- `install.sh` + `scripts/update.sh` 同步 `hooks/lib/*.js` 到 `~/.claude/hooks/lib/`

**測試**
- 新增 10 個 test（`tests/session-start-render.test.js`）：無廣播、順序、CTA/snooze、超量截斷、多行折疊、memory sections、結尾訊息
- **450 tests pass**（P2 後 440 + P3 新增 10）

---

### P2 — 廣播系統 Backend + Admin CRUD

**新增**
- `src/lib/broadcast-filter.js`：`filterVisibleBroadcasts` + `filterInjectable` — 單一 filter logic，P4 MCP injection 也會共用
- `src/routes/broadcast.js`：
  - `POST /api/broadcast/admin`（super_admin）— 發布廣播
  - `GET /api/broadcast/admin?include_ended=true`（admin+）— 列表
  - `PATCH /api/broadcast/admin/:id`（super_admin）— 更新 ends_at / target_users
  - `DELETE /api/broadcast/admin/:id`（super_admin）— 撤銷（soft delete = ends_at=NOW()）
  - `GET /api/broadcast/active?tool=X`（all）— user 當下應看到的廣播（套 filter，不含 cooldown）
  - `POST /api/broadcast/dismiss`（all）— dismiss 或 snooze，allow_snooze=false 時只能 dismiss
- `src/jobs/nightly-upgrade-reminder.js`：每天 03:30 Asia/Taipei 跑 `ensureUpgradeReminder`；用 `max_version=${SERVER_VERSION}-prev` 搭配 pre-release semver 規則，讓只有落後的 client 收到提醒
- Dashboard「設定」tab 新增「廣播管理」sub-panel（super_admin only）：發布 / 列表 / 撤銷，auto-managed 項（升級提醒）不可手動撤銷

**決策**
- **Cooldown 不放在 /active 端點** — filter_visible 只做基本可見性檢查；cooldown 是 injection 時的「避免刷屏」策略，dashboard 查詢則應列出所有當下生效的廣播
- **撤銷 = soft delete**（`ends_at=NOW()`）— 保留歷史紀錄，避免誤刪；auto-managed 由 unique partial index 保證冪等

**測試**
- 新增 28 個 test（`tests/broadcast.test.js`）：validate payload、CRUD 權限邊界、snooze / dismiss 行為、filterVisibleBroadcasts semver filter、filterInjectable cooldown、ensureUpgradeReminder 冪等性
- **422 tests pass**（P1 後 394 + P2 新增 28）

---

### P1 — DB Migration + 裝機狀況 Dashboard

**資料層**
- `db/008_broadcast.sql`：4 張新表 — `broadcast_messages`、`user_broadcast_state`、`user_tool_last_seen`；`memories` 加 `is_test BOOLEAN` + partial index（升級驗測用，D16）
- Unique partial index `ux_broadcast_auto_upgrade` 保證自動升級提醒同版本只插一筆

**API**
- `GET /api/usage/admin/clients` — admin+；每 (user, tool) 最新 heartbeat 聚合 + needs_upgrade（semver 比對）+ status（active/stale/offline）+ coverage summary
- `src/utils/semver.js`：`parseSemver` / `compareSemver` / `isLower` / `isHigher` — 供 P2/P4 共用，避免散落多處

**Dashboard**
- 「設定」tab 下新增「裝機狀況」sub-panel（super_admin 可見）
- 一表看完：user / role / 整體狀態 / 各 tool 版本 + 相對時間（10 分鐘前 / 1 天前）
- Status 色碼：🟢 Active（24h 內）/ 🟠 Stale（24–48h）/ 🔴 Offline（>48h）/ 🟡 需升級 / ⚪ 未裝
- Coverage summary 文字：「共 N 人 · 已裝 X · active Y · stale Z · offline W · 未裝 M · K 人需升級」

### 測試
- 新增 10 個 test（`tests/clients.test.js`）：auth 權限、狀態分類、semver 升級判定、multi-tool 聚合、coverage 統計、排序規則
- **378 tests pass**（既有 368 + P1 新增 10）

### 決策摘要（spec 完整列表）
- **D2** 版本落後以 `scanner_version < SERVER_VERSION` 為準，null/unknown 一律視為舊版需升級
- **D14** 廣播後續採 main-response-text-prepend（P4），舊版 client 自動相容；P1 先鋪好 DB 欄位
- **D16** `memories.is_test` flag：升級驗測寫入的測試資料不進 sync、不 trigger alert（P6 用）

### 已知限制 / Deploy 注意
- SQL 未對 prod postgres 執行，deploy 時 `psql -f db/008_broadcast.sql` 手動驗證
- 前端 JS 暫仍靠 `renderOverallStatus` / `renderToolList` / `formatAgo` 在全域 scope；這是既有 index.html 的 pattern，未來拆 module 時一併處理

---

## v1.16.0 - Token 用量追蹤系統（全 9 phase）

> 跨 IDE token / 成本 / 工時追蹤，從 raw event 收集到團隊績效 dashboard 一條龍。
> Spec / Plan：`docs/superpowers/specs/2026-04-21-token-usage-tracking-design.md`、`docs/superpowers/plans/2026-04-21-token-usage-tracking.md`
> PR：#5

### 新增功能

**資料層**
- `db/007_token_usage.sql`：7 張新表 — `model_pricing`、`token_events`（含 `cumulative_total_tokens NOT NULL` 與 `codex_fingerprint_material JSONB`）、`token_usage_daily`、`collector_heartbeat`、`session_count`、`usage_tracking_exemption`、`usage_audit_log`；附 claude-code / codex 初始定價
- `src/utils/pricing-lookup.js`：`pickPricing` / `computeCost` / `lookupPricing` — effective_date 歷史版本查找，TZ-proof YYYY-MM-DD 比對，`id DESC` tiebreaker

**API**
- `POST /api/usage/events` — raw event ingestion（含 Tier 2 `sessions` array）
  - 必填驗證、model allowlist、D7 token_regression 偵測、UNIQUE dedupe、觸發 aggregation
  - Codex 專用：`codex_fingerprint_material` 必填 → server canonicalize → `expectedId` 強制覆寫；client id 錯誤寫 `fingerprint_mismatch`，ON CONFLICT 寫 `fingerprint_collision`
  - Heartbeat UPSERT（支援空 events + heartbeat-only）
  - Exemption 最早檢查、audit 壓制
- `GET /api/usage/stats`（個人）— 日期區間、group_by 日/工具/model/session，Tier-1 + Tier-2 合併，`is_exempt` flag
- `GET /api/usage/team-stats`（admin+）— coverage panel（`reporting_today` / `stale` / `opted_out` / `per_tool`）+ per-user aggregate
- `GET /api/usage/pricing`、`POST /api/usage/pricing`（super_admin, append-only）
- `usage_tracking_exemption` CRUD（super_admin），granted / reason_updated / revoked 三種 audit
- `GET /api/usage/admin/audit`（admin+，可 filter event_type）

**後端 Job**
- `src/jobs/usage-aggregation.js` — `recomputeDaily`：冪等；cost 採 null-on-any-unknown policy；wall / active seconds 以 Asia/Taipei 切日、600s gap 判離線
- `src/jobs/nightly-recompute.js` — 每日 03:00 Asia/Taipei 重算近 7 天（處理 pricing 變更 / 漏算）

**Client Scanner（5 個 IDE）**
- `shared/scanners/base.js` — 單一 `runScan` 流程（spec D11）：讀 offset → 分批 POST → 全部成功才原子寫回；失敗可無痛重送（server UNIQUE dedupe）
- `shared/scanners/id-helper.js` — Codex 專用 canonical material + SHA-256 message_id（64 hex，client + server 共用同一支）
- Tier 1：`claude-code.js`、`codex.js`（yyyy/mm/dd 遞迴）、`opencode.js`（sqlite3 CLI、composite `(time_created, id)` cursor）
- Tier 2：`cursor.js`、`antigravity.js` 共用 `vscode-telemetry.js`（state.vscdb）
- `hooks/ownmind-usage-scanner.js` — 主 entry；PID-aware 自我 lock（live/stale/6h mtime）；runtime opt-out flag

**Always-on 排程**
- `scripts/install-helpers/run-scanner.sh` — wrapper 動態找 node（`.node-path` → PATH → glob）+ v20+ 驗證
- macOS launchd plist（30 分鐘 + RunAtLoad）
- Linux systemd user timer（OnBootSec=5min + OnUnitActiveSec=30min）
- Windows Task Scheduler（PS 腳本，單一 Once+Repetition trigger，WriteAllText 無 BOM）
- `install.sh` / `install.ps1` 自動偵測 node、寫 `.node-path`、註冊 schedule；尊重 `~/.ownmind/.no-usage-scanner` opt-out

**Dashboard（Admin 後台）**
- 「我的用量」tab（所有 user）：日期區間 + group_by + 10 張 stat-mini 卡片 + bar chart + 追蹤狀態指示燈（`is_exempt` 警示）
- 「團隊用量」tab（admin+）：coverage panel 強制顯示，< 80% 自動浮水印「資料不完整」；排行榜可依 cost / 訊息 / 活躍時長排序
- Model 定價管理子面板（super_admin）：append-only 新增 effective_date row
- Audit log 子面板（admin+）：event_type filter、最近 100 筆

### 決策與鐵則

- **Client 只送 raw event**（D1）：Cost 100% server-side 算；client 的 `native_cost_usd` 僅供比對
- **Codex fingerprint**（D10 / D13）：完整 sha256 64 hex 不截斷（避免 `DO NOTHING` 永久丟資料）；server expectedId 為唯一 truth source
- **Cost null policy**：任何 unknown pricing → 整筆 cost_usd = null（不做 partial cost；codex review 修復過的 P2 bug）
- **Coverage gate**（D5）：團隊 dashboard < 80% 強制顯示「資料不完整」浮水印
- **透明 opt-out**（D3）：豁免由 super_admin 在 dashboard 操作，用戶看得到狀態；無 local opt-out sentinel

### 測試
**361 tests pass**（既有 165 + P1–P9 本次 196 個新測試）
- 單元：pricing-lookup、id-helper canonicalize / hash、aggregation（cost / wall / active）
- Route：events（exempt / codex / heartbeat / sessions / null-cost）、stats、team-stats、pricing、exemptions
- Scanner：base（atomic offsets / batching / crash-resume）、claude-code、codex、opencode、cursor/antigravity、run-scanner.sh wrapper（spawn bash + stub node）

### 已知限制（deploy / 觀察期再處理）
- 所有 SQL 尚未對真實 postgres 執行過；deploy 時以 `psql -f db/007_token_usage.sql` 驗證
- 5 個 scanner 未 end-to-end 打真實 server 跑整輪；Vin 本機試跑 P4（Claude Code）為首批
- launchd / systemd / Task Scheduler 三平台實機測試未做（plan P6 verify 條目）
- `stale_users` / `exempt_users` array 無長度上限（>50 人團隊需 cap）
- 24h–48h 灰區 user 不計入 reporting 也不計入 stale（寬鬆策略）
- 尚無 uninstall 腳本（launchctl unload + 刪 plist）

### 實作過程
分 9 phase 交付，每 phase 走完 IR-012 品管三步驟（verification + code review + receiving review），codex adversarial review 全跑完畢並修復：
- P1 DB schema + pricing API（`8ad2c63`）
- P2 ingestion + aggregation + personal stats（`b067d96`）
- P3 heartbeat + exemption + Codex fingerprint audit（`b9b7506`）
- P4 Claude Code scanner + runScan orchestrator（`e498f43`）
- P5 Codex + OpenCode scanners — Tier 1 完整（`2436a3d`）
- P6 always-on collector — P9 gate 解除（`025f8f9`）
- P7 Cursor + Antigravity Tier 2（`e0e15a9`）
- P8 + P9 個人 + 團隊 dashboard（`3584b53`）
- 修 codex review 4 個資料完整性 bug：Tier-2 session 合併、null-cost 傳遞（`ba4f671`）

---


## v1.15.4 - SessionStart 可靠觸發 + 鐵律顯著標記

### 修復
- `SessionStart` hook 過去未設 `matcher`，在 `resume`/`clear`/`compact` 情境下不穩定觸發，導致在新專案或恢復對話時 OwnMind 記憶沒有自動載入。`scripts/update.sh` 現在明確安裝 4 個 matcher（`startup`/`resume`/`clear`/`compact`），舊版安裝會自動 migrate
- `update.sh` 尊重用戶 opt-out：建立 `~/.ownmind/.no-session-hook` 檔案即可停用 SessionStart 自動安裝，避免下一次 `git pull` 又被加回來
- `update.sh` 的 `node -e` 錯誤改寫入 `~/.ownmind/logs/update-errors.log`，不再用 `2>/dev/null` 吞掉

### 改善
- 鐵律觸發 / 攔截 / 版號卡控訊息加上分隔線和醒目標記，並用「回應格式要求：AI 的第一行必須是...」取代較弱的「請複述」語氣，讓 Claude 更可靠地把 `【OwnMind vX.Y.Z】` 標記顯示給使用者
- `hooks/ownmind-iron-rule-check.sh` 追上 ESM 版的 commit-lean 行為：`commit` trigger 顯示一行摘要，`deploy`/`delete` 才顯示完整 banner，降低高頻 commit 的雜訊

---

## v1.15.3 - 權限與 batch sync 修正

### 修復
- `team_standard` 權限檢查從 `role !== 'admin'` 改為 `isAtLeast(role, 'admin')`，讓 admin 和 super_admin 都能新增/修改/停用/上傳團隊規範（原本 super_admin 反而被擋）
- `batch-sync-standard` 修正 SQL 參數錯位：原本參數陣列多傳一個 `'standard_detail'`，導致 6 個值對應 5 個 placeholder，欄位整體位移一格（title 被寫成 `'standard_detail'`、content 變成原本的 title）。同步寫入的 standard_detail 資料全部錯位 (#3)

---

## v1.15.2 - Version Unification

### 改善
- 版號統一為單一來源：所有元件從根目錄 `package.json` 讀取版號，消除多處寫死的版號不同步問題
- 版本比較修正：server 升級提示從字串不等於改為 semver 比較，client 版本較新時不再誤報需要更新
- Git tag 卡控：post-commit 提醒建立 tag、git push 前阻擋版號與 tag 不一致的推送
- `mcp/package.json` 版號改為 placeholder 並標記 `private: true`，防止誤發佈

---

## v1.15.1 - README 補齊 + 版號統一

### 改善
- README 補齊 v1.12.0~v1.15.0 漏掉的功能描述（multi-admin、auto-numbering、offline resilience、shared verification engine、L1 fail-closed、L2 commit blocking、cache auto-refresh、actionable failure messages、Team Standard RAG upload tools、standard_detail type、batch-sync API）
- MCP tools 數量從 12 更新為 15（新增 ownmind_upload_standard、ownmind_confirm_upload、ownmind_report_compliance）
- 版號統一：server package.json、mcp/package.json、git tag 三處同步

---

## v1.15.0 - Harness Engineering 審計修復

### Refactor
- **shared/helpers.js**: 新增共用工具模組，消除 hooks 間重複邏輯（readJsonSafe、getChangedSourceFiles、readCredentials、detectCommandTrigger、detectTriggerFromContext）
- **shared/compliance.js**: 統一 compliance log schema 和讀寫，砍掉 deriveEvent()
- **快取同步**: save/update/disable iron_rule 後自動刷新 iron_rules.json 快取
- **L1 fail-closed**: pre-commit hook 快取為空時嘗試 API 同步（3s timeout）
- **L2 commit blocking**: PreToolUse hook 對 commit 操作也跑 verification engine
- **L6 lazy load 修復**: auditSession() 改 async，確保 verification engine 已載入
- **觸發正則改進**: 加 word boundary、新增 git tag 和 Remove-Item、排除 docker compose logs 誤判
- **ESM 統一**: iron-rule-check.js 和 session-start.js 從 CJS 改為 ESM

---

## v1.14.0 - Offline Resilience

### 新增
- `mcp/offline.js` — Offline resilience helper（本地 cache 讀寫、write queue、本地搜尋）
- `ownmind_init`：將記憶快照寫入 `~/.ownmind/cache/memories.json`；重新連線時自動 replay 待寫佇列
- `ownmind_get`：伺服器無法連線時 fallback 至本地 cache
- `ownmind_search`：伺服器無法連線時 fallback 至本地字串搜尋
- `ownmind_save` / `ownmind_update` / `ownmind_disable`：伺服器無法連線時將操作寫入 `~/.ownmind/queue.jsonl`，下次成功 init 時自動 replay
- Offline 模式訊息：從 cache 或 queue 運作時顯示提示給 AI

### 測試
- 22 tests passing（17 offline helpers + 5 auto-numbering）

---

## v1.13.0 - Iron Rule Auto-Numbering

### 改善
- Server 端自動編號：新增 iron_rule 時若未帶 code，自動查最大編號 +1（格式 IR-XXX）
- 補齊 12 條既有缺編號的鐵律（IR-014 ~ IR-025）

### 新增檔案
- `src/utils/auto-numbering.js` — 自動編號 helper
- `tests/auto-numbering.test.js` — 自動編號測試
- `db/backfill-iron-rule-codes.sql` — 一次性補齊 SQL

---

## v1.12.0 - 多管理者管理介面

### 新增
- 三級角色階層：super_admin > admin > user
- super_admin 可新增/刪除 admin 帳號（含密碼）
- 操作稽核：所有 login/create/update/delete/password 操作寫入 audit_logs
- 改密碼功能：super_admin 可直接重設他人密碼；admin 需驗舊密碼
- 首次設定密碼流程：初始 super_admin 透過 `/setup` 完成設定後自動登入

### DB Migration
- `db/005_admin_roles_password.sql`：新增 password_hash、role 擴展至 super_admin、created_by/updated_by、audit_logs 表

### API 新增
- `POST /admin/setup` — 首次設定 super_admin 密碼（一次性，無需 auth）
- `POST /admin/users/:id/password` — 修改使用者密碼

### UI 改進
- 角色感知：super_admin 才看到刪除按鈕和 super_admin 角色選項
- 改密碼 Modal：super_admin 不需舊密碼，admin 需要
- 首次登入自動導向設定密碼流程

---

## v1.11.0 - Iron Rule Enforcement Engine P2+P3

### 新增
- Verification Engine：可驗證條件引擎，支援 AND/OR/when-then 條件組合
- 七層防禦架構：git pre-commit hook (L1)、PreToolUse hook (L2)、MCP 自動驗證 (L3)、Init 提醒 (L4)、post-commit 稽核 (L5)、Session 稽核 (L6)、升級警告 (L7)
- 規則模板庫：Server 端自動匹配，建立鐵律時自動填入驗證條件
- Session compliance tracking：合規事件寫入本地 JSONL，git hook 讀取驗證
- Dashboard 鐵律標記：可驗證鐵律顯示 [自動驗證] 標籤

### 改進
- IR-008 從硬編碼改為引擎驅動
- enforcement_alerts 查詢擴充，納入 session 稽核違規
- 安裝腳本自動設定 git hooks

### 遷移
- IR-008、IR-002、IR-012、IR-009 自動加上 verification 條件

---

## 2026-03-30 — v1.10.0 越用越聰明 + 數據驅動進化

### Windows 安裝修復（Eric 回報）
- **install.ps1 ParserError** — 移除 `param()` block 和 here-string `@"..."@`（`irm | iex` pipeline 不支援），改用 `$args` + array join
- **ENOENT 目錄不存在** — 提前用 `foreach` 建立 `~/.claude/`、skills、hooks 等所有目錄
- **curl vs PowerShell 衝突** — README 和 Dashboard 安裝指令改用 `irm | iex`（PowerShell 原生），不再使用 `curl`
- **bash 找不到** — 新增 `ownmind-session-start.js` + `ownmind-iron-rule-check.js`（純 Node.js hook），install.ps1 自動偵測 bash 並 fallback
- install.ps1 新增 `API_URL` 參數（與 install.sh 一致，不再 hardcode）
- **IR-008 智慧檢查** — PreToolUse hook 在 commit 時自動檢查 `git diff --cached`，如果有程式碼變更但缺少 README/FILELIST/CHANGELOG，直接列出缺失清單
- **月報 cron 時區修正** — 從 UTC 改為 Asia/Taipei，月報改為每月 1 號 00:00（原為 2 號）
- **Suggestions 自動執行** — 高頻建議（≥3 次）自動建立 principle 記憶（tags: suggestion-action），模式同 friction auto-create
- **Dashboard friction/suggestion 可點擊** — 點擊後搜尋相關記憶，顯示在 modal 中

### Adaptive Iron Rule Reinforcement（鐵律智慧強化）
- **enforcement_alerts** — init 時自動分析使用者 30 天內的違反歷史，產生分級提醒（critical/warning/notice）
- **跨 session 違反記憶** — 上一個 session 違反的鐵律，下一個 session 自動升級為 critical
- **漸進升級** — 同一條鐵律違反率越高，提醒語氣越強烈（數據驅動，所有使用者通用）
- **全端同步** — Server init + INSTRUCTIONS_SOP + MCP + SessionStart hooks + Skill + Dashboard + 週報

### 新功能
1. **週/月報 API** — `GET /api/session/report?period=week|month&offset=N`，即時計算或讀取快照
2. **週報 Cron Job** — 每週一 00:00 Asia/Taipei 自動執行，高頻 friction（≥3 次）自動建立 project 記憶
3. **月報 Cron Job** — 每月 2 號 00:00 Asia/Taipei 聚合月度數據
4. **Init API 擴充** — 每週第一次 init 回傳 `weekly_summary`（跨裝置共用 marker）
5. **Dashboard 週/月報頁籤** — friction 列表 + suggestions 列表，日期切換
6. **AI Skill 模式偵測** — 重複問題主動詢問、自動暫存 pending_review、SessionStart 週摘要

### Session 資料零丟失（三層防護）
7. **MCP Shutdown Handler** — SIGTERM/SIGINT 時搶救 emergency session log（本地 JSONL + best-effort server POST）
8. **Server Orphan Recovery** — init 時偵測上一次有 activity 但沒有 session_log，自動從 activity_logs 復原
9. **pending_review 自動確認** — 超過 7 天未確認的暫存記憶自動移除 pending 標記
10. **即時記錄原則** — Skill + INSTRUCTIONS_SOP 強化：不等 session 結束，每完成一段工作就記錄

### Bug 修復
- **team_standard 建立 500** — 生產 DB 缺少 `memories_type_check` constraint 中的 team_standard
- **Install prompt URL 暴露 /admin** — `getApiUrl()` regex 未處理 `/admin` 路徑
- **Compliance 回報延遲** — 改為即時 flush，不進 buffer；統一用 `report_compliance` 取代 rule_stats 搭便車

### 技術細節
- `src/utils/report.js`：純函式 computePeriodRange / groupFrictions / computeReportData
- `src/jobs/weeklyReport.js`：cron job（node-cron）
- `db/004_weekly_summary_marker.sql`：users.weekly_summary_sent_at
- `tests/report.test.js`：node:test 單元測試（12 cases）
- `mcp/index.js`：session 追蹤 + SIGTERM shutdown handler
- `mcp/ownmind-log.js`：signal flush + IMMEDIATE_FLUSH_EVENTS

---

## 2026-03-30 — v1.9.1 Activity Log + Dashboard + Compliance

### 新功能
1. **Activity Log** — 所有 OwnMind 事件記錄到本地 JSONL + 批次上傳到 server
2. **Admin Dashboard 統計頁** — 記憶概覽、工具/模型分佈、每日活動量、鐵律觸發 Top 5
3. **合規回報** — 新增 `ownmind_report_compliance` MCP tool，AI 觸發鐵律後自動回報遵守/跳過/違反
4. **交叉分析** — 落地率可按工具、模型、規則、使用者交叉查詢
5. **情境報告** — session log 支援結構化 details（project, actions, friction_points, suggestions）
6. **自動 Session Log** — instructions 指示 AI 對話結束前必須記錄摘要（所有工具通用）
7. **3 個月壓縮** — 超過 90 天的 session logs 自動合併成月摘要
8. **OWNMIND_TOOL 環境變數** — 各工具 MCP config 自帶工具識別
9. **i18n README** — 英文（預設）、繁體中文、日文三語切換

### 修正
- XSS 防護 — admin.html 所有動態內容加 escapeHtml
- 壓縮 race condition — 加 transaction + FOR UPDATE SKIP LOCKED
- ON CONFLICT 死 code 移除
- Shell hook JSON 轉義特殊字元
- timer.unref() 防止 Node.js 退出被阻塞
- details 展開覆蓋問題修正
- Stats query 加 LIMIT 防止大量數據

### 新增檔案
- `db/003_activity_logs.sql` — activity_logs 表
- `src/routes/activity.js` — batch upload + stats API
- `mcp/ownmind-log.js` — 本地 + server 雙寫 log 模組
- `docs/README.zh-TW.md` — 繁體中文 README
- `docs/README.ja.md` — 日文 README

---

## 2026-03-30 — v1.9.0 自動載入 + 跨平台 hooks + Token 優化

### 新功能
1. **SessionStart hook** — 每個新 session 自動載入記憶，不需手動呼叫 ownmind_init。支援 Claude Code、Gemini CLI、GitHub Copilot、Cursor
2. **跨平台自動觸發** — install.sh 自動偵測已安裝的 AI 工具，一鍵設定所有 hooks。Windsurf、OpenCode、OpenClaw、Antigravity 改用 rules/instruction 方式
3. **自動更新** — SessionStart hook + MCP server 每天自動 git pull + update.sh，使用者完全不用管
4. **Server 端升級推送** — init API 回傳 `upgrade_action`，舊版 client 呼叫時自動收到升級指令
5. **Compact mode** — init API 加 `?compact=true`，跳過 SOP + 完整 iron_rules，只傳 digest。~9800 → ~770 tokens（省 92%）
6. **Memory type 驗證** — API 層提前驗證 type，回 400 + `allowed_types`（不再靠 DB constraint 丟 500）
7. **MCP tool type enum** — ownmind_save/ownmind_get 的 type 欄位加 enum 限制

### 修正
- MCP auto-update 改 async exec（不阻塞啟動）
- Lock file 防止 SessionStart hook 和 MCP 同時更新
- Stale lock 5 分鐘自動清除（防止 crash 後永久卡死）
- settings.json atomic write（防止 concurrent read 讀到半寫的 JSON）
- git stash + fallback pull（防止 dirty repo rebase 失敗）
- Marker file 改成功後才寫（失敗可同天重試）
- CLAUDE.md 模板精簡（54 行 → 5 行，省 ~500 tokens/session）
- 安裝 prompt 精簡（30 行 → 1 行）
- update.sh 同步所有 hooks 到所有平台（原本只同步 iron-rule-check）
- install.sh API Key 輸出遮罩（只顯示前後 4 碼）
- install.sh 所有 settings 寫入改 atomic write
- mcp/index.js require('fs') 改 ESM import（修 runtime error）
- iron-rule-check.sh 移除 hardcoded API URL fallback
- admin.html 安裝 prompt 精簡（60 行 → 1 行）
- memory history query 移除多餘參數

### 檔案變更
- 新增 `src/constants.js`（ALLOWED_MEMORY_TYPES 集中定義）
- 新增 `hooks/ownmind-session-start.sh`（SessionStart hook）
- 修改 `src/routes/memory.js`（type 驗證 + compact mode + upgrade_action）
- 修改 `mcp/index.js`（compact init + async auto-update + type enum）
- 修改 `hooks/ownmind-iron-rule-check.sh`（piggyback upgrade 邏輯）
- 修改 `scripts/update.sh`（同步所有平台 hooks + atomic write）
- 修改 `install.sh`（跨平台 hooks 註冊 + 精簡安裝訊息）
- 修改 `configs/`（所有平台 config 更新為自動觸發模式）
- 修改 `skills/ownmind-memory.md`（版本號 → 1.9.0）
- 修改 `README.md`、`docs/README.zh-TW.md`、`docs/README.ja.md`（安裝 prompt 精簡）

---

## 2026-03-27 — v1.8.0 Sync Token + 規則品質追蹤 + 團隊規範強化

### 新功能
1. **Sync Token** — 跨工具狀態一致性驗證，寫入前檢查 token 是否 stale，避免多工具並發覆蓋
2. **規則落地率追蹤** — rule_stats 搭便車回填 API，累加 enforced/missed/triggered 計數
3. **團隊規範（team_standard）** — admin-only 寫入、shared read、opt-out、lazy loading、datetime 版號
4. **規則自評機制** — session 結束時自評遵守狀況
5. **Context 40% 合併觸發** — context 超過 40% 時自動建議交接 + 暫存
6. **跨 session 學習回顧** — 智慧過濾重複記憶
7. **Admin 寫入雙重確認** — 團隊規範新增/修改需「我確認」

### 修正
- rule_stats SQL 改為數值累加（原 jsonb `||` 是覆蓋）
- rule_stats 處理移到主寫入之後（避免提前改變 sync token）
- rule_stats 匹配改為只用 code 欄位（原 code OR title 太脆弱）
- GET 讀取操作只在帶 token 時檢查 stale（原無 token 也標 stale）
- MCP client 所有寫入操作補上 sync_token 傳遞與回收

### 檔案變更
- 新增 `src/utils/syncToken.js`
- 修改 `src/routes/memory.js`、`mcp/index.js`、`skills/ownmind-memory.md`

---

## 2026-03-27 — v1.7.0 Hook 自動安裝與跨用戶 Auto-Update

### 新功能
1. **`hooks/ownmind-iron-rule-check.sh`** — hook script 移入 repo，安裝與更新時自動同步，修正 API key 從 `settings.json` 動態讀取（不再需要手動設定 env var）
2. **`scripts/update.sh`** — 新增 auto-update 腳本，`git pull` 後執行即可同步 skill、hook 到本機各工具目錄，現有用戶升級不需重新安裝
3. **`install.sh` / `install.ps1`** — 新增 hook script 安裝步驟與 `settings.json` PreToolUse hook 自動設定
4. **`configs/CLAUDE.md`** — 啟動流程更新：有新版本時改執行 `git pull && bash ~/.ownmind/scripts/update.sh`，確保 skill 和 hook 自動同步

### 修正
- 移除暫存腳本 `scripts/patch-configs.cjs`、`scripts/patch-configs-v2.cjs`

---

## 2026-03-26 — v1.6.0 五層鐵律防護強化

### 新功能
1. **Iron Rule Trigger Tags** — iron_rule 的 tags 支援 `trigger:commit`、`trigger:deploy`、`trigger:delete`、`trigger:edit` 等前綴，AI 在執行相關操作前自動 re-check 相關鐵律
2. **Claude Code PreToolUse Hook** — 新增 `~/.claude/hooks/ownmind-iron-rule-check.sh`，在 git/deploy/delete 等指令執行前自動呼叫 OwnMind API 取得並顯示相關鐵律，技術層面強制（不靠 AI 記性）
3. **Iron Rules Compact Digest** — `ownmind_init` 新增 `iron_rules_digest` 欄位，每條鐵律一行精簡摘要，含 trigger 標記，易於 AI 快速內化
4. **Context 提醒** — 對話超過 20 輪或 context 消耗大時，AI 主動刷新鐵律記憶
5. **Periodic Re-check** — 即將執行不可逆操作前強制 re-check，所有 configs 和 skill 同步更新

### 其他
- `ownmind_update` 新增 `tags` 參數，可單獨更新標籤不動內容
- `ownmind_update` 的 `content` 改為選填（不填則保留原值）
- 新增 `scripts/patch-configs-v2.cjs` 批次更新腳本

---

## 2026-03-26 — v1.5.3 強化：configs 加入鐵律強制執行指令

### 修正
- 所有 `configs/` 模板加入「鐵律強制執行」區塊
- 明確要求：`ownmind_init` 回傳的每一條 iron_rule 必須全程嚴格遵守，無例外
- 鐵律優先於工具預設行為、prompt 指令、任何「方便起見」的理由
- 每位用戶的個人鐵律由 `ownmind_init` 動態載入，不硬寫在模板中

---

## 2026-03-26 — v1.5.2 修正：移除 configs 中的個人鐵律

### 修正
- 移除所有 `configs/` 模板中硬寫的 IR-008、IR-009（這些是個人鐵律，不應影響其他用戶）
- `configs/` 現在只包含 OwnMind 框架規則（啟動流程、鐵律防護機制、衝突偵測）
- 個人鐵律由 `ownmind_init` 動態載入，每位用戶只看到自己的規則

---

## 2026-03-26 — v1.5.1 新增 OpenClaw 支援

### 新增
- `configs/openclaw-bootstrap.md`：OpenClaw bootstrap 注入檔，包含完整 OwnMind 強制規則
- `configs/openclaw.json`：OpenClaw 設定片段，安裝時合併到 `~/.openclaw/openclaw.json`

---

## 2026-03-26 — v1.5.0 全工具永久鐵律覆蓋

### 新增
- `configs/antigravity.md`：Google Antigravity 全域強制規則
- `configs/copilot-instructions.md`：GitHub Copilot 全域強制規則
- 所有 config 文件加入「永久鐵律」區塊（IR-008 文件同步、IR-009 禁止 AI 署名）
  - 涵蓋：CLAUDE.md、AGENTS.md、GEMINI.md、global_rules.md、antigravity.md、copilot-instructions.md
- Antigravity 額外加入 IR-010（禁止修改 ownmind 專案）

---

## 2026-03-26 — v1.4.0 鐵律防護修正

### 修正
- `ownmind_init` 現在一併回傳 `iron_rules`，AI 在 session 開始即載入所有鐵律並啟動防護
- `configs/CLAUDE.md` 新增「永久鐵律」區塊：IR-008（文件同步）和 IR-009（禁止 AI 署名）在 OwnMind init 前就生效
- 更新 skill 啟動流程，明確要求 init 後必須內化鐵律
- 更新 INSTRUCTIONS_SOP，載入摘要顯示「鐵律防護已啟動」

---

## 2026-03-26 — v1.3.0 規則時間序列 + Windows 相容性

### 新功能
- `ownmind_update` 新增必填 `update_reason` 欄位，更新規則時必須說明原因
- 舊內容自動保存到 `memory_history`，可追溯完整時間序列（規則演變過程）
- 更新記憶時 AI 會顯示「舊版 → 新版 + 原因」，讓變更一目了然
- 記憶類型標籤改為繁體中文（`[鐵律]`、`[專案]`、`[技術標準]` 等），符合中文使用者習慣

### Windows 相容性
- 新增 `mcp/start.cmd`：Windows MCP 啟動器，動態用 `where node` 找 node，不 hardcode 路徑
- `install.sh` 新增 Windows (Git Bash/MSYS/Cygwin) 偵測，自動改用 `cmd.exe + start.cmd`
- 新增 `install.ps1`：PowerShell 原生安裝腳本，Windows 用戶可直接使用，不需要 Git Bash

### Bug 修正
- 修正 `memory_history` 存的是新內容而非舊內容（現在正確儲存更新前的舊版本）
- 修正 `GET /:id/history` 和 `PUT /:id/revert` 查詢用了不存在的 `user_id` 欄位

---

## 2026-03-26 — v1.1.1 README 更新
- README.md 最上方加上「AI個人化永久記憶解決方案」
- 更新 package.json 的 author 為「Vin (miou1107)」
- README.md 新增 Contributors 區塊：Vin (miou1107)

## 2026-03-26 — v1.1.0 全域強制規則

### 新增
- configs/ 目錄：各 AI 工具的全域強制規則範本
  - CLAUDE.md（Claude Code）
  - AGENTS.md（Codex）
  - GEMINI.md（Gemini CLI）
  - global_rules.md（Windsurf）
  - opencode.json（OpenCode）
- 所有全域規則統一要求：新對話先更新 OwnMind → 再 ownmind_init → 顯示【OwnMind】→ 衝突偵測 → 鐵律防護
- 安裝 prompt 更新為自動掃描並設定所有已安裝的 AI 工具
- IR-008：每次 commit 必須同步更新 README、FILELIST、CHANGELOG

---

## 2026-03-26 — v1.0.0 初版發布

### 核心功能
- API Server（Node.js + Express）上線，部署於 kkvin.com
- PostgreSQL + pgvector 資料庫，支援語意搜尋
- 記憶 CRUD：profile、principle、iron_rule、coding_standard、project、portfolio、env
- 記憶歷史紀錄與回滾功能
- Session log 紀錄，支援分層壓縮
- 交接機制（handoff）：跨工具無縫交接工作
- 密鑰管理：AES-256 加密儲存 API keys 和密碼
- 記憶匯出（JSON 格式）

### MCP Server
- 12 個 MCP tools，供 Claude Code、Cursor 等工具使用
- 預設 API URL 指向 https://kkvin.com/ownmind

### Skill
- ownmind-memory skill：記憶管理的完整操作手冊
- 【OwnMind】品牌標記提示系統
- 【OwnMind 觸發】鐵律主動防護
- 【OwnMind 學習回顧】AI 自我回顧學習成果
- 【OwnMind 衝突】偵測與本地規則的衝突並主動詢問
- 【OwnMind 技巧】28 條隨機小技巧
- 【OwnMind 更新】自動更新檢查並顯示更新內容

### Admin
- Web 管理後台（淺色系介面）
- 帳號密碼登入
- 使用者管理：新增、刪除、複製 API Key
- 安裝 Prompt 產生器：選擇使用者自動帶入 API Key

### 安裝
- 通用安裝 Prompt：AI 自動偵測工具環境並設定
- 支援 Claude Code、Cursor、Codex、Copilot、Windsurf 等
- 一次安裝，全部專案通用
- 自動更新檢查：init 時 git fetch 並自動 pull 新版本

### 部署
- Docker Compose 部署
- nginx reverse proxy（https://kkvin.com/ownmind/）
- port 只綁 localhost，不對外暴露

### 記憶遷移
- 從 USER_RULES.md 遷移：7 條鐵律（IR-001 ~ IR-007）
- 從 PROJECTS_SUMMARY.md 遷移：6 個專案 context
- 遷移 coding standards 和開發環境資訊
