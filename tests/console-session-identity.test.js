// Stage 0 of the single-console consolidation: the console must learn who the user is
// from the server instead of from a literal, and must gate routes by role.
//
// Two kinds of test live here, and the difference matters when reading a green run.
//
// The last suite genuinely executes the role ladder, including its fail-closed
// behaviour. That is why the ladder was split out of SessionContext.jsx into a plain
// module: the part that decides who gets in should be run, not read.
//
// Everything above it reads the .jsx source and asserts on its contents, because this
// repo has no React test harness — `npm test` runs `node --test` only, and client/ has
// no jsdom, testing-library or vitest. That is the established pattern here (see
// tests/dashboard-version-source) and it is genuinely weaker than rendering: it proves
// the wiring exists and cannot silently regress, not that the output is correct. The
// rendered behaviour is verified against the real server at the stage's browser check.
//
// Adding a render harness is worthwhile but is its own piece of work; doing it inside
// Stage 0 would bury the change it is meant to guard.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Strip comments so a rule never matches its own explanation. Single-pass and
// string-aware, because the naive regex version ate two thirds of a file once: a
// string containing '/*' opened a comment that never closed.
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }
    // state === 'str'
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if (c === quote) { state = 'code'; out += c; i += 1; continue; }
    out += c; i += 1; continue;
  }
  return out;
}

const APP = 'client/src/App.jsx';
const LAYOUT = 'client/src/components/common/Layout.jsx';
const TOPBAR = 'client/src/components/common/TopBar.jsx';
const AUTH = 'client/src/api/auth.js';
const SESSION = 'client/src/session/SessionContext.jsx';
const GUARD = 'client/src/components/common/RequireRole.jsx';

describe('Stage 0 — identity comes from the server, not from a literal', () => {
  it('App.jsx holds no hardcoded role', () => {
    const src = stripComments(read(APP));
    assert.doesNotMatch(
      src,
      /useState\(\s*['"](?:user|admin|super_admin)['"]\s*\)/,
      'App.jsx still seeds a role with useState(<literal>); the role must come from the session',
    );
    assert.doesNotMatch(
      src,
      /role\s*:\s*['"](?:user|admin|super_admin)['"]/,
      'App.jsx still passes a literal role down; the role must come from the session',
    );
  });

  it('App.jsx holds no placeholder display name', () => {
    const src = stripComments(read(APP));
    assert.doesNotMatch(
      src,
      /name\s*:\s*['"]User['"]/,
      "App.jsx still passes the placeholder profile name 'User'",
    );
  });

  it('logout clears the credential and returns to /login', () => {
    const src = stripComments(read(SESSION));
    const at = src.indexOf('const logout =');
    assert.ok(at !== -1, 'the session must own logout');
    const body = src.slice(at, src.indexOf('\n  return', at));
    assert.match(body, /clearApiKey\(\)/,
      'logout must clear the stored credential. Asserting that App.jsx no longer contains '
      + '"console.log" passed trivially once the prop was removed, and stayed green when '
      + 'the body was replaced with a no-op');
    assert.match(body, /AUTH_EXPIRED/,
      'logout must announce expiry so the single /login redirect path handles it');
  });

  it('a session module exists and reads the identity endpoint', () => {
    assert.ok(existsSync(join(ROOT, SESSION)), `${SESSION} is missing`);
    const src = stripComments(read(SESSION));
    assert.match(src, /\/api\/me\/profile/, 'the session must read /api/me/profile');
    assert.match(src, /export function useSession|export const useSession/, 'useSession must be exported');
  });

  it('the session is not persisted to storage, so it cannot be spoofed', () => {
    const src = stripComments(read(SESSION));
    assert.doesNotMatch(
      src,
      /localStorage\.setItem|sessionStorage\.setItem/,
      'the role must not be written to storage — the old console did that with om_role '
      + 'and a user could edit it to reveal admin navigation',
    );
  });

  it('Layout sources the role itself instead of taking it as a prop', () => {
    const src = stripComments(read(LAYOUT));
    assert.match(src, /useSession/, 'Layout must consume the session');
    assert.doesNotMatch(
      src,
      /^\s*role,\s*$/m,
      'Layout still destructures a role prop; it should read the session like it reads the version',
    );
  });
});

describe('Stage 0 — routes are gated by role, not only by having a session', () => {
  it('a role guard exists and renders all three outcomes', () => {
    assert.ok(existsSync(join(ROOT, GUARD)), `${GUARD} is missing`);
    const src = stripComments(read(GUARD));
    assert.match(src, /return null/, 'the guard must render nothing while waiting');
    assert.match(src, /<Navigate/, 'the guard must redirect on denial');
    assert.match(src, /return children/, 'the guard must render the page when allowed');
  });

  it('the guard delegates its decision to the executable module', () => {
    const src = stripComments(read(GUARD));
    assert.match(src, /decideRoleGate/,
      'the ordering of readiness against role cannot be verified by reading source text — '
      + 'an earlier version of this test asserted that "ready" appeared before "<Navigate>" '
      + 'in the file, which passes for a guard that checks the role first. Keep the '
      + 'decision in session/roles.js where it is run');
  });

  // v1.26.46 rewrote the three assertions that used to live here. They matched hand-listed
  // <Route> elements and the named renderers renderAdmin / renderSuper, and read the
  // required role from the *section*. Routes are now generated from the navigation and the
  // role is per item, so those assertions could only be kept by keeping the shape they
  // described. What they protected is stronger now and split across two files:
  //   - "sidebar and guard agree" is true by construction: one minRole feeds both
  //   - the agreement, the filtering and the fallback loop are executed in
  //     tests/console-nav-structure.test.js
  // The two below are what remains source-only, because App.jsx is JSX.

  it('the gated renderer keeps all three guards, with the role passed through', () => {
    const src = stripComments(read(APP));
    const at = src.indexOf('const renderGated =');
    assert.ok(at !== -1, 'renderGated is missing');
    const body = src.slice(at, src.indexOf('\n  const ', at + 10) === -1
      ? src.indexOf('\n  return', at)
      : src.indexOf('\n  const ', at + 10));
    assert.match(body, /<RequireAuth>/, 'renderGated must still require a session');
    assert.match(body, /<RequireFreshPassword>/, 'renderGated must still force a password change');
    assert.match(
      body,
      /<RequireRole\s+min=\{minRole\}/,
      'renderGated must gate on the role it was given, not on a literal',
    );
  });

  it('the ordinary renderer does not gate on role, so members keep their own pages', () => {
    const src = stripComments(read(APP));
    const at = src.indexOf('const renderPage =');
    const body = src.slice(at, src.indexOf('\n  const ', at + 10));
    assert.doesNotMatch(body, /<RequireRole/, 'renderPage must not require a role');
  });

  it('the gated renderer is used for exactly the items that need a role', async () => {
    // The decision that picks a renderer per generated route. A reversed condition would
    // gate every personal page and open every admin one, and the executable filtering
    // tests would not notice, because they read the nav data rather than App.jsx.
    //
    // Review caught the first version of this test matching the ternary's source text,
    // which is the antipattern the previous round removed from roles.js. The decision now
    // lives in routeTierFor and is run here.
    const { routeTierFor } = await import('../client/src/session/roles.js');
    const { allNavItems } = await import('../client/src/components/common/nav-sections.js');

    assert.equal(routeTierFor('user'), 'open');
    assert.equal(routeTierFor('admin'), 'gated');
    assert.equal(routeTierFor('super_admin'), 'gated');
    // Fails closed: a typo in a nav item's minRole locks the page rather than opening it.
    for (const bad of [null, undefined, '', 'users', 'valueOf']) {
      assert.equal(routeTierFor(bad), 'gated', `${String(bad)} must not open a route`);
    }

    // Every real nav item lands on the tier its own minRole implies.
    for (const item of allNavItems()) {
      assert.equal(
        routeTierFor(item.minRole),
        item.minRole === 'user' ? 'open' : 'gated',
        `${item.path} would be wrapped by the wrong renderer`,
      );
    }

    // And App.jsx delegates to it rather than restating the condition.
    assert.match(stripComments(read(APP)), /routeTierFor\(item\.minRole\)/);
  });
});

describe('Stage 0 — the session refreshes without a caller remembering to ask', () => {
  it('changing the stored key notifies listeners', () => {
    const src = stripComments(read(AUTH));
    assert.match(
      src,
      /dispatchEvent/,
      'setApiKey / clearApiKey must announce the change so the session refetches. '
      + 'Requiring LoginPage to call refresh() by hand is the kind of reminder that '
      + 'gets dropped — the project rule is to enforce with logic, not memory',
    );
  });

  it('the session listens for that notification', () => {
    const src = stripComments(read(SESSION));
    assert.match(src, /addEventListener/, 'the session must subscribe to key changes');
  });

  // v1.26.46, from code review. Executed, not read: this is about what is left behind in
  // storage, and only running it can tell you.
  it('logout clears the legacy console credential too, so logout means logout', async () => {
    // A Map-backed stub is enough. auth.js touches nothing else browser-only at module
    // scope, and its window.dispatchEvent is already guarded for a missing window.
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    try {
      const auth = await import('../client/src/api/auth.js');
      const { LEGACY_STORAGE_KEYS } = await import('../client/src/api/legacy-keys.js');

      auth.setApiKey('a-real-key');
      auth.setMustChangePassword(true);
      // Stand in for having followed a signpost, which writes exactly these four.
      for (const key of Object.values(LEGACY_STORAGE_KEYS)) store.set(key, 'x');
      assert.equal(store.size, 6, 'precondition: both consoles hold state');

      auth.clearApiKey();

      // The defect this covers: the signpost writes a usable om_api_key, and logout used
      // to clear only the console's own key. The next person to open /admin/ in that
      // browser was restored as the previous user by its restoreSession() IIFE, holding a
      // key every adminAuth route accepts.
      for (const [name, key] of Object.entries(LEGACY_STORAGE_KEYS)) {
        assert.equal(
          store.has(key), false,
          `logout left ${name} (${key}) behind, so the old console can still restore that session`,
        );
      }
      assert.equal(auth.getApiKey(), null);
      assert.equal(auth.getMustChangePassword(), false);
      assert.equal(store.size, 0, 'nothing at all should survive logout');
    } finally {
      delete globalThis.localStorage;
    }
  });
});

describe('Stage 0 — the role simulator is gone', () => {
  it('TopBar no longer lets anyone change their own role client-side', () => {
    const src = stripComments(read(TOPBAR));
    assert.doesNotMatch(
      src,
      /onRoleChange/,
      'the role simulator mutated currentRole in the browser. Once the role is '
      + 'server-sourced it is either dead or actively misleading',
    );
    assert.doesNotMatch(src, /role_simulator/, 'the role simulator label is still referenced');
  });

  it('the removed simulator leaves no dangling locale keys', () => {
    for (const loc of ['zh', 'en', 'ja']) {
      const dict = JSON.parse(read(`client/src/i18n/${loc}.json`));
      assert.ok(
        !('header.role_simulator' in dict),
        `${loc}.json still carries header.role_simulator`,
      );
    }
  });

  it('the profile menu points at routes that exist instead of a callback', () => {
    const src = stripComments(read(TOPBAR));
    assert.doesNotMatch(
      src,
      /onOpenProfile/,
      'onOpenProfile had two call sites with different arguments and no implementation. '
      + 'The console already has /preference/* routes, so the menu should navigate there',
    );
    assert.match(src, /\/preference\/profile/, 'the menu must link to the profile route');
  });
});

// The role ladder itself, executed rather than read. This is the only part of Stage 0
// that can be genuinely unit-tested without a render harness, which is why it was
// split out of SessionContext.jsx into a plain module.
describe('Stage 0 — the role ladder', () => {
  it('lets each role through its own tier and below', async () => {
    const { roleAtLeast } = await import('../client/src/session/roles.js');
    assert.equal(roleAtLeast('user', 'user'), true);
    assert.equal(roleAtLeast('admin', 'user'), true);
    assert.equal(roleAtLeast('admin', 'admin'), true);
    assert.equal(roleAtLeast('super_admin', 'user'), true);
    assert.equal(roleAtLeast('super_admin', 'admin'), true);
    assert.equal(roleAtLeast('super_admin', 'super_admin'), true);
  });

  it('blocks every role from tiers above it', async () => {
    const { roleAtLeast } = await import('../client/src/session/roles.js');
    assert.equal(roleAtLeast('user', 'admin'), false);
    assert.equal(roleAtLeast('user', 'super_admin'), false);
    assert.equal(roleAtLeast('admin', 'super_admin'), false);
  });

  it('fails closed on a missing or unknown role', async () => {
    const { roleAtLeast } = await import('../client/src/session/roles.js');
    for (const bad of [null, undefined, '', 'guest', 'SUPER_ADMIN', 'owner', 0, {},
      'valueOf', 'toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      assert.equal(roleAtLeast(bad, 'user'), false, `${JSON.stringify(bad)} must not clear the lowest bar`);
    }
  });

  it('fails closed on an unknown requirement, so a typo in a guard denies everyone', async () => {
    const { roleAtLeast } = await import('../client/src/session/roles.js');
    for (const typo of ['superadmin', 'super-admin', 'Admin', 'root', undefined,
      'valueOf', 'toString', 'constructor']) {
      assert.equal(roleAtLeast('super_admin', typo), false,
        `min=${JSON.stringify(typo)} must not admit anyone — a guard that silently opens is worse than one that blocks`);
    }
  });

  it('the ladder covers exactly the roles the server can return', async () => {
    const { ROLE_RANK } = await import('../client/src/session/roles.js');
    assert.deepEqual(Object.keys(ROLE_RANK).sort(), ['admin', 'super_admin', 'user']);
  });
});

// The gate decision, executed. This suite exists because two earlier attempts at covering
// it did not: first a source-text assertion that "ready" appeared before "<Navigate>"
// (which passes for a guard checking role first), then extracting decideRoleGate without
// actually testing it. A mutation that reordered the two checks — the exact defect review
// found — passed 23 green tests. Only running the function catches it.
describe('Stage 0 — the route-gate decision', () => {
  const load = () => import('../client/src/session/roles.js');

  it('waits while the identity is unresolved, whatever the role looks like', async () => {
    const { decideRoleGate } = await load();
    for (const role of [null, undefined, 'user', 'admin', 'super_admin']) {
      assert.equal(
        decideRoleGate({ ready: false, role, min: 'admin' }), 'wait',
        `an unresolved session with role=${JSON.stringify(role)} must wait, never decide`,
      );
    }
  });

  it('an unresolved session is never denied, which is the whole point of the ordering', async () => {
    const { decideRoleGate } = await load();
    // This is the assertion that catches the reordering. Before the identity arrives, a
    // legitimate admin is indistinguishable from a role-less visitor; deciding here sends
    // them away from the page they asked for and they never come back to it.
    assert.notEqual(
      decideRoleGate({ ready: false, role: null, min: 'super_admin' }), 'deny',
      'readiness must be checked before the role, or every deep link bounces',
    );
  });

  it('denies a resolved session whose role is too low', async () => {
    const { decideRoleGate } = await load();
    assert.equal(decideRoleGate({ ready: true, role: 'user', min: 'admin' }), 'deny');
    assert.equal(decideRoleGate({ ready: true, role: 'admin', min: 'super_admin' }), 'deny');
    assert.equal(decideRoleGate({ ready: true, role: null, min: 'user' }), 'deny');
  });

  it('allows a resolved session at or above the bar', async () => {
    const { decideRoleGate } = await load();
    assert.equal(decideRoleGate({ ready: true, role: 'admin', min: 'admin' }), 'allow');
    assert.equal(decideRoleGate({ ready: true, role: 'super_admin', min: 'admin' }), 'allow');
    assert.equal(decideRoleGate({ ready: true, role: 'user', min: 'user' }), 'allow');
  });

  it('returns only the three documented outcomes', async () => {
    const { decideRoleGate } = await load();
    const seen = new Set();
    for (const ready of [true, false]) {
      for (const role of [null, 'user', 'admin', 'super_admin', 'valueOf']) {
        for (const min of ['user', 'admin', 'super_admin', 'typo']) {
          seen.add(decideRoleGate({ ready, role, min }));
        }
      }
    }
    assert.deepEqual([...seen].sort(), ['allow', 'deny', 'wait']);
  });
});

// Both halves of a cross-layer event must agree on the name. They were two independent
// string literals, and the covering tests only checked that dispatchEvent and
// addEventListener appeared somewhere — so a one-character typo would silently disable
// the refresh while the suite stayed green.
describe('Stage 0 — the event contract is shared, not copied', () => {
  it('the names live in one module', async () => {
    const { SESSION_CHANGED, AUTH_EXPIRED } = await import('../client/src/api/events.js');
    assert.equal(SESSION_CHANGED, 'ownmind:session-changed');
    assert.equal(AUTH_EXPIRED, 'ownmind:auth-expired');
  });

  it('no file hardcodes an event name any more', () => {
    for (const f of [AUTH, SESSION, APP, 'client/src/api/client.js']) {
      const src = stripComments(read(f));
      assert.doesNotMatch(src, /'ownmind:(session-changed|auth-expired)'/,
        `${f} still hardcodes an event name instead of importing the constant`);
    }
  });

  it('both writes to the credential announce the change', () => {
    const src = stripComments(read(AUTH));
    for (const fn of ['setApiKey', 'clearApiKey']) {
      const at = src.indexOf(`export function ${fn}`);
      assert.ok(at !== -1, `${fn} is missing`);
      const body = src.slice(at, src.indexOf('\nexport function', at + 10));
      assert.match(body, /notifySessionChanged\(\)/,
        `${fn} must announce the change, or the session goes stale after it runs`);
    }
  });
});

// Nothing in this repo guarded locale parity, and the tri-language sync rule is a project
// standard. Removing a key from one file and not the others would have gone unnoticed.
describe('Stage 0 — the three locale dictionaries stay parallel', () => {
  const dicts = () => ['zh', 'en', 'ja'].map((l) => [l, JSON.parse(read(`client/src/i18n/${l}.json`))]);

  it('every locale has exactly the same key set', () => {
    const [[, base]] = dicts();
    const baseKeys = Object.keys(base).sort();
    for (const [loc, dict] of dicts()) {
      assert.deepEqual(Object.keys(dict).sort(), baseKeys,
        `${loc}.json has a different key set from zh.json`);
    }
  });

  it('the keys removed with the role simulator are gone from all three', () => {
    for (const [loc, dict] of dicts()) {
      for (const dead of ['header.role_simulator', 'menu.preferences']) {
        assert.ok(!(dead in dict), `${loc}.json still carries ${dead}`);
      }
    }
  });

  it('no value is empty, so a removal never leaves a blank label', () => {
    for (const [loc, dict] of dicts()) {
      for (const [k, v] of Object.entries(dict)) {
        assert.ok(typeof v === 'string' && v.trim() !== '', `${loc}.json has an empty value for ${k}`);
      }
    }
  });
});
