# v1.19.8 — 首次安裝 Setup Wizard 提案

## 背景：chicken-and-egg 問題

OwnMind v1.19.7 之前、新使用者首次部署伺服器後遇到鎖死：

1. `db/001_init.sql` 只建 schema、不 seed 任何帳號
2. 想用 admin UI → `/admin/login` 找不到 super_admin 紀錄、回「帳號或密碼錯誤」
3. 想用 `/admin/setup` endpoint 救援 → 必須先做兩件事：
   - 設環境變數 `SETUP_TOKEN` 重啟 server
   - 手動 SQL INSERT 一筆 `password_hash IS NULL` 的 super_admin 紀錄
4. 想用 client install.sh → 必須先有 API key、但 API key 只能由已存在的 super_admin 在後台建 user 後產生

**結果**：新使用者部署完 server、開瀏覽器到 admin UI、卡住、平均花 30 分鐘以上才搞清楚救援路徑。極差的 onboarding 體驗、嚴重阻擋產品推廣。

## 已被排除的方案

走過完整的設計討論（v1.19.7 README 改寫期間 Codex Rescue 評估）、以下方案不採用：

- **A. 自動 seed 隨機 super_admin**：密碼寫到 log/檔案、log 外洩就拿到 super_admin。「使用者不知道去哪找密碼」也是 UX 問題
- **D. DEV_MODE 預設 admin/admin**：生產環境誤帶 `OWNMIND_DEV_MODE=1` 啟動就完蛋、保護機制比 wizard 還複雜

## 採用的方案：Setup Wizard 網頁

### 核心邏輯

1. **新增 first-run 偵測 middleware**：每個 `/admin/*` 請求進入前先查 `SELECT COUNT(*) FROM users WHERE role IN ('admin', 'super_admin')`
2. **count = 0 時、自動 redirect 到 `/setup`** — 使用者開 admin UI 自動進 wizard、零文件閱讀成本
3. **`/setup` 是純 HTML 頁面** — 表單收 email + 密碼 + 密碼確認
4. **`POST /api/setup/init` endpoint**：
   - 內部 double-check users 表為空（防 race condition）
   - 建立第一個 super_admin（hash 密碼、自動產 api_key UUID）
   - 寫 audit log（actor_user_id 用 system_user_id）
   - 回傳新建的 api_key 讓使用者複製去 client install.sh 用
5. **建好後 endpoint 自動失效** — 因為 first-run 偵測會回 false、再次 POST 一律 403

### 跟既有 SETUP_TOKEN 並存策略

既有 `/admin/setup` endpoint 不刪除、但定位改為「緊急救援通道」：

- **users 表為空** → 新 setup wizard 走（不需 SETUP_TOKEN、零摩擦）
- **users 表有 super_admin 但 password_hash IS NULL**（從外部匯入帳號的場景） → 舊 `/admin/setup` 走、仍需 SETUP_TOKEN
- **users 表有 super_admin 且密碼已設、但管理員忘記密碼** → 走 SQL 手動重置 + 舊 setup token 路徑

README 跟 FAQ 把舊路徑的說明降級成「進階／救援」段、首推 wizard。

## 安全性考量

| 風險 | 防護機制 |
|---|---|
| Race condition（兩個請求同時看到 first_run=true） | DB transaction + `SELECT ... FOR UPDATE` 或先寫入 + 後檢查 + 失敗 rollback |
| Wizard endpoint 永久開放被誤用 | 嚴格 first-run check、users 表一旦有 admin 就 403 永久關閉 |
| 密碼太弱 | 強制最短 8 字、未來可加複雜度檢查（不在 v1.19.8 範圍） |
| /setup 頁被搜尋引擎爬 | 加 `<meta name="robots" content="noindex">` |
| Rate limit | 用既有 rate limit middleware（如 src/middleware/auth-rate-limit.js）覆蓋 |
| HTTPS | 沿用既有設定、不另做。建議部署文件提醒先掛 HTTPS 再做 setup |

## 不做的事

- ❌ 不刪除既有 `/admin/setup` + `SETUP_TOKEN`（向後相容）
- ❌ 不做密碼強度驗證升級（保持 8 字最小、複雜度留未來）
- ❌ 不做多管理員建立流程（wizard 只建第一個 super_admin、其他人去後台建）
- ❌ 不做 OAuth / SSO（這是 v1.21+ 範圍）
- ❌ 不做 reset password 流程（v1.20+ 再規劃、忘記密碼仍走 SQL 手動）
- ❌ 不改 install.sh 互動模式（Codex 評估的方案 C 留 v1.19.9 做）

## 工作量估計

| 項目 | 行數估計 |
|---|---|
| `src/routes/setup.js` | 80-120 |
| `src/middleware/first-run-redirect.js` | 30-50 |
| `src/public/setup.html` | 120-180 |
| `src/index.js` 掛載 | 5-10 |
| `tests/setup-wizard.test.js` | 200-300（8-12 case） |
| openspec change | 約 300 行 markdown |
| CHANGELOG / FILELIST / README | 約 100 行 |
| **總計** | 約 1000 行（一半是測試 + 文件） |

實際工程約 3-5 小時可完成（含 review fix）。

## 風險檢查點

- [ ] 建好第一個 admin 後、立刻試一次 `/api/setup/init`、確認回 403
- [ ] 用空 DB 跑端到端：開 browser 到 `/admin` → 應該被 redirect 到 `/setup`
- [ ] race condition 測試：concurrent 兩個 init 請求、只有一個能成功
- [ ] 既有 `/admin/setup` + `SETUP_TOKEN` 路徑仍可正常運作（不破壞既有部署）
