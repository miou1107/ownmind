# v1.20.1 hotfix — db healthcheck + api waits for db healthy before starting

- **Status**: completed (archived)
- **Depends on**: v1.20.1 (released, tag placed on commit 2249918)

## One-line summary

Add a postgres healthcheck to the `db` service in `docker-compose.yml`, change `api`'s `depends_on` from short form to long form + `condition: service_healthy`, to avoid the API accepting connections one step ahead of db on a fresh deploy and hitting ECONNREFUSED.

## Background

v1.20.1 removed the `docker-entrypoint-initdb.d` mount of `db/001_init.sql` (fix commit 15d1d26), switching to `src/utils/run-migrations.js` to run all migrations uniformly. But on a fresh deploy the API container runs the runner to connect to db right at startup; the current `depends_on` is the short form (only guarantees the db container starts first, not that postgres is already accepting connections).

Observed locally with a fresh volume + up: the API's first attempt prints `ECONNREFUSED 172.20.0.2:5432`, and it only succeeds after Docker restart auto-pulls it back up — a hidden race that "relies on restart to auto-recover". On a slow disk / CI / new machine it may hit more rounds, or in extreme cases hang.

## In scope

- Add a healthcheck to the `db` service in `docker-compose.yml` (`pg_isready -U ownmind -d ownmind`, 5s interval, 5s timeout, up to 10 retries, 10s grace period)
- Change the `api` service `depends_on` in `docker-compose.yml` from `- db` to the long form `db: { condition: service_healthy }`
- Add the concept of "fresh deploy E2E smoke test automation" to the CHANGELOG backlog (use bash to chain `down -v → up → setup wizard → login → /api/me/report` to run automatically, IR-027 logic gating)

## Out of scope

- ❌ Implementing the fresh deploy E2E smoke test (only noted in backlog this time, implement in the future)
- ❌ Expanding the healthcheck to the api service (the API's own readiness probe is another backlog)
- ❌ Touching `db/001_init.sql` or the migration runner logic

## Main tasks

1. Change `docker-compose.yml` to add the healthcheck + long-form depends_on
2. Acceptance: fresh volume `down -v && up`, observe that ECONNREFUSED does not appear, `docker compose ps` shows db healthy, API runMigrations succeeds in one pass
3. CHANGELOG / FILELIST sync record
4. Commit
5. archive this change

## Acceptance criteria

- After `docker compose down -v && docker compose up -d`, `docker compose logs api` has no "ECONNREFUSED" or "Bootstrap failed" error log (previously appeared 1-2 times).
- `docker compose ps` shows the `ownmind-db` STATUS column as `healthy`.
- `docker compose logs api | grep migration` confirms runMigrations runs from bootstrap 015 through applying 017 in one pass, with no second retry log.

## Related iron rules

- IR-118 deploy must use docker compose build
- IR-447 run full migration before deploy (this hardens the runner so db is always ready at startup)
- IR-122 reminders don't work, only logic does (gate with healthcheck, not relying on restart for random recovery)
