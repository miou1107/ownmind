import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageHookHome } from './helpers/hook-home.js';

import { renderHookContextLine, HOOK_CONTEXT_TYPES, TRIGGER_LABELS, tallyHookContext } from '../shared/hook-context.js';
import { ruleMatchesTrigger } from '../shared/helpers.js';

/**
 * issue #94 — the reminder could only ever speak about iron rules.
 *
 * Both hooks fetched `/api/memory/type/iron_rule` and nothing else, so a user reading
 * `鐵律觸發（install）` could not tell "no team standard applies to this" from "team standards
 * were never looked at". Those are different facts and one of them is a defect, and the
 * display was structurally incapable of reporting which had happened.
 *
 * The end-to-end half runs the real `.sh` hook against a stub server, because the thing most
 * likely to break is not the rendering — it is the wiring: which URL is called, what happens
 * when that URL is not there, and whether a response nobody can read turns into silence.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const FULL_COUNTS = {
  team_standard: 7, iron_rule: 71, coding_standard: 3, principle: 2, profile: 0,
};

describe('issue #94 — the reminder lists every memory category', () => {
  describe('renderHookContextLine', () => {
    it('names all five categories, hardest-to-waive first', () => {
      const line = renderHookContextLine({ version: '9.9.9', trigger: 'edit', counts: FULL_COUNTS });
      assert.match(line, /\[OwnMind v9\.9\.9\] File edit · /);
      const order = HOOK_CONTEXT_TYPES.map(c => c.label);
      const positions = order.map(label => line.indexOf(label));
      assert.ok(positions.every(p => p >= 0), `every category must appear: ${line}`);
      assert.deepEqual([...positions].sort((a, b) => a - b), positions,
        'a team standard cannot be waived by one person and must not be the row that scrolls off');
    });

    it('prints a category at 0 rather than dropping it', () => {
      const line = renderHookContextLine({ version: '9.9.9', trigger: 'edit', counts: FULL_COUNTS });
      assert.match(line, /Preferences 0/,
        'the zero is the informative part — it separates "looked, found none" from "never asked"');
    });

    it('says nothing at all when every category is 0', () => {
      const counts = Object.fromEntries(HOOK_CONTEXT_TYPES.map(c => [c.type, 0]));
      assert.equal(renderHookContextLine({ version: '9.9.9', trigger: 'edit', counts }), '',
        'a reminder that appears with no content teaches people to stop reading it');
    });

    it('says what the user is doing, not what the trigger is called', () => {
      const line = renderHookContextLine({ version: '9.9.9', trigger: 'install', counts: FULL_COUNTS });
      // A user debugging an auth header saw `鐵律觸發（install）` under every curl and asked
      // what was being installed. Nothing was. The label is a phrase, not the internal name.
      assert.match(line, /Install \/ credentials/);
      assert.doesNotMatch(line.split('\n')[0], /\(install\)/);
    });

    it('offers a way to read the contents when asked to', () => {
      const withHowTo = renderHookContextLine({
        version: '9.9.9', trigger: 'deploy', counts: FULL_COUNTS, withHowTo: true,
      });
      assert.match(withHowTo, /ownmind_get/, 'a count with no way to expand it is a dead end');
      assert.equal(withHowTo.split('\n').length, 2);
    });
  });

  describe('the line is written once, in English, and translated on delivery', () => {
    // issue #94 asked for "英文原稿 + AI 轉述" — the route already used for the startup tip in
    // hooks/lib/render-session-context.js. v1.26.151 hard-coded Chinese instead, which ships
    // one language and calls it done; v1.26.152 is the correction.
    it('carries no hard-coded Chinese in the labels', () => {
      const han = /[一-鿿]/;
      for (const { type, label } of HOOK_CONTEXT_TYPES) {
        assert.doesNotMatch(label, han, `${type} must not pin one language into the source`);
      }
      for (const [trigger, label] of Object.entries(TRIGGER_LABELS)) {
        assert.doesNotMatch(label, han, `${trigger} must not pin one language into the source`);
      }
    });

    it('tells the model to translate it, and what must survive that', () => {
      const line = renderHookContextLine({ version: '9.9.9', trigger: 'edit', counts: FULL_COUNTS });
      assert.match(line, /translated into the language you are speaking/);
      // Without naming them, the numbers get paraphrased away — and the numbers are the whole
      // point, since they are what separates "looked, found none" from "never asked".
      assert.match(line, /Keep the counts and the version tag exactly as written/);
    });
  });

  describe('ruleMatchesTrigger — untagged rules', () => {
    const untagged = { title: 'a note with no trigger tags', tags: [] };

    it('still matches everything by default, which is the iron-rule contract', () => {
      assert.equal(ruleMatchesTrigger(untagged, 'commit'), true);
    });

    it('matches nothing when the caller asks for strict matching', () => {
      // Project notes and environment records carry no trigger tags, because nothing ever
      // asked them to. Under the default they would all arrive on every operation: measured
      // on one account, commit went 38 → 63 and install 13 → 38, all of it noise.
      assert.equal(ruleMatchesTrigger(untagged, 'commit', { untaggedMatchesAll: false }), false);
    });

    it('leaves a tagged rule alone either way', () => {
      const tagged = { title: 'a commit rule', tags: ['trigger:commit'] };
      assert.equal(ruleMatchesTrigger(tagged, 'commit', { untaggedMatchesAll: false }), true);
      assert.equal(ruleMatchesTrigger(tagged, 'deploy', { untaggedMatchesAll: false }), false);
    });
  });

  describe('tallyHookContext — what the endpoint answers', () => {
    const ROWS = [
      { type: 'iron_rule', code: 'IR-001', title: 'a tagged iron rule', tags: ['trigger:commit'] },
      { type: 'iron_rule', code: 'IR-002', title: 'an untagged iron rule', tags: [] },
      { type: 'iron_rule', code: 'IR-003', title: 'an edit rule', tags: ['trigger:edit'] },
      { type: 'team_standard', title: 'a commit standard', tags: ['trigger:commit'] },
      { type: 'team_standard', title: 'an untagged standard', tags: [] },
      { type: 'coding_standard', title: 'a commit coding standard', tags: ['trigger:commit'] },
      { type: 'principle', title: 'an untagged principle', tags: [] },
      { type: 'profile', title: 'an untagged preference', tags: [] },
      { type: 'project', title: 'a project note that must not be counted', tags: ['trigger:commit'] },
    ];

    it('counts every listed category and ignores the ones that are not behaviour', () => {
      const { counts } = tallyHookContext(ROWS, 'commit', ruleMatchesTrigger);
      assert.deepEqual(counts, {
        team_standard: 1, iron_rule: 2, coding_standard: 1, principle: 0, profile: 0,
      });
    });

    it('keeps untagged iron rules and drops untagged everything-else', () => {
      const { counts } = tallyHookContext(ROWS, 'commit', ruleMatchesTrigger);
      assert.equal(counts.iron_rule, 2, 'IR-001 by tag and IR-002 by the untagged contract');
      assert.equal(counts.team_standard, 1,
        'the untagged standard would otherwise appear in front of every operation');
      assert.equal(counts.principle, 0,
        'an untagged principle is not a statement about this particular commit');
    });

    it('sends iron rule titles and nothing else', () => {
      const { rules } = tallyHookContext(ROWS, 'commit', ruleMatchesTrigger);
      assert.deepEqual(rules.map(r => r.code), ['IR-001', 'IR-002']);
      // A few hundred titles in front of a command is a reminder people scroll past.
      assert.ok(rules.every(r => r.code !== undefined || r.title.includes('iron')),
        'only iron rules carry titles into the response');
    });

    it('never counts a type outside the five, whatever its tags say', () => {
      const { counts } = tallyHookContext(ROWS, 'commit', ruleMatchesTrigger);
      assert.equal(Object.hasOwn(counts, 'project'), false);
    });
  });

  describe('ownmind-render-context.js — which shape arrived', () => {
    /** Run the renderer over one response body, the way the shell hook does. */
    function render(body, trigger = 'deploy') {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(repoRoot, 'hooks', 'ownmind-render-context.js'), '9.9.9', trigger],
          { stdio: 'pipe' }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(body);
      });
    }

    it('renders the five-category line from the new shape', async () => {
      const r = await render(JSON.stringify({ data: {
        trigger: 'deploy', counts: FULL_COUNTS, rules: [{ code: 'IR-001', title: 'a deploy rule' }],
      } }));
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Team standards 7, Iron rules 71/);
      assert.match(r.stdout, /IR-001: a deploy rule/);
    });

    it('falls back to the old banner for the old shape, and filters it', async () => {
      // The old endpoint returns every iron rule and always left matching to its caller. The
      // shell used to do that inline, with its own copy of the alias table.
      const r = await render(JSON.stringify({ data: [
        { code: 'IR-001', title: 'a deploy rule', tags: ['trigger:deploy'] },
        { code: 'IR-002', title: 'an edit rule', tags: ['trigger:edit'] },
      ] }));
      assert.equal(r.status, 0);
      assert.match(r.stdout, /鐵律觸發（deploy）/);
      assert.match(r.stdout, /IR-001/);
      assert.doesNotMatch(r.stdout, /IR-002/, 'an edit rule has nothing to say about a deploy');
      assert.doesNotMatch(r.stdout, /Team standards/,
        'four zeroes would claim those categories were consulted, and they were not');
    });

    it('reports a body in neither shape instead of printing nothing', async () => {
      const r = await render(JSON.stringify({ error: 'boom' }));
      assert.equal(r.status, 1, 'silence here is indistinguishable from "no rules apply"');
      assert.equal(r.stdout.trim(), '', 'nothing wrong may reach Claude Code');
      assert.match(r.stderr, /unrecognised response shape/);
    });

    it('stays quiet when the new shape genuinely matched nothing', async () => {
      const counts = Object.fromEntries(HOOK_CONTEXT_TYPES.map(c => [c.type, 0]));
      const r = await render(JSON.stringify({ data: { trigger: 'deploy', counts, rules: [] } }));
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '');
    });
  });

  describe('hooks/ownmind-iron-rule-check.sh — end to end', () => {
    let server;
    let baseUrl;
    let tmpHome;
    let hits;
    let hookContextStatus;

    before(async () => {
      hits = [];
      hookContextStatus = 200;
      server = http.createServer((req, res) => {
        hits.push(req.url);
        if (req.url.includes('/api/memory/hook-context')) {
          if (hookContextStatus !== 200) {
            res.writeHead(hookContextStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: {
            trigger: 'deploy',
            counts: FULL_COUNTS,
            rules: [{ code: 'IR-001', title: 'a rule about deploying' }],
          } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { code: 'IR-OLD', title: 'the legacy listing', tags: ['trigger:command'] },
        ] }));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      tmpHome = stageHookHome({ apiUrl: baseUrl });
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    function run(command) {
      const before = hits.length;
      return new Promise((resolve, reject) => {
        const child = spawn('bash', [path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh')], {
          cwd: repoRoot,
          env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
          stdio: 'pipe',
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', reject);
        // Memory lookups only. The hook also flushes its activity log to /api/activity/batch,
        // and counting those would make "one round trip" mean something other than what this
        // test is asserting.
        child.on('close', (status) => resolve({
          status, stdout, stderr,
          urls: hits.slice(before).filter((u) => u.includes('/api/memory/')),
        }));
        child.stdin.end(JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
        }));
      });
    }

    it('asks for all five categories in one request', async () => {
      hookContextStatus = 200;
      const r = await run('docker compose up -d');
      assert.equal(r.status, 0, 'a hook must never fail the command it inspects');
      assert.equal(r.urls.length, 1,
        `one round trip, not five: this sits in front of every risky command. urls=${r.urls}`);
      assert.match(r.urls[0], /\/api\/memory\/hook-context\?trigger=deploy/);
      assert.match(r.stdout, /Team standards 7, Iron rules 71, Coding standards 3, Working principles 2, Preferences 0/);
    });

    it('falls back to the old endpoint against a server that lacks the new one', async () => {
      hookContextStatus = 404;
      const r = await run('docker compose up -d');
      assert.equal(r.status, 0);
      assert.equal(r.urls.length, 2, 'the new URL first, then the one every server has');
      assert.match(r.urls[1], /\/api\/memory\/type\/iron_rule/);
      assert.match(r.stdout, /IR-OLD/,
        'a hook that only knew the new URL would go silent, and silence reads as "no rules"');
      assert.doesNotMatch(r.stdout, /Team standards/);
    });

    it('records the fallback rather than degrading quietly forever', async () => {
      hookContextStatus = 404;
      fs.rmSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true, force: true });
      await run('docker compose up -d');
      const dir = path.join(tmpHome, '.ownmind', 'logs');
      const events = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.event === 'hook_context_fallback'),
        `a permanent fallback that never says so looks exactly like normal. events=${JSON.stringify(events)}`);
    });
  });
});
