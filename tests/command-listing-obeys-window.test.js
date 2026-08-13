import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.26.161 — the window that only half closed.
 *
 * v1.26.154 gave the command path an hourly window. `ownmind-render-context.js` computes
 * `listing` from it and then uses that value for exactly one thing: whether the names ride
 * along inside the counts line. The ⚠️ block below is guarded by `rules.length > 0` and
 * nothing else, so it printed in front of every command that matched anything.
 *
 * Measured before the fix, on a real session: two `gh issue comment` calls a minute apart, the
 * second one correctly withholding the names from the counts line and then printing the same
 * nine rules underneath it anyway. A throttle that reports success while the thing it throttles
 * goes past it is the exact failure mode these hooks keep being rewritten to remove — it is
 * worse than no throttle, because no throttle is visible.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const RENDERER = path.join(repoRoot, 'hooks', 'ownmind-render-context.js');

const RULES = [
  { code: 'IR-018', title: 'Docker build 要加 --no-cache' },
  { code: 'IR-023', title: '部署必須用 docker compose build' },
  { code: 'IR-046', title: '跑超過 5 分鐘的背景任務必須用 nohup' },
];

/** A `/hook-context` response with something in three of the five categories. */
function body({ rules = RULES } = {}) {
  return JSON.stringify({
    data: {
      counts: { team_standard: 1, iron_rule: rules.length, coding_standard: 0, principle: 0, profile: 0 },
      totals: { team_standard: 32, iron_rule: 150, coding_standard: 33, principle: 92, profile: 14 },
      names: { team_standard: ['對外送出前先獨立審查'], iron_rule: rules.map(r => r.title) },
      rules,
    },
  });
}

/** Everything at zero — the shape that must print nothing and open no window. */
function emptyBody() {
  return JSON.stringify({
    data: {
      counts: { team_standard: 0, iron_rule: 0, coding_standard: 0, principle: 0, profile: 0 },
      totals: { team_standard: 32, iron_rule: 150, coding_standard: 33, principle: 92, profile: 14 },
      names: {},
      rules: [],
    },
  });
}

describe('v1.26.161 — the command listing obeys the window it already computes', () => {
  let home;
  let statePath;

  const render = (trigger, session, input = body()) => execFileSync(
    process.execPath,
    [RENDERER, '1.26.161', trigger, session],
    { input, encoding: 'utf8', env: { ...process.env, __OWNMIND_EDIT_REMINDER_PATH: statePath } },
  );

  const warningCount = (out) => out.split('⚠️').length - 1;

  beforeEach(() => {
    home = tempDir('ownmind-render-window-');
    statePath = path.join(home, 'edit-reminder.json');
  });

  after(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('the first command of the hour prints the counts line and the listing', () => {
    const out = render('send', 'session-A');

    assert.match(out, /Memories found:/, 'the counts line is the part that always goes out');
    assert.equal(warningCount(out), RULES.length, 'the first command is what the listing is for');
    assert.ok(fs.existsSync(statePath), 'showing the listing must open the window');
  });

  it('the second command of the same hour prints the counts line and NO listing', () => {
    render('send', 'session-A');
    const second = render('send', 'session-A');

    assert.match(second, /Memories found:/, 'the counts line is one line and still goes out');
    assert.equal(
      warningCount(second), 0,
      'the ⚠️ listing repeated in front of every command — that is the whole defect',
    );
  });

  it('the names stay out of the throttled counts line, as before', () => {
    render('send', 'session-A');
    const second = render('send', 'session-A');

    assert.doesNotMatch(
      second, /對外送出前先獨立審查/,
      'v1.26.154 behaviour, asserted here so fixing the listing cannot quietly undo it',
    );
  });

  it('a different trigger inside the same hour still gets its full listing', () => {
    render('send', 'session-A');
    const other = render('deploy', 'session-A');

    assert.equal(
      warningCount(other), RULES.length,
      'the window is keyed by trigger — a send must not silence a deploy',
    );
  });

  it('commit never prints the listing, window or no window', () => {
    const out = render('commit', 'session-A');

    assert.match(out, /Memories found:/);
    assert.equal(
      warningCount(out), 0,
      'v1.26.154 keeps commit to the counts line; the window fix must not turn that on',
    );
  });

  it('a different session inside the same hour still gets its full listing', () => {
    render('send', 'session-A');
    const other = render('send', 'session-B');

    assert.equal(warningCount(other), RULES.length, 'the audience of a listing is one session');
  });

  it('nothing matched: no output, and no window opened', () => {
    const out = render('send', 'session-A', emptyBody());

    assert.equal(out.trim(), '', 'five zeroes in front of an operation OwnMind has nothing to say about');
    assert.equal(
      fs.existsSync(statePath), false,
      'a window opened on an invisible listing would throttle the next real one',
    );
  });

  it('an expired window prints the listing again', () => {
    render('send', 'session-A');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const entry of Object.values(state.sessions)) {
      entry.window_start_ms -= (60 * 60 * 1000) + 1000;
    }
    fs.writeFileSync(statePath, JSON.stringify(state));

    const out = render('send', 'session-A');
    assert.equal(warningCount(out), RULES.length, 'the throttle is an hour, not a session');
  });
});
