# Spec — v1.32.0 console rebuild

## Phase 0: which server each machine talks to

### Heartbeat
- The usage scanner's heartbeat carries `api_host`: the host of the address it reports to,
  lower-cased, without scheme, port, path, query or credentials (`kkvin.com`,
  `fapa.welcometw.com`). Nothing else from the address is sent.
- The server accepts `api_host` up to 255 characters matching a host name; anything else
  is ignored (stored value kept), never rejected, so an odd value cannot stop a heartbeat.
- A heartbeat without `api_host` (older scanner, the MCP) leaves the stored value alone.

### Admin list
- `GET /api/usage/admin/clients` returns `api_host` per client (null when never reported)
  and `on_old_host`: true when `api_host` is set and differs from the host of the
  server's canonical URL.
- `/system/config` shows the host per machine; `on_old_host` shows a red pill
  「連到舊主機」 with the sentence 「在這台電腦跟 AI 說『升級 OwnMind』；升級後還是紅的，
  請把 AI 自檢的結果傳給管理員」.

## Phases 1–6: the new console

- Seven entries: 總覽, 待你處理, 用量與規矩, 團隊, 記憶, 我的設定, 管理. Role gates as in
  `proposal.md`; a tab the role may not see is not rendered, and its URL redirects to the
  entry's first tab.
- Each of the 20 old paths redirects to the tab that took it over (table in `proposal.md`).
- Every status shown (light, pill, tile) has a sentence saying what the reader should do,
  or that nothing is needed.
- Every number shown comes from an endpoint; a missing value renders as 「沒有資料」,
  never as 0.
- Pages work at 375px wide, in light and dark, with keyboard focus visible.
