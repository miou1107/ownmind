# v1.20.4 — 舊版 /admin/ 與 /me/ 退役（藍綠切換）

- **Status**: stub（待 v1.20.3 release + 2 週觀察期後展開）
- **依賴**: v1.20.0~v1.20.3 全部 release + Vin 拍板「可退役」

## 一句話總結

把藍綠並存了一段時間的舊 `/admin/` 跟 `/me/` 路由 301 轉址到新 `/dashboard/`、舊靜態檔搬到 legacy 資料夾保留歷史快照、新版頁尾的「⚠️ 看舊版」連結拿掉。

## 退役前必過 checklist
- [ ] 新版 `/dashboard/` 上線運作 2 週、零重大 bug
- [ ] Vin（Super Admin）每日用 `/dashboard/` 半天無感
- [ ] 舊版功能在新版都對得上（逐項對照表打勾、含三角色 + 三語系 + 響應式）
- [ ] 跨 3 種瀏覽器 + 行動裝置實測
- [ ] Vin 明確拍板「可退役」

## 退役動作
- [ ] `src/app.js` 改：`/admin/` 跟 `/me/` 改為 `res.redirect(301, '/dashboard/')`
- [ ] `src/public/index.html` → `src/public/legacy-admin-v1.html`（檔頭加註解）
- [ ] `src/public/me/` → `src/public/legacy-me-v1/`（同上）
- [ ] 新版頁尾「⚠️ 看舊版」連結拿掉
- [ ] CHANGELOG / FILELIST 同步
- [ ] 關 GitHub issue #44（整個 v1.20 系列收尾）
