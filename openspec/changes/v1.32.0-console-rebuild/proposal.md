# Console rebuild: 20 pages become 7 entries

## Why

On 2026-10-04 Vin said the console (`/ownmind/dashboard`, 20 pages in 5 sections) is
cluttered: the data is scattered, the flows are odd and the layout is too busy. A
clickable prototype was built the same night (OwnMind memory 1397, artifact
`DCPh2c3sqmJn3gq4MKoWb5`, file `~/Documents/OwnMind-design/dashboard-prototype-2026-10-04.html`
on Vin's Mac — not in this repo because its demo rows carry colleagues' names). On
2026-10-08 Vin looked at it and said it can go ahead.

The same day showed what the current console cannot answer. Finding which computer still
talked to the retired host kkvin.com (#152) took reading nginx logs on that host,
reading `/api/usage/admin/clients` by hand, and matching a handoff number against
everyone's session logs. Every machine on the list said 1.31.14; none said where it
connects. The rebuild adds that column, and it ships first.

## What changes

The navigation goes from 20 pages to 7 entries. Each page answers one question the
reader already has, summary before detail, and every status says what the reader should
do about it.

| New entry | Who sees it | Takes over |
|---|---|---|
| 總覽 | everyone | the three warning banners on top of `/portal/usage`; the first screen |
| 待你處理 | everyone (錯誤回報 tab: admin) | `/portal/handoffs`, `/portal/lessons`, `/portal/tasks`, `/admin/bugs` |
| 用量與規矩 | everyone (全隊 tab: admin) | `/portal/usage`, `/portal/pitfalls`, `/portal/project-history` (project table) |
| 團隊 | everyone (觀察, 週報 tabs: admin) | `/admin/team` (list), `/team/usage`, `/team/stats`, `/team/tasks`, `/portal/narrative`, `/portal/periodic-reports` |
| 記憶 | everyone | `/portal/project-history` (memories), `/portal/reports` |
| 我的設定 | everyone | `/preference/profile`, `/preference/security`, `/preference/vault` |
| 管理 | admin (公告, 工作紀錄: super_admin) | `/admin/team` (user CRUD), `/system/config`, `/system/broadcast`, `/system/work-log` |

Every old path keeps working as a redirect to the tab that took it over, so links in
memories, notices and broadcasts do not break.

**Phase 0 — which server each machine talks to (ships alone, before the UI).**
The usage scanner's heartbeat adds `api_host` (host part of the address it reports to,
never the key or the path). The server stores it on `collector_heartbeat`, and
`/api/usage/admin/clients` returns it with `on_old_host` = the host differs from the
server's canonical host. The current `/system/config` page gets the column right away, so
#152 can be closed by looking, not by reading logs.

**Phases 1–6 — the new console**, in `client/src`, one entry per phase, each behind the
same routes so it can ship as soon as it is done. See `tasks.md`.

## Decisions

- **Copy follows the prototype.** The subject is 你, AI or OwnMind. Words a member does
  not use are replaced: collector → 回報用量的程式, heartbeat → 回報, token → (not shown;
  counts are sessions and turns), 合規率 → AI 守規矩的比例 with the formula on the card.
- **Status lights replace banners.** Three lights on 總覽 (記憶主機, 用量回報, 規矩檢查),
  each green/yellow/red with one sentence of what to do. The stacked red/yellow/grey
  banners on the usage page go away.
- **One inbox, one primary button per item.** 交接 → 接手, 學到的 → 留下／不用,
  任務卡 → 審過, 錯誤回報 → 開始處理／修好了. A handled item leaves the list.
- **Members and machines are one table.** 團隊 › 成員 lists people; clicking a row opens
  a side drawer with that person's machines, versions, and whether each one reports to the
  current host. 管理 › 每台電腦的回報 is the same data by machine for admins.
- **No new numbers the server does not have.** Every tile maps to an existing endpoint or
  to a field added in this change (Phase 0's `api_host`, and an `/api/me/overview`
  aggregate that only composes existing queries). If a tile in the prototype has no
  source, it is dropped, not faked.
- **Source stays zh-only.** `lint:zh-only` and the build-time translation to en/ja are
  unchanged.
- **The role switcher in the prototype is not shipped.** Role comes from the login.

## Not in this change

- Changing what is collected, beyond `api_host`.
- Retiring kkvin.com forwarding (#152 step 3).
- Mobile app. The pages must work at phone width, as today.
