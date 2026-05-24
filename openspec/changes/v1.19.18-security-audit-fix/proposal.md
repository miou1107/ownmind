# v1.19.18 — 修補三個中度安全漏洞（npm audit fix）

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: 動工中
- **預估版次**: v1.19.18（hotfix-class patch、純依賴升級）
- **對應 GitHub issue**: [#43](https://github.com/miou1107/ownmind/issues/43)

---

## 0. 一句話總結

跑 `npm audit fix` 升級三個有中度安全漏洞的相依套件（`ip-address`、`qs`、`express-rate-limit`）、跑全套測試確認沒回歸、發版部署。

---

## 1. 設計緣由

### 1.1 Antigravity Code Review 抓到的漏洞

在 Antigravity 環境跑 `npm audit`、發現 3 個中度（moderate）漏洞：

| 套件 | 現版 | 漏洞 | 來源 |
|---|---|---|---|
| `ip-address` | <=10.1.0 | XSS 跨站攻擊（Address6 HTML-emitting methods） | [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) |
| `qs` | 6.11.1-6.15.1 | DoS 阻斷服務（`encodeValuesOnly` 開啟時、`qs.stringify` 對 null/undefined 會炸 TypeError） | [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) |
| `express-rate-limit` | 8.0.1-8.5.0 | 間接依賴：用了有漏洞版本的 `ip-address` | — |

### 1.2 為什麼這三個漏洞要修

**`qs` DoS（阻斷服務）**：被遠端觸發。Express 5 內建用 `qs` 解析查詢字串（URL 後面 `?key=value` 那段）、有心人可以丟特殊組合的請求讓伺服器丟 TypeError、導致回應出問題。**直接面向公開網際網路的 OwnMind 伺服器有實際風險。**

**`ip-address` XSS（跨站攻擊）**：只在用 `Address6` 物件的 `.toString()` 等 HTML 輸出方法時觸發。`express-rate-limit` 用 `ip-address` 是來判斷 IPv6 位址範圍、沒走 HTML 輸出路徑、實際被利用機率低。但既然有 fix、一併升掉。

**`express-rate-limit`**：自己沒漏洞、是因為依賴 `ip-address` 連帶要升。

### 1.3 為什麼選 npm audit fix（不手動升每個套件）

- `npm audit fix` 只升 minor / patch、不會自動升 major（不會引入 breaking change）
- dry-run 預覽：三個套件都只升 minor（`qs` 6.15.0→6.15.2、`ip-address` 10.1.0→10.2.0、`express-rate-limit` 8.3.2→8.5.2）
- 全套既有測試（上次 1825 個）會把關沒回歸

---

## 2. 設計範圍

### 2.1 範圍內

- 跑 `npm audit fix`、讓 npm 自動處理三個套件的升級
- 跑全套 `node --test`、確認沒有回歸（regression、即「原本能跑的東西現在壞了」）
- 跑 `npm audit` 確認 0 漏洞
- 版號 1.19.17 → 1.19.18（純安全修補、走 patch 級）
- 更新 CHANGELOG.md / FILELIST.md / 三語系 README
- 部署到 kkvin.com 並瀏覽器實測

### 2.2 範圍外

- ❌ 升 major 版本套件（會自動跳過）
- ❌ 新增任何功能或行為
- ❌ 改任何業務邏輯程式碼
- ❌ 寫 spec.md（純依賴升級、沒有新行為要定義 GIVEN/WHEN/THEN）

---

## 3. 工作量

| 項目 | 行數 |
|---|---|
| `npm audit fix`（產出 `package.json` + `package-lock.json` 的 diff） | 自動產生 |
| 版號 + CHANGELOG + FILELIST + 三語系 README | 50 |
| **總計** | 約 50 行人工 + 自動 lockfile diff |

工程時間：約 15-30 分鐘（含部署 + 驗證）。

---

## 4. 風險檢查點

- [ ] `npm audit fix` 跑完、`npm audit` 回 0 漏洞
- [ ] `node --test` 全綠（1825 個或更多）
- [ ] `express-rate-limit` 升級後既有 rate-limit 設定還能用（重啟伺服器看 log 沒爆）
- [ ] `qs` 升級後查詢字串解析正常（POST /api/bug-reports 等端點可正常運作）
- [ ] 部署後 https://kkvin.com/ownmind/admin/ 可正常登入
- [ ] 部署後 https://kkvin.com/ownmind/api/clients/version 回 v1.19.18
- [ ] 三語系版號 1.19.18

---

## 5. 升級後續

- 關 GitHub issue #43
- 把本資料夾搬到 `openspec/changes/archive/`
- 客戶端 `~/.ownmind` 需不需要升？**不需要**——本版只升伺服器端的依賴、不改 MCP 工具、不改客戶端腳本。
