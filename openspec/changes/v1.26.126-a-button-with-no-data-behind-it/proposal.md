# v1.26.126 — Proposal: the footer's changelog button, and the data that was never wired to it

## Background

The dashboard footer has a button labelled "系統版本更新紀錄". Clicking it opens a modal
that says "目前尚無版本紀錄" and has said so since v1.20.0.

Nothing about it is broken. The modal, its timeline markup, its glassmorphism styling and
its empty-state string in all three locales all shipped together. What never shipped was
the data:

```js
// client/src/App.jsx
// changelog 刻意留空：Footer 三語系都有 changelog.empty 空狀態，真正的更新
// 紀錄來源是獨立的一件事。
const layoutProps = { changelog: [] };
```

The comment is accurate and the separate thing was never built. Meanwhile `CHANGELOG.md`
at the repo root holds 299 releases.

**A well-built empty state is what kept this invisible.** The button did not error, did not
hang and did not render a broken list — it truthfully reported having no entries, which is
indistinguishable from a product that has not shipped any. The same shape as v1.26.124: a
defence that never fires looks exactly like a defence with nothing to catch.

## Why CHANGELOG.md rather than a new list

A second, hand-maintained list of releases would be two places to update, one of which goes
stale without failing. That is the mistake v1.26.43 undid when it replaced the hardcoded
`'v1.20.1'` in App.jsx with a value read from the server. `CHANGELOG.md` is already
maintained on every release, and IR-026 already requires touching it.

## Why the server reads it, not the bundle

Same reason the version is fetched rather than compiled in: a cached bundle keeps reporting
its own build after the server has moved on. The footer's job is to describe the OwnMind you
are talking to.

This makes CHANGELOG.md a file the server reads at runtime, which is IR-034 territory —
`src/` and `db/` are copied into the image path by path, so a file outside them is simply
absent, and the parse failure degrades quietly to `[]`. The symptom would be "empty in
production, fine on every developer machine". A test asserts the `COPY` line exists.

## Three heading shapes

The file was written over 299 releases and the heading format changed twice. All three are
still reachable by a reader scrolling back:

| shape | example | count |
|---|---|---|
| em dash | `## v1.26.125 — 標題` | current |
| ASCII hyphen | `## v1.15.4 - 標題` | up to v1.16.0 |
| date first | `## 2026-03-26 — v1.4.0 標題` | the first releases |

A parser that knows only the current shape yields 284 entries with an empty title. Only the
earliest shape carries a date, so `date` is empty for most entries and the timeline omits
the element rather than rendering an empty one — a blank slot reads as a missing value
rather than a value that was never recorded.

## Out of scope

- Translating the entries. CHANGELOG.md is written in Chinese; an EN or JA reader sees
  Chinese release notes. Product i18n (track A) covers this file separately and is not
  pulled forward here.
- Pagination or a full-history view. The endpoint returns the newest 30.

## Also in this release

Vin asked for the "OwnMind 開源計畫" text in the footer's bottom-right corner to be removed.
`footer.copyright` is deleted from all three locale files, leaving no orphan key.
