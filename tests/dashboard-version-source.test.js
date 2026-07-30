import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { SERVER_VERSION, readPackageVersion } from '../src/utils/server-version.js';
import { createVersionRouter } from '../src/routes/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

// `public` holds the vite build output (src/public/dashboard/assets/index-*.js),
// which is gitignored and therefore present only on a machine that has built the
// client. Walking it would make these guards scan a different file set depending
// on local state.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public']);

/** Every .js / .jsx file under a directory, recursively. */
function sourceFiles(dir, exts = ['.js', '.jsx']) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(d, entry.name);
      // withFileTypes avoids statSync, so a broken symlink cannot throw mid-walk.
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Remove comments while leaving string literals intact, so that a historical
 * reference such as "v1.20.1 step 3" in a comment is not read as a live version
 * literal, and a glob such as 'src/**' is not read as an unterminated block
 * comment.
 *
 * A regex pair is not sufficient here and the naive version was actively
 * harmful: `/\/\*[\s\S]*?\*\//g` treats the `/*` inside 'src/**' in
 * src/utils/templates.js as a comment opener and eats 112 of its 167 lines,
 * which would hide any declaration placed after it. String contents must
 * survive because one guard looks for a version assigned as a string literal.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One source of truth on the server
// ---------------------------------------------------------------------------

describe('SERVER_VERSION has a single definition', () => {
  it('the shared module reports package.json version', () => {
    assert.equal(SERVER_VERSION, pkgVersion);
  });

  it('reports a semver triple, never an empty string', () => {
    assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+/);
  });

  it('falls back to 0.0.0 rather than throwing when the manifest is unusable', () => {
    // A server that cannot read its own manifest should still boot and serve
    // memories, and consumers treat 0.0.0 as older than anything, so the upgrade
    // reminder over-advertises rather than silently suppressing.
    assert.equal(readPackageVersion(() => { throw new Error('ENOENT'); }), '0.0.0');
    assert.equal(readPackageVersion(() => ({})), '0.0.0');
    assert.equal(readPackageVersion(() => ({ version: '' })), '0.0.0');
    assert.equal(readPackageVersion(() => ({ version: '9.9.9' })), '9.9.9');
  });

  it('no file under src/ defines its own SERVER_VERSION', () => {
    // Before v1.26.43 this IIFE was copy-pasted into three files, which is how a
    // fourth copy ended up hardcoded in the dashboard and drifted from v1.20.1.
    // Comments are stripped: nightly-upgrade-reminder.js documents its threshold
    // with the example `SERVER_VERSION='1.17.0'`, which is prose, not a definition.
    const offenders = sourceFiles(join(repoRoot, 'src'))
      .filter((f) => f !== join(repoRoot, 'src', 'utils', 'server-version.js'))
      .filter((f) => /(?:const|let|var)\s+SERVER_VERSION\s*=/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(repoRoot, f));

    assert.deepEqual(
      offenders, [],
      'these files define SERVER_VERSION locally; import it from src/utils/server-version.js instead',
    );
  });

  it('every src/ file that uses SERVER_VERSION imports it from the shared module', () => {
    const missing = sourceFiles(join(repoRoot, 'src'))
      .filter((f) => f !== join(repoRoot, 'src', 'utils', 'server-version.js'))
      .filter((f) => {
        const src = stripComments(readFileSync(f, 'utf8'));
        if (!/\bSERVER_VERSION\b/.test(src)) return false;
        return !/from\s+'[^']*utils\/server-version\.js'/.test(src);
      })
      .map((f) => relative(repoRoot, f));

    assert.deepEqual(missing, [], 'these files use SERVER_VERSION without importing the shared module');
  });
});

// ---------------------------------------------------------------------------
// The endpoint the dashboard reads
// ---------------------------------------------------------------------------

async function getVersion({ auth } = {}) {
  const app = express();
  const fakeAuth = auth || ((req, res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/version', createVersionRouter({ auth: fakeAuth }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/version`);
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : null };
  } finally {
    server.close();
  }
}

describe('GET /api/version', () => {
  it('returns the server version', async () => {
    const r = await getVersion();
    assert.equal(r.status, 200);
    assert.equal(r.body.version, pkgVersion);
  });

  it('returns nothing beyond the version', async () => {
    // A footer needs one string. Anything else here is an information leak with
    // no consumer.
    const r = await getVersion();
    assert.deepEqual(Object.keys(r.body).sort(), ['version']);
  });

  it('is behind the auth middleware it is given', async () => {
    const denying = (req, res) => res.status(401).json({ error: 'unauthorized' });
    const r = await getVersion({ auth: denying });
    assert.equal(r.status, 401, 'the router must apply auth, not bypass it');
  });

  it('is mounted in app.js', () => {
    const app = readFileSync(join(repoRoot, 'src', 'app.js'), 'utf8');
    assert.match(app, /app\.use\('\/api\/version'/, 'app.js must mount the version router');
  });
});

// ---------------------------------------------------------------------------
// Drift guard on the client
// ---------------------------------------------------------------------------

describe('the dashboard holds no version literal', () => {
  it('no file under client/src assigns a hardcoded version', () => {
    // Guards the shape that broke: a version-ish identifier assigned a literal.
    // Case-insensitive so APP_VERSION and appVersion are covered, and `={` so a
    // JSX prop is too. A version assembled by concatenation would still slip
    // through; see spec Scenario 3.1 for why that is accepted.
    const offenders = [];
    for (const file of sourceFiles(join(repoRoot, 'client', 'src'))) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const hit = /version\s*[:=]\s*\{?\s*['"`]v?\d+\.\d+/i.exec(src);
      if (hit) offenders.push(`${relative(repoRoot, file)}: ${hit[0]}`);
    }
    assert.deepEqual(
      offenders, [],
      'the dashboard must read the version from the server, not carry its own copy',
    );
  });

  it('App.jsx no longer carries the mock changelog', () => {
    const src = stripComments(readFileSync(join(repoRoot, 'client', 'src', 'App.jsx'), 'utf8'));
    assert.doesNotMatch(src, /MOCK_CHANGELOG/, 'the hardcoded changelog was dropped in v1.26.43');
  });
});

describe('the version is fetched from a component that renders only after login', () => {
  // This is the guard for the defect that 15 green source-text tests missed.
  //
  // Calling useServerVersion from App looks equivalent to calling it from Layout
  // and is not. App mounts once, outside RequireAuth, and never unmounts across
  // an SPA login, so on a cold visit the request 401s and the []-dep effect never
  // runs again: the footer stays empty for the whole session, and the login page
  // emits a spurious auth_failed log line on every load.
  //
  // No React render harness exists in this repo (client/ has no testing-library
  // or jsdom), so this is a structural assertion plus a manual incognito check at
  // deploy time, not a render test.
  const layoutPath = join(repoRoot, 'client', 'src', 'components', 'common', 'Layout.jsx');
  const appPath = join(repoRoot, 'client', 'src', 'App.jsx');

  it('Layout calls the hook', () => {
    const src = stripComments(readFileSync(layoutPath, 'utf8'));
    assert.match(src, /useServerVersion\(\)/, 'Layout must fetch the version itself');
  });

  it('App neither calls the hook nor passes a version down', () => {
    const src = stripComments(readFileSync(appPath, 'utf8'));
    assert.doesNotMatch(src, /useServerVersion/,
      'App mounts before login; fetching there 401s once and never retries');
    assert.doesNotMatch(src, /^\s*version[,:]/m,
      'App must not pass a version prop into Layout');
  });

  it('Layout is the only caller, and it sits beneath RequireAuth', () => {
    const callers = sourceFiles(join(repoRoot, 'client', 'src'))
      .filter((f) => f !== join(repoRoot, 'client', 'src', 'hooks', 'useServerVersion.js'))
      .filter((f) => /useServerVersion\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(repoRoot, f));

    assert.deepEqual(callers, ['client/src/components/common/Layout.jsx']);

    // Every Layout in App.jsx is wrapped in RequireAuth, so the hook cannot run
    // before a key exists.
    //
    // Further guards may sit between RequireFreshPassword and Layout — Stage 0 of the
    // console consolidation added RequireRole for the admin and super tiers. The
    // invariant is the ordering, not the exact nesting depth, so intervening
    // <RequireX> wrappers are allowed. Pinning the depth instead made this fail on a
    // change that preserved the guarantee it exists to protect.
    const app = stripComments(readFileSync(appPath, 'utf8'));
    const layoutUses = (app.match(/<Layout\b/g) || []).length;
    const guarded = (app.match(/<RequireAuth>\s*<RequireFreshPassword>\s*(?:<Require\w+[^>]*>\s*)*<Layout\b/g) || []).length;
    assert.equal(guarded, layoutUses,
      'every <Layout> must sit inside RequireAuth, otherwise the hook can fire unauthenticated');
  });

  it('LoginPage does not render Layout, so no request goes out unauthenticated', () => {
    const src = stripComments(readFileSync(join(repoRoot, 'client', 'src', 'pages', 'LoginPage.jsx'), 'utf8'));
    assert.doesNotMatch(src, /<Layout\b/);
  });
});

describe('useServerVersion', () => {
  const hookPath = join(repoRoot, 'client', 'src', 'hooks', 'useServerVersion.js');

  it('requests /api/version through the shared api client', () => {
    const src = stripComments(readFileSync(hookPath, 'utf8'));
    // apiGet applies the /ownmind prefix detection and the 401 handling; a raw
    // fetch here would break under the nginx prefix and bypass auth-expired.
    assert.match(src, /apiGet\(\s*'\/api\/version'\s*\)/);
    assert.doesNotMatch(src, /\bfetch\(/, 'must not bypass the api client');
  });

  it('renders nothing rather than a wrong version while loading or on failure', () => {
    const src = stripComments(readFileSync(hookPath, 'utf8'));
    assert.match(src, /useState\(cached\)|useState\(\s*(null|''|"")\s*\)/,
      'initial state must be empty or the cached value, never a placeholder version');
    assert.doesNotMatch(src, /useState\(\s*['"`]v?\d/,
      'initial state must not be a hardcoded version');
  });

  it('caches only successes, so a pre-login failure is retried rather than remembered', () => {
    const src = stripComments(readFileSync(hookPath, 'utf8'));
    assert.match(src, /if\s*\(!ok[^)]*\)\s*return/,
      'a failed response must leave the cache untouched');
  });
});

// ---------------------------------------------------------------------------
// The footer already handles the empty changelog, so dropping the mock is safe
// ---------------------------------------------------------------------------

describe('Footer copes with what it is now given', () => {
  it('renders an empty-state message when the changelog is empty', () => {
    const src = readFileSync(join(repoRoot, 'client', 'src', 'components', 'common', 'Footer.jsx'), 'utf8');
    assert.match(src, /changelog\.length === 0/);
    assert.match(src, /changelog\.empty/);
  });

  it('the empty-state string exists in all three locales', () => {
    for (const locale of ['zh', 'en', 'ja']) {
      const dict = JSON.parse(
        readFileSync(join(repoRoot, 'client', 'src', 'i18n', `${locale}.json`), 'utf8'),
      );
      assert.ok(dict['changelog.empty'], `${locale}.json must define changelog.empty`);
    }
  });
});
