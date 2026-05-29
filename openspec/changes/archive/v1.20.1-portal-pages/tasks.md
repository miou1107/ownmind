# v1.20.1 — Dashboard 個人版任務清單

> **For agentic workers:** REQUIRED SUB-SKILL — 用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐個子任務實作。每個子任務都以「寫測試 → 跑測試確認失敗 → 寫實作 → 跑測試確認通過 → commit」TDD 流程進行。

**Goal**：把 7 個個人版頁面（Portal 4 頁 + Preference 3 頁）+ 登入頁從 PlaceholderPage 換成真實接後端 API 的實作。

**Architecture**：
- 前端：React 19 + Vite 8 + Tailwind v4 + react-router-dom v7 + recharts + lucide-react
- 後端：Express 5 既有 routes（`src/routes/*.js`）
- API client：新建 `client/src/api/` 統一封裝 fetch + Bearer header + 錯誤處理
- 認證：localStorage 存 api_key，route guard 沒登入就導 `/login`

**Tech Stack**：node --test（後端）、lint:zh-only（前端中文殘留檢查）、preview_* 工具（手動 UI 驗證）、Playwright（步驟 4 才引入）

---

## 高階階段

- [x] **步驟 1**：拆共用元件（Sidebar / TopBar / FilterBar / Footer / Modal / RoleBadge / StatCard / Layout）— commit `6cbaf52`
- [x] **步驟 2**：i18n LocaleContext（語系切換的全域狀態管理工具）+ 三語系檔（zh/en/ja）+ 自動翻譯腳本 — commit `6cbaf52`
- [ ] **步驟 3**：實作 11 個子任務（3.0~3.10）— 把 PlaceholderPage 換成真實頁面 + 接 API
- [ ] **步驟 4**：Playwright e2e 測試（登入 + 看用量 + 接手交接）
- [ ] **步驟 5**：文件（README/FILELIST/CHANGELOG）+ 升版 v1.20.1 + 部署 + 瀏覽器實測

## 開動前確認（done）

- [x] v1.20.0 release 後實際運作狀況確認（deploy 成功、Dockerfile 路徑已修正）
- [x] 對照原型 UX：以舊版 me.html 為實質規格（既有 GET /api/me/report shape 完整覆蓋用量頁需求）
- [x] 列出本版要補的 API endpoint：缺 `PUT /api/me/profile`（其他都齊）

---

## 步驟 3 子任務分解

### 子任務 3.0：API client base（前端 fetch 封裝）

**Files：**
- Create：`client/src/api/client.js` — fetch wrapper（自動帶 `Authorization: Bearer <api_key>`、JSON parse、錯誤處理）
- Create：`client/src/api/index.js` — 對外 export
- Create：`client/src/api/README.md` — 用法說明
- Create：`client/src/api/auth.js` — `getApiKey()` / `setApiKey()` / `clearApiKey()`（localStorage）

**Acceptance：**
- [ ] `apiGet('/api/me/profile')` 自動帶 Bearer header、回 `{ ok, data, error }`
- [ ] `apiPost('/api/me/login', { email, password })` 不帶 Bearer header（白名單）
- [ ] 401 自動清掉 localStorage 並回 `{ ok: false, error: 'unauthorized' }`（不做 redirect，交給 caller）
- [ ] lint:zh-only 通過（程式內不能殘留中文字、註解可中文）

**Why no test：** 前端沒測試框架，靠 lint + 手動瀏覽器測（3.2 起的頁面接 API 時順便驗）。

---

### 子任務 3.1：補後端 `PUT /api/me/profile` endpoint

**Files：**
- Modify：`src/routes/me.js` — 在 `GET /profile` 後加 `router.put('/profile', ...)`
- Create：`tests/me-profile-put.test.js` — 整合測試（mini express app + fetch）

**Acceptance：**
- [ ] `PUT /profile { name }` 更新 name，回 `{ id, name, email, role, created_at, must_change_password }`
- [ ] name 必填、trim 後不能空字串、長度 1-100
- [ ] **不能改 email / role**（即使 body 帶這兩個也忽略）
- [ ] 沒帶 api_key → 401
- [ ] DB update 失敗 → 500，記 logger.error
- [ ] `npm test` 全綠

**TDD steps：**
1. 寫 4 個失敗測試（路由存在、name 必填、合法更新、忽略 email/role）
2. 跑 `node --test tests/me-profile-put.test.js` 確認 FAIL
3. me.js 加 PUT handler
4. 重跑確認 PASS
5. 跑整個 `npm test` 確認沒打破其他測試
6. Commit

---

### 子任務 3.2：Portal `/portal/usage` 用量分析頁 ✅

**Files：**
- Create：`client/src/pages/Portal/UsagePage.jsx` — 主頁
- Create：`client/src/pages/Portal/UsageMine.jsx` — 個人區塊
- Create：`client/src/pages/Portal/UsageTeam.jsx` — 團隊區塊（含 trend chart）
- Create：`client/src/pages/Portal/UsageProjects.jsx` — 專案區塊
- Modify：`client/src/App.jsx` — 把 `/portal/usage` 路由從 PlaceholderPage 換成 UsagePage
- Modify：`client/src/i18n/zh.json`、`en.json`、`ja.json` — 補頁面字串
- Reuse：`StatCard`、`FilterBar`（既有共用元件）

**API：** `GET /api/me/report?range=14d` 或 `?start=YYYY-MM-DD&end=YYYY-MM-DD`

**Acceptance：**
- [x] 三個 tab：個人 / 團隊 / 專案
- [x] 切換 range（7d/14d/30d/all）— 實作為獨立小元件「時段切換條」、不用 FilterBar（介面對不上）
- [x] Trend chart 用 recharts（日折線 / 時段棒 / 星期棒）
- [x] Loading state、error state、empty state 都有處理
- [x] 瀏覽器手動 mock fetch 驗證三分頁 + Modal 流程、console.error 0 條

---

### 子任務 3.3：Portal `/portal/project-history` 專案歷程頁

**Files：**
- Create：`client/src/pages/Portal/ProjectHistoryPage.jsx`
- Modify：`client/src/App.jsx`、i18n 三檔

**API：** `GET /api/memory?type=project`

**Acceptance：**
- [ ] List view，每個 project 顯示 title、updated_at、description（截斷）
- [ ] 點 row 開 Modal 看完整 content
- [ ] FilterBar 搜尋 title

---

### 子任務 3.4：Portal `/portal/handoffs` 工作交接頁

**Files：**
- Create：`client/src/pages/Portal/HandoffsPage.jsx`
- Create：`client/src/pages/Portal/HandoffCard.jsx` — 單筆交接卡片
- Modify：`client/src/App.jsx`、i18n 三檔

**API：** `GET /api/handoff/pending`（列待接手）+ `PUT /api/handoff/:id/accept`（接手）

**Acceptance：**
- [ ] Pending 交接列表 + 接手按鈕
- [ ] 接手成功後從 list 移除（不 reload 整頁）
- [ ] 空列表顯示「沒有待處理交接」

---

### 子任務 3.5：Portal `/portal/reports` 回報紀錄頁

**Files：**
- Create：`client/src/pages/Portal/ReportsPage.jsx`
- Modify：`client/src/App.jsx`、i18n 三檔

**API：** `GET /api/bug-reports`（個人 own filter 後端會自動套）+ `GET /api/bug-reports/:id`

**Acceptance：**
- [ ] List：時間、title、status（待修 / 已修）
- [ ] 點 row 開 Modal 顯示完整內容

---

### 子任務 3.6：Preference `/preference/profile` 個人資料頁

**Files：**
- Create：`client/src/pages/Preference/ProfilePage.jsx`
- Modify：`client/src/App.jsx`、i18n 三檔
- 依賴：3.1（PUT 端點）

**API：** `GET /api/me/profile`（載入）+ `PUT /api/me/profile`（存檔）

**Acceptance：**
- [ ] 顯示 email / role / created_at（read-only）+ name（可編輯）
- [ ] 存檔成功 toast、失敗 toast
- [ ] name 必填驗證在前端先擋

---

### 子任務 3.7：Preference `/preference/security` 帳密修改頁

**Files：**
- Create：`client/src/pages/Preference/SecurityPage.jsx`
- Modify：`client/src/App.jsx`、i18n 三檔

**API：** `POST /api/me/change-password`

**Acceptance：**
- [ ] 舊密碼 / 新密碼 / 新密碼確認三欄
- [ ] 新密碼長度 ≥ 8、新舊不同（前端先擋）
- [ ] 後端拒絕（舊密碼錯）→ 顯示錯誤訊息
- [ ] 成功後清空表單 + toast

---

### 子任務 3.8：Preference `/preference/vault` 密鑰管理頁

**Files：**
- Create：`client/src/pages/Preference/VaultPage.jsx`
- Create：`client/src/pages/Preference/SecretRow.jsx`
- Modify：`client/src/App.jsx`、i18n 三檔

**API：** `GET /api/secret`、`POST /api/secret`、`PUT /api/secret/:key`、`DELETE /api/secret/:key`

**Acceptance：**
- [ ] List 列出所有 secret key（不顯示 value，要點「顯示」才 fetch + 顯示）
- [ ] 新增 / 編輯 / 刪除（紅色按鈕 + 確認 dialog — IR-046）
- [ ] preview_click 測試 CRUD 流程

---

### 子任務 3.9：登入頁 `/login`

**Files：**
- Create：`client/src/pages/LoginPage.jsx`
- Modify：`client/src/App.jsx` — 加 `/login` 路由（不包 Layout）

**API：** `POST /api/me/login { email, password }` → 拿到 `{ api_key, must_change_password }` → 存 localStorage → 導 `/portal/usage`（若 must_change_password=true 則導 `/preference/security`）

**Acceptance：**
- [ ] Email + 密碼欄
- [ ] 錯誤顯示後端回的 error 訊息
- [ ] 成功後 redirect 邏輯正確
- [ ] preview_fill + preview_click 跑通流程

---

### 子任務 3.10：Route guard（沒登入導 `/login`）

**Files：**
- Create：`client/src/components/common/RequireAuth.jsx`
- Modify：`client/src/App.jsx` — 用 RequireAuth 包住所有 `/portal/*`、`/preference/*`、`/admin/*`、`/super/*` 路由
- Modify：`client/src/api/client.js` — 401 時觸發 event 或直接 `window.location.href='/login'`

**Acceptance：**
- [ ] 未登入訪問任何 `/portal/*` → 立即 redirect `/login`
- [ ] 登入後 redirect 回原本想去的頁面（state 記下 from path）
- [ ] api_key 過期（401）→ 自動 redirect `/login`

---

## 子任務依賴圖

```
3.0 (API client base)
 ├─→ 3.2 ~ 3.8 (七頁都依賴)
 ├─→ 3.9 (登入頁)
 └─→ 3.10 (route guard)

3.1 (補 PUT) ─→ 3.6 (個人資料頁)

3.9 (登入頁) ─→ 3.10 (route guard) — 但 3.10 可在 3.9 完成後立即接著做
```

## 預計推進順序

1. **3.0** → 2. **3.1** → 3. **3.9** → 4. **3.10** → 5. **3.6** → 6. **3.7** → 7. **3.2**（最複雜） → 8. **3.3** → 9. **3.4** → 10. **3.5** → 11. **3.8**

（前 4 個是地基，做完後其他 7 頁可以平行或快速串）

---

## 步驟 4：e2e 測試

- 引入 Playwright（待 v1.20.1 開動時決定具體 setup）
- 至少 3 個 scenario：登入 / 看用量 / 接手交接

## 步驟 5：發版

- README / FILELIST / CHANGELOG 更新（IR-020、IR-121）
- README 三語系同步（IR-131）
- package.json / SERVER_VERSION / git tag 三處版號同步（IR-130）
- 部署後 OwnMind 首頁瀏覽器實測（IR-058）
- archive openspec change 到 openspec/changes/archive/
