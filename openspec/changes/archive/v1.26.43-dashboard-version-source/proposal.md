# v1.26.43 — The dashboard reads its version from the server

## Why

The dashboard footer and sidebar reported `v1.20.1` while the server was on
1.26.41. Verified live on 2026-07-30 during the v1.26.41 post-deploy check.

`client/src/App.jsx` hardcoded the string:

```jsx
version: 'v1.20.1',
```

That value threaded through `Layout.jsx` into `Footer.jsx` and `Sidebar.jsx`, so
every page of the new dashboard displayed a version frozen at v1.20.1 — 42
tagged releases behind by the time it was noticed.

## The shape of the problem, not just the value

There is an existing rule that the version must stay in step across
`package.json`, `SERVER_VERSION`, and the git tag. The interesting part is that
this bug did not break that rule — it added a **fourth** place the version lives,
outside the rule's scope, where nothing was watching.

Worse, `SERVER_VERSION` itself was not one place. The identical IIFE

```js
const SERVER_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require('../../package.json').version || '0.0.0';
  } catch { return '0.0.0'; }
})();
```

was copy-pasted into `src/routes/memory.js`, `src/jobs/nightly-upgrade-reminder.js`
and `src/routes/usage/admin-clients.js`. Near-identical rather than identical:
`memory.js` used a one-line `catch`, and `admin-clients.js` needed
`../../../package.json` for its extra directory level. Semantically the same, and
all three resolve the repo-root manifest. Three copies did no harm on their own,
but they established that the version is something each consumer restates. The
hardcoded client string is that same habit taken one step further, into a file
where it could rot unnoticed.

There is in fact a fifth: `client/package.json` declares `"version": "1.21.0"`.
Nothing reads it — no `define` in `client/vite.config.js` — so it is cosmetic, and
it is left alone here and filed instead.

So this change removes the duplication rather than adding the client to a release
checklist. A checklist is a reminder; only logic holds.

## Approach

**One definition on the server.** `src/utils/server-version.js` exports
`SERVER_VERSION`. All three existing call sites import it, and the count of local
definitions is now asserted at zero by a test.

**One endpoint for the client.** `GET /api/version` returns `{ version }` and
nothing else.

The version was already reachable two other ways, and neither fits a footer that
every signed-in user sees:

| Existing route | Why not |
| --- | --- |
| `GET /api/memory/init` | returns the caller's entire compact memory set |
| `GET /api/usage/admin/clients` | admin-only, and computes install coverage |

Behind `auth`, because the only consumer renders inside the dashboard shell,
which `RequireAuth` already gates. Requiring a key costs nothing, and an
unauthenticated version endpoint on a public instance mainly tells a scanner
which release to look up advisories for.

**A hook, not a constant.** `client/src/hooks/useServerVersion.js` calls
`apiGet('/api/version')` and starts empty.

**Called from `Layout`, not `App`.** This distinction is the whole feature, and
the first attempt got it wrong. `App` mounts once inside `BrowserRouter`, outside
`RequireAuth`, and never unmounts — `LoginPage` stores the key and SPA-navigates
without a reload. So a `[]`-dep effect in `App` fires exactly once, on a cold
visit, while there is still no api key: it takes a 401 and never runs again. The
footer would have stayed empty for the entire session, replacing a stale version
with no version, and the login page would have emitted an `auth_failed` log line
on every load into a channel built to identify genuinely misconfigured clients.

`Layout` renders only beneath `RequireAuth`, so the request always carries a key.
Review caught this; 15 passing tests had not, because every client assertion was
source text and confirmed only that the literal was *gone*, never that a value
*arrives*.

The value is cached at module scope, because each `Route` element builds its own
`<Layout>` and so remounts per navigation. A page load is also the only way to
receive new client code, so a value cached per page load cannot disagree with the
bundle rendering it. Only successes are cached, so a failure is retried rather
than remembered.

Build-time injection was the alternative and was rejected. It would fix today's
drift, since the Dockerfile builds the client from the same checkout as the
server, but it reintroduces the same class of failure: a bundle cached in a
browser would keep reporting its own build version after the server moved on. The
footer's job is to say which OwnMind you are talking to.

It starts empty and stays empty on failure. Rendering nothing is honest;
rendering a placeholder is exactly what caused this bug.

## The changelog panel

The same `layoutProps` block carried a two-entry `MOCK_CHANGELOG`, last touched
for v1.20.1, with the comment "暫時 mock 的版本紀錄資料 — 後續會改從 API 載入".

Dropped, on Vin's call. `Footer.jsx` already branches on `changelog.length === 0`
and renders a `changelog.empty` message, and that string already exists in all
three locales, so the panel degrades to an honest empty state with no new code. A
real changelog feed is a separate piece of work: `CHANGELOG.md` entries are long
Chinese prose, and deciding how to summarise them and what English and Japanese
readers see is a product decision, not a side effect of this fix.

## Deliberately out of scope

The same `layoutProps` block holds three more v1.20 placeholders. Vin's call was
to fix the version only and file the rest.

- `profile: { name: 'User' }` — hardcoded, so the dashboard greets every user as
  "User" while the legacy console shows their real name.
- `onLogout: () => console.log('logout')` — the logout control does nothing.
- `useState('super_admin')` — every user's role starts as super_admin, so the
  admin and super-admin nav sections are visible to everyone. Not a privilege
  hole today, because those routes render placeholders and the server authorises
  per request, but it is misleading and would become one the moment a real page
  lands there.

`App.jsx:43` already notes these belong to a future `SessionProvider`.
