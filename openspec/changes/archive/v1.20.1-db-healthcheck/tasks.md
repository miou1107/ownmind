# v1.20.1 hotfix — db healthcheck task list

## Tasks

- [x] Confirm the problem: after v1.20.1 removed the init mount, a fresh deploy shows ECONNREFUSED for 1-2 rounds, relying on restart for random recovery (IR-122 counter-example: logic not gated, relying on retry luck)
- [x] Change `docker-compose.yml`: add a healthcheck block to the db service (`pg_isready -U ownmind -d ownmind` 5s interval, 5s timeout, 10 retries, 10s start_period)
- [x] Change `docker-compose.yml`: change api `depends_on: [- db]` to the long form `db: { condition: service_healthy }`
- [x] Acceptance 1: after `docker compose down -v && docker compose up -d`, api log has no ECONNREFUSED
- [x] Acceptance 2: `docker compose ps` db STATUS shows healthy
- [x] Acceptance 3: `docker compose logs api | grep migration` runMigrations runs in one pass, no second retry log
- [x] CHANGELOG add hotfix section, FILELIST mark the docker-compose change
- [x] Commit
- [x] Archive this change (move to `openspec/changes/archive/v1.20.1-db-healthcheck/`)
