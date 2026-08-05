# v1.26.60 — Clean up after the retirement (consolidation Stage 8)

Parent: `openspec/changes/single-console-consolidation/`, Stage 8. The final stage.

`/admin` already stopped serving in v1.26.59 — the manifest emptied and the either/or
switched branches by itself, which was the design. This change is everything the
redirect does not do on its own: deleting what the retirement made unreachable, and
removing one feature that was decided against rather than merely orphaned.

## Four decisions, taken with production data

The umbrella ledger left four items marked "needs Vin". Each was measured on production
on 2026-08-05 before asking, so none of them was decided on a guess.

| Question | Measured | Decision |
|---|---|---|
| Delete 鐵律升級 (`/api/admin/iron-rules/*`)? | 72 of Vin's 109 active iron rules are still legacy free text, and **every** other user's are — 100%. The migration it reports on is nowhere near done | **Keep the endpoints, no UI.** Deleting the only thing that can see an unfinished migration would hide it. Recorded as backlog with the numbers |
| Delete `/api/admin/login`, which writes the only `audit_logs` login row? | **0 login rows in 60 days.** Everyone moved to the console, and the console's login never wrote one | **Delete it, and move the audit write into `/api/me/login`.** The auditing did not "end with this change" — it ended silently two months ago. This reconnects it to the path people actually use |
| `/api/usage/exemptions` — super_admin CRUD with no UI | 0 exemption rows on production. The **table** is read by the coverage panel; only the CRUD is unused | **Delete the CRUD, keep the table.** YAGNI on the endpoints; the denominator keeps working |
| A fresh clone has no console: `src/public/dashboard/` is gitignored | After this change there is no build-independent page left at all, so `npm start` serves a redirect into a 404 | **Build on demand from `npm start`.** The artefact stays out of git |

## The exposure this closes

`installLegacyAdminMount` still contains the branch that serves `express.static` over the
whole of `src/public/`. It is not installed today, so `/admin/setup.html`,
`/admin/me/index.html` and `/admin/dashboard/index.html` already redirect (verified on
production). But the branch is one manifest edit away from being installed again, and
that edit now has a second consequence nobody would predict: a signpost links to
`/admin/#tab`, which redirects to the console, which renders the signpost again.

So `signpost` stops being a state the manifest accepts. The validator already throws on
an unknown state — that is the mechanism Stage 1a built for exactly this class of
mistake — and removing the value from `FEATURE_STATES` turns "put a feature back in the
old console" into a boot failure with a message, instead of a redirect loop.

With no state that can produce one, the signpost UI goes too: the page, the credential
handoff into the old console's localStorage keys, the amber sidebar marker, and the
three locale groups that name legacy tabs.

## The cost calculation

Requirement 8, decided 2026-07-30 and deferred to this stage. Pricing has to be
maintained by hand per model, and `usage-aggregation.js` sets `cost_usd = null` when any
model in a batch lacks a price, so one gap blanks the column for everyone. Measured
2026-07-30: all five members with usage data showed no cost while the four with no data
showed `$0.0000` — precisely backwards.

`usage_metrics_daily.cost_usd` stays as a column. Dropping it needs a migration for no
benefit, and the historical rows are not wrong, just unmaintained. What goes is
everything that computes, serves or displays it — including the endpoint whose `GET` was
mounted with plain `auth` while only `POST` was `superAdminAuth`, so any signed-in user
could read the price table.

## Non-goals

- No new UI. Stage 7 was the last one that moves a feature.
- No migration. The `cost_usd` column stays; so does `usage_tracking_exemption`.
- 鐵律升級 is not rebuilt, only kept reachable by API.
- `src/public/setup.html` and the `/setup` route stay: the wizard is a separate
  unauthenticated bootstrap flow and always was.
