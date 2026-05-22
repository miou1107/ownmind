# v1.19.2 — Auto Migration 規格（GIVEN / WHEN / THEN）

> BDD 三段式（前提 / 動作 / 預期結果）。Runner 行為、表結構、整合點的外部可觀察行為。

---

## 場景 1：首次跑 runner、schema_migrations 表還不存在 → 自動建表

**GIVEN**

- 全新 OwnMind 部署（fresh install）、`schema_migrations` 表不存在
- `db/` 目錄有 `001_init.sql` ~ `015_schema_migrations_table.sql` 共 15 個 SQL

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- `schema_migrations` 表建立成功（由 `015_schema_migrations_table.sql` 建）
- 15 個 SQL 全部跑過、`schema_migrations` 有 15 筆記錄
- exit code = 0
- stdout 含每條 migration 的「→ applying NNN_xxx.sql」訊息

---

## 場景 2：runner 二次跑、所有 migration 都已套用 → 全部 skip

**GIVEN**

- `schema_migrations` 表已存在、含 15 筆紀錄
- `db/*.sql` 沒新增

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 不跑任何 `psql -f`
- stdout 含「✓ skip NNN_xxx.sql（already applied）」x15
- stdout 結尾「✅ 沒有新 migration、DB schema 是最新」
- exit code = 0
- `schema_migrations` 行數仍為 15

---

## 場景 3：新增一個 migration → 只跑新的那一個

**GIVEN**

- `schema_migrations` 表含 015 筆紀錄
- 開發者新增 `db/016_add_user_avatar.sql`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 1 ~ 15 號全部 skip（已有紀錄）
- 16 號跑 `psql -f db/016_add_user_avatar.sql`
- 跑完 `INSERT INTO schema_migrations(filename) VALUES('016_add_user_avatar.sql')`
- `schema_migrations` 行數 = 16
- exit code = 0

---

## 場景 4：某條 migration SQL 失敗 → runner 失敗即停、不寫紀錄

**GIVEN**

- `schema_migrations` 含 015 筆紀錄
- 開發者新增 `db/016_broken.sql`（內含語法錯誤）
- 開發者新增 `db/017_should_not_run.sql`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 016 嘗試 `psql -f`、psql 回 exit code != 0
- runner 立刻 exit、不跑 017
- `schema_migrations` 不寫 016 那筆（也不寫 017）
- exit code = 1
- stderr 含「❌ migration 016_broken.sql 失敗、後續停止」

---

## 場景 5：Backfill 後再跑 runner → 既有 SQL 不重跑

**GIVEN**

- Prod 已運行多時、`memories` 等表已存在、但 `schema_migrations` 不存在
- 執行 backfill SQL（INSERT 14 筆 001 ~ 014）+ 跑 `015_schema_migrations_table.sql`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 001 ~ 015 全部 skip（已有紀錄、含剛 backfill 的 14 筆 + 015 表自身建立時也 INSERT 自己）
- 沒有新 migration → 「✅ 沒有新 migration、DB schema 是最新」
- exit code = 0
- 既有資料完全沒動

---

## 場景 6：runner 自動建 schema_migrations 表也算一次 migration

**GIVEN**

- 全新 DB、`schema_migrations` 不存在
- `db/015_schema_migrations_table.sql` 存在

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- 015 跑時建表 + 自己 INSERT 015 那筆紀錄（self-recording）
- 015 跑完後、後續 016+ 才能用 `INSERT INTO schema_migrations`
- 順序確保：runner 先跑 001 ~ 014（用 try-catch、表還沒建時 INSERT 會失敗、所以 001 ~ 014 跑完都不寫表）→ 跑 015 建表 + 補寫 001 ~ 015 共 15 筆

**設計簡化**：避免 chicken-and-egg、改為 runner 一開始就 `psql -f 015_schema_migrations_table.sql`（用 `IF NOT EXISTS`、safe）、然後才開始正常迴圈。

---

## 場景 7：interactive-upgrade 整合 — migration 失敗 → 不重啟 API

**GIVEN**

- Prod 跑 `interactive-upgrade.sh`
- 拉到含 broken migration 的版本

**WHEN**

upgrade 走到 `run-migrations.sh` 步驟

**THEN**

- runner 失敗、exit 1
- interactive-upgrade.sh 偵測 runner 失敗、輸出 `ERROR:migration:某條 migration 失敗`
- **不執行** `docker restart ownmind-api`
- 留下舊版本 api 繼續服務（避免新 code 配舊 schema）
- 寫日誌到 `logs/upgrade-<timestamp>.log` 含 migration 失敗 stack

---

## 場景 8：interactive-upgrade 整合 — migration 成功 → 正常重啟

**GIVEN**

- Prod 跑 `interactive-upgrade.sh`
- 拉到含新 migration 的版本

**WHEN**

upgrade 走到 `run-migrations.sh` 步驟

**THEN**

- runner 跑完、exit 0
- 輸出 `OK:migration:N 個 migration 套用完成`（N 為實際套用數）
- 繼續執行 `docker restart ownmind-api`
- upgrade 流程正常完成

---

## 場景 9：non-migration SQL（如 backfill-iron-rule-codes.sql）→ runner 跳過

**GIVEN**

- `db/` 目錄含 `backfill-iron-rule-codes.sql`（沒有 NNN_ 前綴、是工具腳本）

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- runner 只掃符合 `db/[0-9][0-9][0-9]_*.sql` glob 的檔案
- `backfill-iron-rule-codes.sql` 被忽略、不跑、不寫 schema_migrations
- exit code = 0

---

## 場景 10：runner 使用 DB 連線參數從環境變數讀

**GIVEN**

- 環境變數 `DB_HOST=ownmind-db`, `DB_USER=ownmind`, `DB_NAME=ownmind`, `DB_PORT=5432`
- 或在 docker 環境下、runner 用 `docker exec ownmind-db psql -U ownmind -d ownmind`

**WHEN**

```bash
bash scripts/run-migrations.sh
```

**THEN**

- runner 優先用 `docker exec ownmind-db`（檢測 container 存在）
- 否則 fallback 用 `psql` 直連（讀 `DB_HOST` 等環境變數）
- 兩種模式都能跑、便於本機與 prod 統一
