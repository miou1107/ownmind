# v1.19.15 — bug_reports 系列 id 從 BIGSERIAL 改 SERIAL

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: 動工中
- **預估版次**: v1.19.15（hotfix-class patch）

---

## 0. 一句話總結

把 v1.19.14 引入的 bug_reports 五張表 id 欄位從 BIGSERIAL（64 位元自動編號）改成 SERIAL（32 位元自動編號）、避免 node-pg 套件把 id 預設回字串、且跟既有 memories 表一致。

---

## 1. 設計緣由

### 1.1 v1.19.14 smoke test 發現的不一致

v1.19.14 部署後跑 smoke test、發現：

```bash
$ curl -X POST /api/bug-reports ...
{"id": "1", "status": "new"}  ← id 是字串
```

對比既有 memories 表：

```bash
$ curl /api/memory/init
{"profile": {"id": 3, ...}}  ← id 是數字
```

差別在 `BIGSERIAL`（64 位元、PostgreSQL 型別 oid 20）：node-pg 套件預設把 bigint 回字串、避免超過 JS Number 安全整數上限（2^53 - 1、約 9 × 10^15）失精。`SERIAL`（32 位元、oid 23）則自動轉成 Number。

### 1.2 為什麼選 SERIAL（不是設 type parser 全域轉）

- 全域 `pg.types.setTypeParser(20, parseInt)` 會影響既有 token_usage 表的 BIGINT 計數欄位（token 數累積可能超過 Number 安全範圍、需要保留字串）
- 改 schema 比改 parser 風險低、影響面小
- bug_reports 表用 SERIAL（21 億上限）絕對夠用（一天 1 萬筆要燒 575 年）

---

## 2. 設計範圍

### 2.1 改 5 張表的 id 欄位

| 表 | 原型別 | 新型別 |
|---|---|---|
| `bug_reports.id` | BIGSERIAL | SERIAL |
| `bug_report_declines.id` | BIGSERIAL | SERIAL |
| `bug_report_spam_suspects.id` | BIGSERIAL | SERIAL |
| `bug_report_spam_blocks.id` | BIGSERIAL | SERIAL |
| `bug_report_notification_mutes.id` | BIGSERIAL | SERIAL |

### 2.2 順便改 report_ids 從 BIGINT[] 改 INT[]

`bug_report_spam_suspects.report_ids` 是 `BIGINT[]`、應該對齊 `bug_reports.id` 的新型別 INT、改成 `INT[]`。

### 2.3 安全保證

migration 017 開頭加 sanity check：

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bug_reports LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_declines LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_spam_suspects LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_spam_blocks LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_notification_mutes LIMIT 1) THEN
    RAISE EXCEPTION 'bug_reports 系列表已有資料、不能用此 migration 改 id 型別、請手動處理（先匯出資料 → DROP → CREATE → 匯入）';
  END IF;
END $$;
```

表非空就直接拒絕、不冒風險。

### 2.4 實作做法

PostgreSQL 不能直接 ALTER BIGSERIAL → SERIAL（sequence 型別綁死）、且這次表確定是空的、選最簡單做法：DROP + CREATE。

---

## 3. 工作量

| 項目 | 行數 |
|---|---|
| migration 017 SQL | 200 |
| migration 017 測試 | 100 |
| 修 spec/proposal 對 BIGSERIAL 的描述 | 0（保留 v1.19.14 歷史） |
| 版號 + CHANGELOG + FILELIST + 三語系 README | 50 |
| **總計** | 約 350 行 |

工程時間：約 30-45 分鐘（含部署 + 驗證）。

---

## 4. 風險檢查點

- [ ] migration 017 在表非空時拒絕跑（sanity check 生效）
- [ ] migration 017 在表空時順利執行
- [ ] 跑完後五張表的 id 是 INT、不是 BIGINT
- [ ] CHECK constraint 跟 index 全部重建
- [ ] 全套測試（含原 v1.19.14 的測試）綠
- [ ] prod 部署後 curl POST /api/bug-reports 看回應 id 是數字、不是字串
- [ ] 三語系版號 1.19.15
