# v1.19.2 — DB migration 自動套用 + schema_migrations 追蹤表

- **Author**: Vin
- **Date**: 2026-05-22（提案 + 動工）
- **Status**: 動工中
- **Worktree**: 無（直接在 main、改動小、可逆）
- **Branch**: `main`

---

## 0. 一句話總結

deploy / interactive-upgrade 自動偵測 `db/*.sql` 有沒有未套用的 migration、自動套上去、用 `schema_migrations` 表追蹤、**不再依賴人工記得跑 SQL**。對應 IR-027「提醒無效、邏輯才有效」+ 新建的 IR-048。

> 白話：以前發新版時要記得登 prod 手動 `psql -f 014_xxx.sql`、漏跑就會炸 500。改成自動偵測 + 自動跑、發版只要 push tag 就行、沒得忘。

---

## 1. 設計緣由

### 1.1 真實事件（2026-05-22 中午）

OwnMind v1.19.0 commit `f0ad9a7` 把 `db/014_iron_rule_tier.sql` 加進 repo（memories 表新增 `tier` 欄位）。發版時跑了：

- ✅ `git pull` on prod
- ✅ `docker compose build`
- ✅ `docker restart ownmind-api`
- ❌ **沒人記得** `docker exec ownmind-db psql -f 014_iron_rule_tier.sql`

結果：所有 `POST /api/memory` 回 500 `column "tier" does not exist`、ownmind_save / ownmind_update 全炸、log_session 走別張表所以還能用、誤導 user 以為「只是某個功能壞」。User 看不到 server log、追了半小時才發現是 schema mismatch。

### 1.2 為什麼 docker-compose 自動套機制不行

`docker-compose.yml` 只 mount `001_init.sql` 到 `/docker-entrypoint-initdb.d/`、而那個資料夾**只在 volume 第一次初始化時跑**。後續 14 個 migration 全部要手動跑。

換句話說：docker-compose 路線在「首次 fresh install」會自動套 `001`、但**從來沒有自動套過 002 ~ 014**——這 14 條全部都是 Vin 手動跑的、靠運氣記得。

### 1.3 為什麼是 v1.19.2 而不是 v1.20

- 影響範圍小：3 個新檔 + 1 個既有 script 改動
- 風險低：純加功能、不動既有資料、可重跑（idempotent）
- 已踩坑：v1.19.0 → v1.19.1 連兩次都是同一個 schema 問題、不能拖
- v1.20 範圍是「Critical 鐵律卡控」、跟這個無關、不該綁

---

## 2. 設計方案

### 2.1 核心：schema_migrations 追蹤表

新增 `db/015_schema_migrations_table.sql`：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by VARCHAR(100) DEFAULT 'auto'
);
```

每跑完一個 SQL 就 `INSERT` 一筆。下次跑 runner 時、`SELECT filename FROM schema_migrations` 比對 `db/*.sql` 檔名、只跑沒套過的。

**選這個方案的理由**（vs marker 檔 / repo APPLIED.md）：
- 標準做法（Rails / Django / Flyway / Liquibase 都是這套）
- 狀態跟 DB 本身綁、host 重灌 / docker volume 重建都不會掉
- 未來可在 admin UI 加「DB schema 狀態」頁、查 `SELECT * FROM schema_migrations`

### 2.2 Runner：scripts/run-migrations.sh

核心邏輯（pseudo-code）：

```bash
ensure_table_exists()  # 跑 015_schema_migrations_table.sql（IF NOT EXISTS、safe）
applied=$(psql -t -c "SELECT filename FROM schema_migrations ORDER BY filename")
for sql in $(ls db/*.sql | sort); do
  basename=$(basename $sql)
  if echo "$applied" | grep -q "^$basename$"; then
    echo "✓ skip $basename (already applied)"
    continue
  fi
  echo "→ applying $basename"
  psql -f "$sql" || exit 1
  psql -c "INSERT INTO schema_migrations(filename) VALUES('$basename')"
done
```

**特性：**
- Idempotent：跑兩次第二次什麼都不做
- 順序：靠 `ls | sort`、所以檔名一定要是 `NNN_xxx.sql` 格式
- 失敗即停：某條 SQL 失敗就 exit 1、不繼續跑下一條（避免狀態跳號）
- 走 `docker exec ownmind-db psql`、不依賴 host 端有 psql

### 2.3 整合點：interactive-upgrade.sh

在現有流程：

```
git pull → npm install → ★ run-migrations.sh ★ → docker restart api
```

新增的星號那一步。失敗就 abort、不重啟 api、避免 schema 對不上 code 還跑起來。

### 2.4 Backfill 既有 14 條 migration

第一次部署到 prod 時、`schema_migrations` 是空的、runner 會嘗試重跑 001 ~ 014。雖然大部分 SQL 都用 `IF NOT EXISTS` 保護、但不保證每條都 100% safe。

**解法**：deploy v1.19.2 前、手動跑一條 SQL backfill：

```sql
INSERT INTO schema_migrations(filename, applied_by) VALUES
  ('001_init.sql', 'backfill'),
  ('002_add_team_standard.sql', 'backfill'),
  ('003_activity_logs.sql', 'backfill'),
  ...
  ('014_iron_rule_tier.sql', 'backfill');
```

之後 runner 跑起來就會「✓ skip 001 ~ 014（already applied）」、只跑新加的 `015_schema_migrations_table.sql`（且 `015` 用 `IF NOT EXISTS`、重跑也 safe）。

---

## 3. 範圍 vs 不範圍

### 3.1 範圍內（v1.19.2）

- ✅ 新檔 `db/015_schema_migrations_table.sql`
- ✅ 新檔 `scripts/run-migrations.sh`（migrations runner）
- ✅ 改 `scripts/interactive-upgrade.sh`：插入 `run-migrations.sh` 呼叫
- ✅ 新測試 `tests/run-migrations.test.js`（happy path + edge case）
- ✅ Backfill prod 既有 14 條 migration
- ✅ 同步 README / FILELIST / CHANGELOG（IR-008 + IR-026 + IR-032 三語系）
- ✅ 三處版號同步 v1.19.2（IR-031）

### 3.2 不範圍

- ❌ Port 到 RING / fapa / ima：先做 OwnMind、跑順了下個版本再 port
- ❌ rollback / down migration：OwnMind 從來沒做過 down、暫不規劃
- ❌ Migration 編輯 lint（檢查檔名 NNN_xxx.sql 格式）：runner 靠 sort 排序、檔名不對自然出錯、不另外加 lint
- ❌ Admin UI 「DB schema 狀態」頁：之後再開、不在這版

---

## 4. 影響範圍

### 4.1 Server / scripts

| 檔案 | 改動 |
|------|------|
| `db/015_schema_migrations_table.sql` | **新檔** — schema_migrations 表 |
| `scripts/run-migrations.sh` | **新檔** — migrations runner |
| `scripts/interactive-upgrade.sh` | 加 `bash scripts/run-migrations.sh` 在 npm install 後、restart 前 |

### 4.2 文件

| 檔案 | 改動 |
|------|------|
| `README.md` | Deploy 段落新增「migrations 自動套用」說明 |
| `docs/README.zh-TW.md` | 同上、繁中版（IR-032） |
| `docs/README.ja.md` | 同上、日文版（IR-032） |
| `CHANGELOG.md` | 加 v1.19.2 條目 |
| `FILELIST.md` | 加新增的 3 個檔 |

### 4.3 測試

| 檔案 | 覆蓋 |
|------|------|
| `tests/run-migrations.test.js` | 1. happy path（新 migration 自動套）<br>2. idempotent（跑兩次第二次 skip）<br>3. backfill（已有紀錄不重跑）<br>4. 失敗即停（某條 SQL 失敗、後續不跑） |

### 4.4 鐵律

無新增（已有 **IR-048** 涵蓋人工版本、本版自動化後 IR-048 可降級 advisory）。

### 4.5 Prod 操作

- 一次性 backfill SQL（14 條 INSERT）
- 之後 deploy 完全自動

---

## 5. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|------|------|------|------|
| Runner 重跑某條沒 `IF NOT EXISTS` 的 SQL → 報錯 | 低（backfill 後不會發生） | 中 | Backfill 14 條後、新版本只跑 015 以後、新 SQL 寫的時候要求 `IF NOT EXISTS` |
| 某條 SQL 跑一半失敗 → schema 半套用 | 中 | 大 | Runner 失敗即停 + 不寫 schema_migrations 那筆、下次重跑會再試（要求 SQL 本身 idempotent） |
| Schema_migrations 表本身被誤刪 | 低 | 大 | 015 用 `IF NOT EXISTS`、重跑會重建空表、但已套用記錄會掉 → 必須再 backfill。建議在 admin UI 加 read-only 顯示 |
| Backfill 漏一條（例如 `db/backfill-iron-rule-codes.sql` 不是 migration、是工具腳本）| 中 | 中 | Backfill 清單由 AI 列、Vin 拍板；non-migration SQL 改放 `db/tools/` 子資料夾、runner 只掃 `db/NNN_*.sql` |
| 本機開發跟 prod 不一致 | 中 | 中 | runner 也支援本機 docker compose、開發者跑 `bash scripts/run-migrations.sh` 即可同步 |

---

## 6. 拍板紀錄

| # | 議題 | 待拍板選項 |
|---|------|-----------|
| 1 | 追蹤機制 | A. schema_migrations 表（建議、本提案）/ B. host marker 檔 / C. repo APPLIED.md |
| 2 | 範圍 | A. 只做 OwnMind（建議）/ B. 順手 port 到 RING / fapa |
| 3 | 整合點 | A. interactive-upgrade.sh 自動跑（建議）/ B. 獨立 script 手動跑 |
| 4 | Backfill 策略 | A. 一次性 SQL backfill 14 條（建議）/ B. 加判斷「DB 已有 memories 表 → 視為已套用 001~014」 |
| 5 | non-migration SQL 處理 | A. 移到 `db/tools/`（建議）/ B. runner 加白名單跳過 |

**Vin 已拍板**：1A / 2A / 3A / 4A / 5A（前次對話中已選）

---

## 7. 下一步

1. ✅ Vin 拍板（已完成）
2. ⏳ 寫 `spec.md`（GIVEN/WHEN/THEN 場景）
3. ⏳ 寫 `tasks.md`（任務清單）
4. ⏳ 走 TDD（IR-003）：先寫測試 → 跑紅 → 實作 → 跑綠
5. ⏳ 本機端對端測試（docker compose 起乾淨 DB）
6. ⏳ Backfill prod
7. ⏳ Prod 跑一次 runner 確認 idempotent
8. ⏳ 品管三步驟（IR-012）：verification → request review → handle review
9. ⏳ 同步 README / FILELIST / CHANGELOG（IR-008 + IR-026 + IR-032）
10. ⏳ 三處版號同步 v1.19.2（IR-031）
11. ⏳ Tag v1.19.2、push、部署 prod
