# v1.20.1 hotfix — db healthcheck + api 等 db healthy 再啟動

- **Status**: completed (archived)
- **依賴**: v1.20.1（已 release、tag 已打在 commit 2249918）

## 一句話總結

`docker-compose.yml` 為 `db` service 加 postgres healthcheck、把 `api` 的 `depends_on` 從短形式改成長形式 + `condition: service_healthy`、避免 fresh deploy 時 API 比 db 早一步 accept connection、撞到 ECONNREFUSED。

## 背景

v1.20.1 拿掉了 `db/001_init.sql` 的 `docker-entrypoint-initdb.d` mount（fix commit 15d1d26）、改由 `src/utils/run-migrations.js` 統一跑所有 migration。但 fresh deploy 時 API container 一啟動就會跑 runner 連 db、目前 `depends_on` 是短形式（只保證 db container 先啟動、不保證 postgres 已 accept connection）。

實際在本機 fresh volume + up 時觀察到 API 第一輪嘗試會印 `ECONNREFUSED 172.20.0.2:5432`、Docker restart 自動拉起來才成功 — 屬「靠 restart 自動修復」的隱性 race。慢硬碟 / CI / 新機器上可能撞更多輪、或極端狀況卡死。

## 範圍內

- `docker-compose.yml` `db` service 加 healthcheck（`pg_isready -U ownmind -d ownmind`、5 秒間隔、5 秒 timeout、最多 retry 10 次、10 秒 grace period）
- `docker-compose.yml` `api` service `depends_on` 從 `- db` 改成長形式 `db: { condition: service_healthy }`
- 補一條「fresh deploy E2E smoke test 自動化」概念到 CHANGELOG backlog（用 bash 串 `down -v → up → setup wizard → login → /api/me/report` 自動跑、IR-027 邏輯卡控）

## 範圍外

- ❌ 寫 fresh deploy E2E smoke test 實作（這次只記 backlog、未來實做）
- ❌ healthcheck 範圍擴張到 api service（API 自身的 readiness probe、屬另一條 backlog）
- ❌ 動 `db/001_init.sql` 或 migration runner 邏輯

## 主要 task

1. 改 `docker-compose.yml` 加 healthcheck + 長形式 depends_on
2. 驗收：fresh volume `down -v && up` 觀察 ECONNREFUSED 不出現、`docker compose ps` db 顯示 healthy、API runMigrations 一次成功
3. CHANGELOG / FILELIST 同步紀錄
4. Commit
5. archive 本 change

## 驗收標準

- `docker compose down -v && docker compose up -d` 跑完、`docker compose logs api` 沒有「ECONNREFUSED」或「Bootstrap failed」error log（之前會出現 1-2 次）。
- `docker compose ps` 看 `ownmind-db` STATUS 欄顯示 `healthy`。
- `docker compose logs api | grep migration` 確認 runMigrations 從 bootstrap 015 到套完 017 一次跑完、沒有第二輪重試 log。

## 對應鐵律

- IR-118 部署必須用 docker compose build
- IR-447 deploy 前必須跑完整 migration（這次強化 runner 啟動時 db 一定 ready）
- IR-122 提醒無效邏輯才有效（用 healthcheck 卡控、不靠 restart 隨機修復）
