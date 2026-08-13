import { test } from 'node:test';
import assert from 'node:assert/strict';
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
