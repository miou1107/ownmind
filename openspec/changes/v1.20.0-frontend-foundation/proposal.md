# v1.20.0 — 前端基礎建設（藍綠並存的「藍」打地基）

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: 動工中
- **預估版次**: v1.20.0
- **對應 GitHub issue**: [#44](https://github.com/miou1107/ownmind/issues/44)（系列起點）
- **設計稿來源**: Gemini Antigravity 高保真原型（`/Users/vincentkao/.gemini/antigravity/scratch/ownmind-new-ui`）— 僅作 UX／視覺設計參考、不入倉、不照搬程式碼

---

## 0. 一句話總結

在主倉庫建 `client/` 目錄、設定編譯打包流程、做出可訪問但只顯示「重構中」空殼的 `/dashboard/` 路由、為後續 v1.20.1~4 的功能 release 建好地基。**舊 `/admin/` 跟 `/me/` 完全不動**。

---

## 1. 設計緣由

### 1.1 v1.20 系列的版控策略（Vin 2026-05-24 拍板）

v1.20 是「後台前端整套重構」的大主題、依路線 3 拆成 5 個 patch release：

| 版本 | scope |
|---|---|
| **v1.20.0**（本提案）| 基礎建設（client + build + i18n 機制 + 中英混雜 lint）|
| v1.20.1 | dashboard 個人版（Portal 4 頁 + Preference 3 頁 + API 對接） |
| v1.20.2 | dashboard 管理員版（Team + Bugs） |
| v1.20.3 | dashboard 超管版（Config + Broadcast + Audit） |
| v1.20.4 | 舊 `/admin/` + `/me/` 退役（藍綠切換） |

### 1.2 為什麼 v1.20.0 純做基礎建設

- **立刻可發**：基礎建設零破壞性、舊版完全不動、今天就可走品管三步驟發版
- **建好地基後續才好施工**：i18n 機制 + 中英混雜 lint 是後續每個 release 都要用的工具、先建好
- **避免「v1.20.0 永遠發不了」**：scope 鎖定基礎建設、不被功能蔓延

### 1.3 三條核心設計原則（最高約束、貫穿整個 v1.20 系列）

來自 Vin 2026-05-24 動工前明確下達：

1. **純白話中文、零中英混雜**（CI lint 強制）
2. **保留 Gemini 原型的風格、文案、UX 巧思**（重寫、不照搬程式碼）
3. **可長期維護、不 hardcode、不疊床架屋**（元件拆分 + 前端路由 + i18n 自動翻譯 + Context 拆狀態 + 統一 API client + 設計 token）

詳見 OwnMind 記憶 id=481。

---

## 2. 本提案範圍（v1.20.0）

### 2.1 範圍內

#### 前端編譯打包基礎建設
- `client/` 目錄：React 19 + Vite 8 + Tailwind v4 + Recharts + Lucide + react-router-dom
- `client/vite.config.js`：base 用相對路徑 `./`、輸出到 `../src/public/dashboard/`
- `client/src/main.jsx`：BrowserRouter 自動偵測 basename
- `client/src/App.jsx`：路由骨架 + 三角色守衛預留位
- `client/src/index.css`：Tailwind v4 @theme 北歐色票
- `client/src/design-tokens/colors.js`：JS 端設計 token

#### i18n 機制（路線 C：編譯時自動翻譯）
- `client/src/i18n/`：`index.js` + `zh.json` 唯一真實來源 + `en.json` / `ja.json` 編譯產出 + `glossary.json` 術語表 + `*.override.json` 人工覆寫 + `README.md`
- `client/src/scripts/translate.mjs`：增量翻譯腳本（接 Anthropic Claude Haiku、temperature=0、prompt 帶 glossary）
- 第一次跑、翻完 zh.json 30 個起手 key、commit en.json / ja.json
- `scripts/lint-zh-only.js`：中英混雜 lint、加入 `npm test` pipeline

#### 主倉庫整合
- `package.json`：加 `build:client` / `dev:client` / `translate:client` script
- `Dockerfile`：multi-stage build、stage 1 編譯前端 → stage 2 COPY 進 `./src/public/dashboard/`
- `.dockerignore`：新建
- `.gitignore`：加 `client/node_modules` / `client/dist` / `src/public/dashboard/`
- `install.sh` / `install.ps1`：加「執行 `npm run build:client`」步驟
- `src/app.js`：新增 `/dashboard` 路由 + SPA fallback（**保留舊 /admin 跟 /me 不動**）

#### 文件與發版
- 三語系 README + CHANGELOG + FILELIST 同步
- 版號 1.19.20 → 1.20.0（三處同步）
- 部署 kkvin.com + 瀏覽器實測

### 2.2 範圍外（給 v1.20.1+ 處理）

- ❌ Portal 4 頁實際內容（v1.20.1）
- ❌ Preference 3 頁實際內容（v1.20.1）
- ❌ Admin 頁面（v1.20.2）
- ❌ Super 頁面（v1.20.3）
- ❌ 後端 API 對接（v1.20.1+ 逐步補）
- ❌ 元件拆分（dashboard 內部結構在 v1.20.1+ 補）
- ❌ 舊版退役（v1.20.4）

---

## 3. 工作量

| 項目 | 預估 |
|---|---|
| client/ 目錄結構與設定 | 已完成 |
| i18n 翻譯腳本 + lint | 半天 |
| 文件 + 升版 + 部署 + 實測 | 半天 |
| **總計** | **約 1 個工作天** |

---

## 4. 風險與檢查點

### 風險
1. **multi-stage Dockerfile build 時間**：stage 1 編譯前端會多花 ~30 秒、prod build 時間可接受
2. **translate.mjs 第一次跑需要 LLM API key**：若無 key 自動退回 manual 模式、提示人工貼進 Claude Code 翻
3. **react-router fallback 在 nginx prefix 環境**：base 用相對路徑 `./` 應該已處理、實測驗證

### 部署前必過 checklist
- [ ] 中英混雜 lint 0 fail
- [ ] `vite build` 產出 dist 並 serve 成功
- [ ] localhost:5173 渲染成功、console 零錯誤
- [ ] `npm audit` 0 漏洞
- [ ] 既有 1827+ 測試全綠
- [ ] 三語系 README 版號同步 v1.20.0
- [ ] db/ migration 跑完
- [ ] Dockerfile COPY 路徑正確

---

## 5. 升級後續

- 關 GitHub issue #44 留言「v1.20.0 基礎建設完成、後續 v1.20.1~4 接續」（issue 不關、整個 v1.20.4 退役才關）
- 把本資料夾搬到 `openspec/changes/archive/v1.20.0-frontend-foundation/`
- 下個 release 開動 v1.20.1：把 `openspec/changes/v1.20.1-portal-pages/` 的 stub 展開為完整提案
