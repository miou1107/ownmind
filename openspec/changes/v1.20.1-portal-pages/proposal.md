# v1.20.1 — Dashboard 個人版（Portal + Preference）

- **Status**: stub（待 v1.20.0 release 後展開）
- **依賴**: v1.20.0（基礎建設完成）

## 一句話總結

把 `/dashboard/portal/*`（個人用量、專案歷程、工作交接、回報紀錄）與 `/dashboard/preference/*`（個人資料、帳密、密鑰管理）的空殼頁面填上實際內容、對接後端 API。

## 範圍內
- Portal 4 頁：用量分析、專案歷程、工作交接、回報紀錄
- Preference 3 頁：個人資料、帳密修改、密鑰管理
- 共用元件抽出：Sidebar、TopBar、FilterBar、Footer、Modal、RoleBadge、StatCard
- 對接後端 API：sessions / handoffs / reports / users / secrets
- `client/src/api/` 統一 API client 模組

## 範圍外
- ❌ 管理員專區（v1.20.2）
- ❌ 超管專區（v1.20.3）
- ❌ 舊版退役（v1.20.4）

## 主要 task
1. 拆共用元件
2. 實作 7 個頁面
3. 補後端 API endpoints（缺什麼補什麼）
4. 加 e2e 測試（登入 + 看用量 + 接手交接）
5. 升版 v1.20.1、發版、實測

詳細任務在 v1.20.1 開動時展開。
