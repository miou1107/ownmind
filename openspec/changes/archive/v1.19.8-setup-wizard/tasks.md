# v1.19.8 — Setup Wizard 任務清單

## v1.19.8 範圍

- [ ] 寫 `src/middleware/first-run-redirect.js` — 偵測 first_run、redirect `/admin/*` → `/setup`
- [ ] 寫 `src/routes/setup.js` — `GET /api/setup/status` + `POST /api/setup/init`
- [ ] 寫 `src/public/setup.html` — wizard UI（表單 + 結果頁）
- [ ] 改 `src/index.js` — mount setup route + middleware（順序：first-run middleware 要在 /admin 路由之前）
- [ ] 寫 `tests/setup-wizard.test.js` — 16 個場景測試
- [ ] 同步 package.json 版號 1.19.7 → 1.19.8
- [ ] CHANGELOG 加 v1.19.8 段
- [ ] FILELIST 加新檔
- [ ] 三語系 README FAQ「首次安裝」段改寫：首推 wizard、SETUP_TOKEN 降級為「進階／救援」

## 風險檢查點

- [ ] 跑端到端：空 DB → 開瀏覽器到 `/admin` → 確認 redirect 到 `/setup`
- [ ] 跑端到端：填表單 → 收到 api_key → 用該 key 登入 `/admin/login` 成功
- [ ] race condition：併發 2 個 init 請求、只有一個成功（手動跑或 test 模擬）
- [ ] 既有 `/admin/setup` + SETUP_TOKEN 路徑不被破壞（跑舊 setup test 看是否仍綠）
- [ ] `npm test` 全套綠
- [ ] 通過 `superpowers:requesting-code-review`

## 非任務（明確不做）

- ❌ 刪除既有 `/admin/setup` + `SETUP_TOKEN`（向後相容）
- ❌ 密碼強度驗證升級（複雜度檢查留未來）
- ❌ 多管理員建立流程（wizard 只建第一個 super_admin）
- ❌ OAuth / SSO 整合（v1.21+ 範圍）
- ❌ Reset password 流程（v1.20+ 再規劃）
- ❌ install.sh 互動模式（留 v1.19.9）

## 完成定義（Definition of Done）

1. 新部署的 server（空 DB）、使用者 5 分鐘內可登入 admin UI
2. 既有 v1.19.7 部署升上來、不破壞 SETUP_TOKEN 路徑
3. `npm test` 1595+ 全綠（含新加 setup wizard 測試）
4. CHANGELOG / FILELIST / 三語系 README 同步
