# v1.20.1 hotfix — db healthcheck 任務清單

## task

- [x] 確認問題：v1.20.1 拿掉 init mount 後 fresh deploy 會看到 ECONNREFUSED 1-2 輪、靠 restart 隨機修復（IR-122 反例：邏輯沒卡控、靠 retry 撞運氣）
- [x] 改 `docker-compose.yml`：db service 加 healthcheck 區塊（`pg_isready -U ownmind -d ownmind` 5s 間隔、5s timeout、10 retries、10s start_period）
- [x] 改 `docker-compose.yml`：api `depends_on: [- db]` 改成長形式 `db: { condition: service_healthy }`
- [x] 驗收 1：`docker compose down -v && docker compose up -d` 跑完、api log 無 ECONNREFUSED
- [x] 驗收 2：`docker compose ps` db STATUS 顯示 healthy
- [x] 驗收 3：`docker compose logs api | grep migration` runMigrations 一次跑完、無第二輪重試 log
- [x] CHANGELOG 加 hotfix 段、FILELIST 標 docker-compose 改動
- [x] Commit
- [x] Archive 本 change（移到 `openspec/changes/archive/v1.20.1-db-healthcheck/`）
