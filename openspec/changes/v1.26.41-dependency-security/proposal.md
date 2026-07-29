# v1.26.41 — Clear the open dependency advisories, and make the client path able to deliver them

## Why

The repository is public and carried 37 open Dependabot alerts, 10 of them high
severity, across three lockfiles. One Dependabot pull request (#45) was open and
unreviewed since 2026-07-29. The repository has no `.github/workflows/`, so
nothing had verified it and nothing ever will automatically.

Working through the alert list turned up a second, larger problem: bumping a root
dependency in this repository does not reach any existing user. That half is the
substance of this change.

## What the alerts actually were

Grouped by the fix each one needs:

| Group | Count | Fix |
| --- | --- | --- |
| `mcp/` transitive tree (hono, fast-uri, ip-address, qs, body-parser) | 28 | PR #45 |
| `js-yaml` in root | 2 | within `^4.1.1`, lock-only |
| `react-router` in `client/` | 4 of 5 | within `^7.10.0`, lock-only |
| `body-parser` in root | 1 | within express's `^2.2.1`, lock-only |
| `@hono/node-server` in `mcp/` | 1 | MCP SDK 1.30.0 widens the range to `^2.0.5` |
| `react-router` RSC CSRF | 1 | no fix available — see below |

Every fix except the last is inside a range the manifests already accept, so no
manifest edit is required for any of them.

## PR #45, verified before merge

Merged as `cc213fd` after checking it in an isolated worktree, because no CI
would:

- `mcp/`: `npm ci` clean, and `index.js` genuinely imports with the new tree.
- `client/`: `vite build` succeeds on vite 8.1.5. The CSS output hash is
  byte-identical to the pre-upgrade build (`index-obDkY7bq.css`) and the JS
  bundle differs by 0.02 kB — a bundler minor, not a behaviour change.
- The one new build message, a `SOURCEMAP_BROKEN` notice from
  `@tailwindcss/vite`, is cosmetic and was absent before; recorded, not fixed.

## The part that matters: a version bump could not reach a user machine

`js-yaml` is a root dependency. It parses iron-rule frontmatter in
`src/utils/iron-rule-frontmatter.js`, reached client-side through
`hooks/lib/conditional-sync-cli.js`. CVE-2026-59869 is a quadratic-CPU DoS via
YAML merge-key chains, and shared team standards originate from other accounts,
so the parsed input is not necessarily the user's own.

Neither `install.sh` nor `interactive-upgrade.sh` runs `npm install` at the
repository root — both only install inside `mcp/`. Root dependencies reach a user
machine through exactly one line, in `scripts/update.sh`:

```sh
if [ ! -d "$OWNMIND_DIR/node_modules/js-yaml" ]; then
  npm install js-yaml@^4.1.1 --no-save ...
fi
```

The guard asks whether the directory exists, not what is in it. Once a package is
present it is never revisited, so a patch published later cannot reach anyone who
had already installed.

**The install command was never the problem.** Measured directly: `npm install
js-yaml@^4.1.1 --no-save` re-resolves against the registry and installs **4.3.0**,
even when the lockfile pins 4.1.1. The old command would have delivered the patch
to anyone installing today. The guard simply never let it run — which is the only
reason `~/.ownmind/node_modules/js-yaml` on the machine this was written on sits
at 4.1.1.

That also explains why fixing the guard is sufficient on its own: the range in the
install command already reaches 4.3.0, so no lockfile change is required for the
patch to arrive.

> An earlier draft of this section argued the point differently, comparing "repo
> lock 4.3.0" against "machine 4.1.1". Code review caught that as circular: the
> 4.3.0 side was produced by this very change, and every commit up to HEAD had the
> lock at 4.1.1. The finding held; the evidence for it did not.

## Approach

Gate on the installed version instead of on directory existence, in one place
both scripts call:

- `scripts/install-helpers/dep-floor.mjs` — pure comparison library, no side
  effects on import.
- `scripts/install-helpers/dep-floor-cli.mjs` — the shell-facing predicate. Exits
  0 for "floor met, skip" and 1 for "install", and writes nothing to stdout.
- `scripts/update.sh` — `needs_root_dep <pkg> <floor>`.
- `scripts/update.ps1` — `Test-RootDepNeeded -Package <pkg> -MinVersion <floor>`.

**Why the CLI is a separate file.** The first implementation was one file that
decided whether to run its own body by comparing `process.argv[1]` against
`import.meta.url`. `path.resolve` is lexical while node realpaths the main module,
so the two differ whenever any path component is a symlink — a relocated
`~/.ownmind`, a redirected home directory, macOS aliasing `/tmp`. On a mismatch
the body was skipped and the process exited 0, which the shell reads as "floor
met". That is the bug this change exists to fix, in a form that is silent and
permanent rather than merely stale: no install would ever run again. Review caught
it, and it reproduced immediately — an impossible floor of `9.9.9` returned exit 0
through a symlinked path. Two files means the body always runs, so the CLI has
exactly the two documented exit codes and nothing to get wrong.

Both root dependencies the script installs move to the new guard, not just the
one with an advisory: the defect is in the mechanism, and leaving
`node-machine-id` on the old shape would leave the same trap set for the next
person.

Everything unreadable — package absent, no `version` field, broken JSON, node
missing, helper missing after a partial pull — reports "floor not met". The
consequence is a redundant idempotent `npm install`, never a vulnerable copy left
in place.

`package.json` also moves `js-yaml` to `^4.3.0`. The lock alone would have been
enough for the container, but raising the declared floor is what the drift tests
compare the scripts against.

## What is not fixed, and why

`GHSA-qwww-vcr4-c8h2` — React Router RSC Mode CSRF Bypass, high. The advisory's
first patched version is `react-router` 8.3.0, and **no `react-router-dom` 8.x
exists on npm**: v8 drops the `react-router-dom` shim, so clearing this alert
means migrating every import in `client/src/` off it. `npm audit fix --dry-run`
confirms there is no non-breaking fix.

Note that npm prints "fix available via `npm audit fix`" alongside that dry run
and then changes nothing, because the only fix is a major bump it will not apply
unforced. Anyone reproducing this will see text that appears to contradict the
paragraph above.

It does not apply here. `client/` is a static SPA: `src/main.jsx` mounts
`BrowserRouter`, `vite.config.js` has no SSR or RSC plugin, and a grep across
`client/src/` for `unstable_RSC`, `renderToString`, `renderToPipeableStream`,
`createStaticHandler`, `StaticRouter`, `ServerRouter`, `deserializeErrors`,
`RSCErrorHandler`, and `createRequestHandler` returns nothing. There is no server
runtime for an action to execute on.

Two of the five react-router advisories were likewise SSR/RSC-only and are moot
here; they are cleared anyway because 7.18.2 covers them. The one that genuinely
did apply to an SPA is `CVE-2026-53669`, open redirect via a backslash in `<Link>`
and `useNavigate`.

## Deliberately out of scope

- **No `.github/workflows/`.** The absence of CI is the reason this PR sat
  unverified for a day, and it is the right fix, but adding CI is its own change
  with its own decisions (which runner, which suites, whether it gates merges).
  Filed rather than smuggled in here.
- **`sourcemap: true` in `client/vite.config.js`** ships a 3.2 MB `.map` into the
  image. Noticed while diffing build output. Not touched.
- **The `client/` bundle is 690 kB in one chunk.** Pre-existing warning, unrelated.
- **`install.sh` still installs no root dependencies at all.** Its only
  `npm install` is inside `mcp/`, and it does not call `update.sh`. A fresh install
  therefore has no `js-yaml` until a hook first runs `update.sh`. Pre-existing, and
  arguably inside the "fix the mechanism" remit, but the hooks do run `update.sh`
  and pulling `install.sh` into this change would widen the blast radius for no
  security gain.
