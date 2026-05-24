# v1.20.0 — 前端基礎建設任務清單

> scope 鎖定「基礎建設」、實際功能頁面在 v1.20.1+ 補。

## 階段 1 — 前端 build pipeline 設定（已完成）

- [x] `client/package.json`、`client/vite.config.js`、`client/index.html`、`client/.gitignore`
- [x] `client/src/main.jsx`、`client/src/App.jsx`、`client/src/index.css`、`client/src/design-tokens/colors.js`
- [x] 主倉庫 `package.json` 加 build:client / dev:client / translate:client
- [x] `Dockerfile` 改 multi-stage build
- [x] `.dockerignore` 新建
- [x] `.gitignore` 加前端產物排除
- [x] `src/app.js` 新增 /dashboard 路由 + SPA fallback（保留 /admin /me 不動）
- [x] `.claude/launch.json` 加 Vite dev server entry
- [x] `npm install` 在 client/：85 套件、0 漏洞
- [x] `vite build`：212ms、產出 235KB JS（gzip 75KB）
- [x] preview server localhost:5173 渲染成功、console 零錯誤
- [x] `install.sh` / `install.ps1` 加「執行 `npm run build:client`」步驟 — **判定不適用、跳過**：這兩個腳本是 user 端 client（~/.ownmind/）安裝腳本、跟 server 端 dashboard 編譯無關（Docker multi-stage 自動處理）

## 階段 2 — i18n 翻譯腳本 + 中英混雜 lint（本 turn 完工）

- [x] `client/src/i18n/` 完整結構（index.js / zh.json / en.json / ja.json / glossary.json / override / README）
- [ ] `translate.mjs` 接 Anthropic Claude Haiku API（temperature=0、prompt 帶 glossary）
- [ ] `translate.mjs` manual fallback 模式（無 API key 時提示人工翻）
- [ ] `.translate-cache.json` hash 比對避免重翻
- [ ] 第一次跑 translate、翻完 zh.json 30 個 key、commit en.json / ja.json
- [ ] 寫 `scripts/lint-zh-only.js`、加入 `npm test`
- [ ] 跑 lint 確認 0 fail

## 階段 3 — 文件 + 升版 + 發版

### 文件
- [ ] CHANGELOG.md 加 v1.20.0 段
- [ ] FILELIST.md 加 client/ 結構
- [ ] 三語系 README 版號更新

### 升版
- [ ] `package.json` 1.19.20 → 1.20.0
- [ ] grep SERVER_VERSION 同步
- [ ] commit（contributor=Vin、不加 Co-Authored-By）
- [ ] tag v1.20.0
- [ ] push origin main + push tag

### 部署 kkvin.com
- [ ] ssh kkvin.com、git pull、跑 migration、docker compose build --no-cache、up -d
- [ ] 瀏覽器實測舊版 /admin/ /me/ 仍正常（並存驗證）
- [ ] 瀏覽器實測新版 /dashboard/ 可訪問
- [ ] `curl /api/clients/version` 回 1.20.0

### 品管
- [ ] superpowers:verification-before-completion
- [ ] superpowers:requesting-code-review、處理回饋

## 階段 4 — 收尾

- [ ] GitHub issue #44 留言「v1.20.0 完成、v1.20.1~4 接續」
- [ ] `git mv` 本資料夾到 archive/
- [ ] ownmind 記憶寫入 v1.20.0 release 紀錄

## 非任務（明確 v1.20.0 不做）

- ❌ Portal / Preference / Admin / Super 頁面實際內容（v1.20.1+）
- ❌ 後端 API 對接（v1.20.1+）
- ❌ 元件拆分（v1.20.1+）
- ❌ 舊版退役（v1.20.4）
