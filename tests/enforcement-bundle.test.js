import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { buildBundle, createEnforcementBundleRouter } from '../src/routes/enforcement-bundle.js';
import { startServer } from './helpers/app-server.js';

/**
 * The bundle is what lets the client decide two things without asking the server: is
 * anything relevant to this turn, and is this file off limits.
 *
 * Its shape is load-bearing in a way that is easy to get wrong quietly. The client reads
 * flat fields; the database row nests them under `metadata.enforcement`. A client function
 * written against the nested shape matches nothing on a real machine and everything in a
 * test that hands it a hand-built row. So the rule these tests hold: what `buildBundle`
 * emits is the only shape any client-side consumer may read, and the consumers' own tests
 * are fed from this function rather than from fixtures written by hand.
 */

const ROWS = [
  {
    id: 412,
    type: 'team_standard',
    title: 'ci ownership belongs to Eric',
    content: 'The /ci directory is maintained by Eric. No other engineer may modify it.',
    tags: ['trigger:ci'],
    metadata: {
      enforcement: {
        keywords: ['FAPA', 'onboarding'],
        guard: {
          repo_match: 'fontrip-agentic-process-automation',
          paths: ['ci/**', '.gitlab-ci.yml'],
          owner: 'Eric',
        },
      },
    },
  },
  {
    id: 125,
    type: 'iron_rule',
    code: 'IR-125',
    title: 'conclusion first',
    content: 'Talk to the owner conclusion-first.',
    tags: ['trigger:always'],
    metadata: { enforcement: { always_check: true } },
  },
  {
    id: 7,
    type: 'iron_rule',
    code: 'IR-007',
    title: 'a rule nobody annotated',
    content: 'Some rule with no enforcement block at all.',
    tags: ['trigger:edit'],
    metadata: {},
  },
];

test('selectors carry every rule, including the ones nobody annotated', () => {
  // The instruction was "all rules". A design that only considered annotated rules would
  // cover two of a hundred and fifty on day one, and the metric that should have shown it
  // ("nothing was selected") looks exactly like a quiet, healthy turn.
  const { selectors } = buildBundle(ROWS);
  assert.deepEqual(selectors.map((s) => s.id).sort((a, b) => a - b), [7, 125, 412]);
});

test('selectors carry no rule text', () => {
  const { selectors } = buildBundle(ROWS);
  for (const s of selectors) {
    assert.equal(s.content, undefined, 'rule text stays on the server, where the judge is');
    assert.ok(JSON.stringify(s).length < 400, `selector for ${s.id} is too big to ship per rule`);
  }
});

test('selectors are flat: no metadata wrapper survives', () => {
  const { selectors } = buildBundle(ROWS);
  const s412 = selectors.find((s) => s.id === 412);
  assert.equal(s412.metadata, undefined);
  assert.deepEqual(s412.keywords, ['FAPA', 'onboarding']);
  assert.equal(s412.repo_match, 'fontrip-agentic-process-automation');
  assert.equal(selectors.find((s) => s.id === 125).always_check, true);
});

test('tags survive, because selection has to work for un-annotated rules', () => {
  const { selectors } = buildBundle(ROWS);
  assert.deepEqual(selectors.find((s) => s.id === 7).tags, ['trigger:edit']);
});

test('guards carry only the rules with a usable path list', () => {
  const { guards } = buildBundle(ROWS);
  assert.deepEqual(guards.map((g) => g.id), [412]);
  assert.deepEqual(guards[0].paths, ['ci/**', '.gitlab-ci.yml']);
  assert.equal(guards[0].owner, 'Eric');
  assert.equal(guards[0].metadata, undefined, 'the guard consumer reads flat fields');
});

test('a guard block with an empty path list is not a guard', () => {
  const { guards } = buildBundle([{
    id: 9, type: 'team_standard', title: 'x', tags: [],
    metadata: { enforcement: { guard: { repo_match: 'r', paths: [], owner: 'e' } } },
  }]);
  assert.deepEqual(guards, [], 'a guard that can never match should not claim it guards');
});

test('a rule carrying gate metadata ships as an action guard', async () => {
  const ruleText = 'Deploys must use docker compose build --no-cache.';
  const rule = {
    id: 918, type: 'iron_rule', title: 'compose only, no cache',
    content: ruleText,
    metadata: { enforcement: { gate: {
      triggers: ['deploy'],
      checks: [
        { type: 'must_not_match', pattern: '(^|\\s)docker\\s+build(\\s|$)', reason: 'use docker compose build, never bare docker build (IR-023)' },
        { type: 'must_match', pattern: '--no-cache', reason: 'docker builds must carry --no-cache (IR-018)' },
      ],
      read_required: true, ask_first: false,
      applies_pattern: 'docker\\s+compose|git\\s+push\\b.*\\s(refs/tags/)?v\\d',
    } } },
  };
  const { guards } = buildBundle([rule]);
  assert.equal(guards.length, 1);
  // The whole object, not a subset. This shape is the cross-task contract the client gate
  // keys on; a field that silently disappears or changes type must fail this suite.
  assert.deepEqual(guards[0], {
    id: 918,
    title: 'compose only, no cache',
    kind: 'action',
    triggers: ['deploy'],
    // Verbatim - the server does not validate the regex. The client treats an invalid
    // pattern as "guard fires" (Amendment 1), so mangling it here could only widen firing.
    applies_pattern: 'docker\\s+compose|git\\s+push\\b.*\\s(refs/tags/)?v\\d',
    checks: [
      { type: 'must_not_match', pattern: '(^|\\s)docker\\s+build(\\s|$)', reason: 'use docker compose build, never bare docker build (IR-023)' },
      { type: 'must_match', pattern: '--no-cache', reason: 'docker builds must carry --no-cache (IR-018)' },
    ],
    read_required: true,
    ask_first: false,
    rule_text: ruleText,
    // Computed from the expected text, not from the guard's own rule_text - hashing what
    // the guard shipped would pass even if the wrong string were shipped and hashed.
    rules_hash: createHash('sha256').update(ruleText).digest('hex'),
  });
});

test('a gate without applies_pattern ships a guard without the key', () => {
  // Omitted means omitted - not null, not ''. The client distinguishes "no scoping
  // pattern, fire on every trigger match" by the key's absence, and a shipped empty
  // string would read as a pattern that matches everything anyway but through the
  // invalid-regex fallback, which logs as a data problem.
  const gates = [
    {}, // no applies_pattern at all
    { applies_pattern: '' }, // empty string is not a pattern
    { applies_pattern: 42 }, // non-string is not a pattern
  ];
  for (const extra of gates) {
    const { guards } = buildBundle([{
      id: 30, type: 'iron_rule', title: 't', content: 'x', tags: [],
      metadata: { enforcement: { gate: { triggers: ['deploy'], checks: [], ...extra } } },
    }]);
    assert.equal(guards.length, 1);
    assert.ok(!('applies_pattern' in guards[0]),
      `applies_pattern ${JSON.stringify(extra)} must not ship as a key`);
  }
});

test('a gate marked ask_mode verbal ships ask_mode on the action guard', () => {
  // Amendment 3: Vin chose a spoken "go" over pasting a 6-digit code for ask_first guards.
  // The choice is carried as data (ask_mode: 'verbal'); the client gate reads it to decide
  // whether the block asks for a code or a go-ahead. Only the explicit 'verbal' value ships.
  const { guards } = buildBundle([{
    id: 819, type: 'iron_rule', title: 'deploys ask first', content: 'Ask before deploying.',
    tags: [],
    metadata: { enforcement: { gate: {
      triggers: ['deploy'], checks: [], read_required: true, ask_first: true, ask_mode: 'verbal',
    } } },
  }]);
  assert.equal(guards.length, 1);
  assert.equal(guards[0].ask_first, true);
  assert.equal(guards[0].ask_mode, 'verbal', 'a verbal gate must ship ask_mode: verbal');
});

test('a gate with no verbal ask_mode ships no ask_mode key (default code)', () => {
  // Omitted, 'code', and any non-'verbal' value all mean the same thing on the wire: no key,
  // the client defaults to code mode. Shipping ask_mode: 'code' would be redundant noise and
  // a second value the client would have to special-case.
  const variants = [
    {}, // absent
    { ask_mode: 'code' }, // explicit default
    { ask_mode: 'spoken' }, // unknown value is not 'verbal'
    { ask_mode: 42 }, // non-string
  ];
  for (const extra of variants) {
    const { guards } = buildBundle([{
      id: 40, type: 'iron_rule', title: 't', content: 'x', tags: [],
      metadata: { enforcement: { gate: { triggers: ['deploy'], checks: [], ask_first: true, ...extra } } },
    }]);
    assert.equal(guards.length, 1);
    assert.ok(!('ask_mode' in guards[0]),
      `ask_mode ${JSON.stringify(extra)} must not ship as a key`);
  }
});

test('malformed gate metadata is skipped without crashing the bundle', () => {
  // A gate with no triggers can never fire; a checks field that is not an array must not
  // throw halfway through the route. Both degrade to "no action guard", not to a 500.
  const { guards } = buildBundle([
    { id: 20, type: 'iron_rule', title: 'no triggers', content: 'x', tags: [],
      metadata: { enforcement: { gate: { checks: [{ type: 'must_match', pattern: 'y', reason: 'z' }] } } } },
    { id: 21, type: 'iron_rule', title: 'bad checks', content: 'x', tags: [],
      metadata: { enforcement: { gate: { triggers: ['deploy'], checks: 'not-an-array' } } } },
    // Non-string trigger entries filter out; a list that filters to nothing is no gate at
    // all. Emitting it would ship a guard with triggers: [] - one that can never fire.
    { id: 22, type: 'iron_rule', title: 'non-string triggers', content: 'x', tags: [],
      metadata: { enforcement: { gate: { triggers: [42], checks: [] } } } },
  ]);
  assert.deepEqual(guards.map((g) => g.id), [21], 'a gate whose triggers filter to nothing can never fire');
  assert.deepEqual(guards[0].checks, [], 'a non-array checks field degrades to no checks');
});

test('injectables carry their type, because it decides the precedence sentence', () => {
  // A team standard belongs to the company and the user cannot waive it; their own iron rule
  // they can. Without the type the client cannot tell those apart, and the difference is the
  // whole reason the sentence exists.
  const { injectables } = buildBundle(ROWS);
  assert.equal(injectables.find((i) => i.id === 412).type, 'team_standard');
  assert.equal(injectables.find((i) => i.id === 125).type, 'iron_rule');
});

test('injectables carry text, and only for annotated rules', () => {
  // Injection puts the rule in front of the AI before it starts. A title with an empty body
  // would tell it to obey something it cannot read, so text has to reach the client for
  // these - bounded by how many rules carry an enforcement block, not by how many exist.
  const { injectables } = buildBundle(ROWS);
  assert.deepEqual(injectables.map((i) => i.id).sort((a, b) => a - b), [125, 412]);
  assert.match(injectables.find((i) => i.id === 412).content, /maintained by Eric/);
});

test('an injectable exposes its paths and owner flat, for the precedence header', () => {
  const { injectables } = buildBundle(ROWS);
  const i412 = injectables.find((i) => i.id === 412);
  assert.deepEqual(i412.paths, ['ci/**', '.gitlab-ci.yml']);
  assert.equal(i412.owner, 'Eric');
});

test('an empty row set yields three empty lists rather than throwing', () => {
  const { selectors, guards, injectables } = buildBundle([]);
  assert.deepEqual([selectors, guards, injectables], [[], [], []]);
});

test('a row with null metadata does not crash the bundle', () => {
  const { selectors, guards } = buildBundle([{ id: 1, type: 'iron_rule', title: 't', tags: null, metadata: null }]);
  assert.equal(selectors.length, 1);
  assert.deepEqual(selectors[0].tags, []);
  assert.deepEqual(guards, []);
});

test('the endpoint answers on its real mounted path, not through GET /:id', async () => {
  // `/api/memory/:id` is registered in the same router. Mounted after it, this endpoint gets
  // handed its own name as an id, the integer cast fails, and the client sees a 500 it can
  // only read as "the server is broken" - so the cache never fills and nothing says why.
  const rowsForRoute = ROWS;
  const queryFn = async () => ({ rows: rowsForRoute });

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  const memoryLike = express.Router();
  memoryLike.use('/enforcement-bundle', createEnforcementBundleRouter({ queryFn }));
  // Registered after, exactly as it is in the real router, to prove ordering is what saves us.
  memoryLike.get('/:id', (_req, res) => res.status(500).json({ error: 'Query failed' }));
  app.use('/api/memory', memoryLike);

  const server = await startServer(app);
  try {
    const res = await fetch(`${server.url}/api/memory/enforcement-bundle`);
    assert.equal(res.status, 200, 'a 500 here means /:id swallowed the request');
    const body = await res.json();
    assert.ok(Array.isArray(body.selectors));
    assert.ok(Array.isArray(body.guards));
    assert.ok(Array.isArray(body.injectables));
    assert.deepEqual(body.guards.map((g) => g.id), [412]);
  } finally {
    await server.close();
  }
});

test('a database failure is a 500, not an empty bundle', async () => {
  // An empty bundle would be indistinguishable from "this account has no rules", and the
  // client's empty-response guard would then keep a stale cache forever without telling
  // anyone. Better to fail out loud and let the client keep what it has, knowingly.
  const queryFn = async () => { throw new Error('connection refused'); };
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/memory/enforcement-bundle', createEnforcementBundleRouter({ queryFn }));

  const server = await startServer(app);
  try {
    const res = await fetch(`${server.url}/api/memory/enforcement-bundle`);
    assert.equal(res.status, 500);
  } finally {
    await server.close();
  }
});
