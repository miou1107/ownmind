# v1.19.9 — 忘記密碼救援任務清單

## v1.19.9 範圍

### 方案 3：後台他人重設密碼
- [ ] 新增 `POST /api/admin/users/:id/reset-password`（src/routes/admin.js）
- [ ] 寫 helper 產 12 字隨機臨時密碼（避開混淆字）
- [ ] 寫 tests/admin-reset-password.test.js（場景 1-7、約 10 case）

### 方案 2：CLI 救援腳本
- [ ] 寫 `scripts/reset-admin-password.js`
- [ ] 列出 super_admin / 互動式選擇 / 雙重確認 / 寫 audit log
- [ ] 寫 tests/cli-reset-script.test.js（用 mock db、模擬 stdin、場景 9-12）

### 方案 1：UI 強制引導
- [ ] 改 src/public/setup.html 成功頁加警告框（場景 13）
- [ ] 改 src/public/index.html 加單 admin banner（場景 14、15）
- [ ] 提供 GET /api/admin/health 或在登入回應加 single_admin_warning 旗標

### 文件 + 同步
- [ ] package.json 1.19.8 → 1.19.9
- [ ] CHANGELOG 加 v1.19.9 段
- [ ] FILELIST 加新檔
- [ ] 三語系 README FAQ「忘記密碼怎麼辦」新加一條（位置在「首次安裝」段下方）
- [ ] npm test 全套綠
- [ ] 走 superpowers:requesting-code-review

## 風險檢查點

- [ ] 跑端到端：建 A、B 兩個 admin、A 重設 B 密碼、B 用臨時密碼登入並強制改
- [ ] 跑端到端：CLI 腳本對單一 super_admin 重設、走 SETUP_TOKEN 重新設密碼
- [ ] admin 不能重設其他 admin（403）
- [ ] reset-password endpoint 不能改自己（400）
- [ ] audit log 三個動作（reset_password_by_admin / cli_reset_password / setup_password）都正確
- [ ] 既有 /admin/setup + SETUP_TOKEN 路徑不破壞
- [ ] CLI 腳本 DB 連不上時不會誤改任何 user

## 非任務（明確不做）

- ❌ Email 重設流程（依賴 SMTP、留 v1.20+）
- ❌ Recovery code（一次性救援碼）
- ❌ 2FA / TOTP
- ❌ 自助式「忘記密碼」網頁

## 完成定義

1. 任一 admin 忘記密碼、5 分鐘內可被另一 admin 救回（場景 1-2）
2. 唯一 admin 忘記密碼、可透過 CLI 腳本 + SETUP_TOKEN 救回
3. 單 admin 狀態下、後台明顯提示建立第二位
4. `npm test` 1622+ 全綠（含新加測試）
5. 通過 code review
