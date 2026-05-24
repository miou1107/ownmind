# v1.20.3 — Dashboard 超管版（Config + Broadcast + Audit）

- **Status**: stub（待 v1.20.2 release 後展開）
- **依賴**: v1.20.2

## 一句話總結

填 `/dashboard/super/*` 三個超管頁面：系統配置與計價、廣播管理、全域稽核。

## 範圍內
- Config 頁：API 計價、系統參數
- Broadcast 頁：版本廣播、snooze 管理
- Audit 頁：全域操作稽核日誌、跨使用者查詢
- super_admin role 守衛
- 後端 API：補缺的 super endpoints

## 範圍外
- ❌ 舊版退役（v1.20.4）

## 主要 task
1. Config / Broadcast / Audit 三頁實作
2. API 對接
3. 角色守衛測試
4. 升版 v1.20.3、發版、實測

詳細任務在 v1.20.3 開動時展開。
