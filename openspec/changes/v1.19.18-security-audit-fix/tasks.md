# v1.19.18 — 安全漏洞修補任務清單

## 範圍

- [x] 寫 proposal.md
- [ ] 確認 `npm audit fix --dry-run` 預覽（已做、結果：qs 6.15.2、ip-address 10.2.0、express-rate-limit 8.5.2）
- [ ] 執行 `npm audit fix`
- [ ] 跑 `npm audit` 確認 0 漏洞
- [ ] 跑 `node --test` 全套測試、必須全綠
- [ ] 看 `package.json` + `package-lock.json` diff、確認只升三個套件
- [ ] 版號 1.19.17 → 1.19.18（`package.json`）
- [ ] SERVER_VERSION 同步更新（grep 確認所有 hard-coded 位置）
- [ ] CHANGELOG.md 加 v1.19.18 段
- [ ] FILELIST.md 加 v1.19.18 段（如果有新增檔案）
- [ ] 三語系 README 版號更新（zh-TW / en / ja）
- [ ] commit（IR-009 contributor=Vin、IR-024 不加 Co-Authored-By）
- [ ] tag v1.19.18 + push origin main + push tag
- [ ] kkvin.com 部署：
  - [ ] ssh kkvin.com
  - [ ] cd /VinService/ownmind && git pull
  - [ ] 跑 db/ 下未套用的 migration（IR-048、本版應為 0 條）
  - [ ] `docker compose build --no-cache`（IR-018 + IR-023）
  - [ ] `docker compose up -d`
  - [ ] 看 log 確認伺服器起來、無錯誤
- [ ] 部署後實測（IR-020）：
  - [ ] 瀏覽器開 admin 後台、登入成功
  - [ ] `curl https://kkvin.com/ownmind/api/clients/version` 回 1.19.18
  - [ ] `curl POST /api/bug-reports` 確認 qs 升級後查詢字串解析正常
- [ ] `git mv openspec/changes/v1.19.18-security-audit-fix openspec/changes/archive/`
- [ ] commit archive、push
- [ ] 關 GitHub issue #43（附 release commit 連結）

## 非任務

- ❌ 升 major 版本套件（npm audit fix 不會做、本版也不打算）
- ❌ 改任何業務邏輯或新增功能
- ❌ 客戶端 `~/.ownmind` 升級（本版伺服器端純依賴升級、不影響客戶端）
- ❌ 寫 spec.md（純依賴升級、沒有 BDD 場景要定義）

## 鐵律觸發 checklist

- [x] IR-021 開始前 git pull（已做、已是最新）
- [ ] IR-003 修 bug 先寫 reproduction test —— **跳過、理由**：本版不是修 bug、是升級已知有漏洞的依賴；漏洞 reproduction test 應該由套件作者寫、不是 OwnMind 的責任。OwnMind 既有測試 + `npm audit` 是雙重把關。
- [ ] IR-008 + IR-026 commit 前同步 README/FILELIST/CHANGELOG
- [ ] IR-018 + IR-023 部署用 docker compose build --no-cache
- [ ] IR-020 部署後瀏覽器實測
- [ ] IR-031 三處版號同步（package.json / SERVER_VERSION / git tag）
- [ ] IR-032 三語系 README 同步
- [ ] IR-048 deploy 前跑 migration（本版應為 0 條、仍要確認）
