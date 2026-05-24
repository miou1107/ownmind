# v1.19.15 — bug_reports id 改 SERIAL 任務清單

## 範圍

- [x] 寫 proposal.md
- [ ] 寫 `db/017_bug_reports_id_to_serial.sql`
  - [ ] sanity check：表非空時 RAISE EXCEPTION 拒絕跑
  - [ ] DROP CASCADE 五張表（順序：mutes → spam_blocks → spam_suspects → declines → bug_reports）
  - [ ] 重建五張表、id 用 SERIAL、report_ids 用 INT[]
  - [ ] 重建所有 CHECK constraint
  - [ ] 重建所有 index
- [ ] 寫 `tests/migration-017-bug-reports-id-serial.test.js`
  - [ ] 確認檔案存在
  - [ ] 確認 sanity check 句型存在
  - [ ] 確認 5 個 DROP TABLE 都用 CASCADE
  - [ ] 確認 5 個 CREATE TABLE 用 SERIAL（不是 BIGSERIAL）
  - [ ] 確認 report_ids 是 INT[]、不是 BIGINT[]
  - [ ] 確認所有 CHECK / index 都重建
- [ ] 版號 1.19.14 → 1.19.15（`package.json`）
- [ ] CHANGELOG.md 加 v1.19.15 段
- [ ] FILELIST.md 加 v1.19.15 段
- [ ] 三語系 README 版號更新
- [ ] 跑全套 `node --test`、必須全綠
- [ ] commit + push + tag v1.19.15
- [ ] kkvin.com 部署（pull / migration / build / up / smoke test 確認 id 是數字）

## 非任務

- ❌ 改既有 memories / token_usage / install_check_logs 表（不在範圍）
- ❌ 全域改 node-pg type parser（會影響 BIGINT 計數欄位）
- ❌ 改 016 migration（保留歷史、用 017 蓋過去）
