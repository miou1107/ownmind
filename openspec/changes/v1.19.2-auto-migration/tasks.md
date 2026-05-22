# v1.19.2 — Auto Migration 任務清單

> 依 IR-003（TDD）：每個實作 task 前面先寫測試
> 依 IR-012（品管三步驟）：驗證 → 請評審 → 處理回饋
> 依 IR-008（commit 同步更新 README/FILELIST/CHANGELOG）

---

## 階段 A：schema_migrations 表

- [ ] A1. 新檔 `db/015_schema_migrations_table.sql`
  - `CREATE TABLE IF NOT EXISTS schema_migrations(filename PK, applied_at, applied_by)`
  - 用 `IF NOT EXISTS` 確保 idempotent
  - INSERT 自己這筆紀錄（self-record）
- [ ] A2. 本機 docker compose 起 DB 跑一次 → 確認表建立、紀錄寫入

---

## 階段 B：Runner 邏輯

- [ ] B1. 寫測試 `tests/run-migrations.test.js`（場景 1 ~ 9）
  - happy path：首次跑、套用所有 SQL
  - idempotent：二次跑、全部 skip
  - 新增一條：只跑新的
  - 失敗即停：broken SQL 中斷
  - backfill：跳過已有紀錄
  - non-migration 跳過（`backfill-iron-rule-codes.sql`）
  - **測試實作策略**：用 mock filesystem + mock psql command、純函式測試 runner 內部邏輯；DB 端對端在階段 D 做
- [ ] B2. 新檔 `scripts/run-migrations.sh`
  - 偵測執行環境（docker exec vs 直接 psql）
  - 跑 015 確保表存在
  - 列 `db/[0-9][0-9][0-9]_*.sql`、排序
  - 比對 schema_migrations、跑未套用的
  - 失敗即 exit 1、不寫紀錄
  - 輸出格式：`INFO:` / `OK:` / `ERROR:` prefix（跟 bootstrap.sh 一致）

---

## 階段 C：interactive-upgrade 整合

- [ ] C1. 改 `scripts/interactive-upgrade.sh`：在 `npm install` 後、`docker restart` 前插入 `bash scripts/run-migrations.sh`
- [ ] C2. 失敗處理：runner exit != 0 → output `ERROR:migration:...` → abort upgrade（不重啟 api）
- [ ] C3. Windows 版 `interactive-upgrade.ps1` 同步加入（用 `bash` via WSL 或直接呼叫 psql.exe）

---

## 階段 D：端對端驗證

- [ ] D1. 本機：`docker compose down -v && docker compose up -d` → fresh DB → 跑 runner → 確認 15 條都套用、表都建立
- [ ] D2. 本機：再跑一次 runner → 確認全部 skip
- [ ] D3. 本機：手動加 `db/099_test.sql` (`SELECT 1`) → 跑 runner → 確認只跑 099 → 刪除測試檔
- [ ] D4. Prod：backfill 14 條歷史 migration（手動 INSERT 進 schema_migrations）
- [ ] D5. Prod：跑一次 runner → 確認跑了 015（建表 + 自記）→ 全部 skip
- [ ] D6. Prod：實測 `ownmind_save` 正常運作

---

## 階段 E：文件同步（IR-008 + IR-026 + IR-032）

- [ ] E1. `README.md`：Deploy 段落加「migrations 自動套用」說明
- [ ] E2. `docs/README.zh-TW.md`：繁中版同步
- [ ] E3. `docs/README.ja.md`：日文版同步
- [ ] E4. `CHANGELOG.md`：加 v1.19.2 條目
- [ ] E5. `FILELIST.md`：加 015 + run-migrations.sh + 測試檔

---

## 階段 F：版號 + commit + tag + deploy

- [ ] F1. 版號三處同步（IR-031）：`package.json` v1.19.2、`SERVER_VERSION` 1.19.2、tag `v1.19.2`
- [ ] F2. 品管三步驟（IR-012）：
  - verification-before-completion：跑全測試 + lint
  - requesting-code-review：請 review
  - receiving-code-review：處理回饋
- [ ] F3. Commit：用 IR-009（Vin contributor）+ IR-024（no Co-Authored-By）+ IR-026（README/FILELIST/CHANGELOG 已同步）
- [ ] F4. Tag `v1.19.2` + push origin main + tag
- [ ] F5. Deploy prod：用 `docker compose build`（IR-023）+ `interactive-upgrade.sh` 自動跑 migration
- [ ] F6. 部署後瀏覽器實測（IR-020）：admin UI 開、ownmind_save / log_session 各測一次
- [ ] F7. IR-048 降級為 advisory：人工檢查改自動化、提醒層降級

---

## 階段 G：歸檔

- [ ] G1. 移動本 change 資料夾到 `openspec/changes/archive/v1.19.2-auto-migration/`
- [ ] G2. 更新 `openspec/specs/dashboard/spec.md` 加入 migration runner 的 scenario（如有需要）
