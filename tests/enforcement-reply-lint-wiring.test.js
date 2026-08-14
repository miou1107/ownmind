import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');

/**
 * The compliance step, run through the hook as a program.
 *
 * The step's own decisions have unit tests. What only this file can show is whether the hook
 * reaches it at all, and whether it reaches it before the `stop_hook_active` early return -
 * which is what decides whether a reply the assistant produced *because* it was pushed back
 * gets examined, or whether one rejection buys a permanently unchecked turn.
 *
 * A previous draft of this wiring referenced a constant the hook does not have, inside a
 * catch that swallowed the ReferenceError. It would have shipped and never run once, so the
 * assertions here are about observable behaviour of the process, not about the source text.
 */

/** A staged $HOME with an enforcement cache and a transcript the hook will read. */
function stageHome({ assistantText, selectors, present = true }) {
  const home = tempDir('om-lint-wiring-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ownmind', 'state'), { recursive: true });
  if (present) {
    fs.writeFileSync(
      path.join(home, '.ownmind', 'cache', 'enforcement.json'),
      JSON.stringify({ selectors, guards: [], injectables: [] }),
    );
  }

  // Credentials, or the step stops at its own loud "no credentials" notice (v1.26.171)
  // before it ever reaches the bundle - and these tests are about the paths past that.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      ownmind: {
        env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: 'http://127.0.0.1:1/unreachable' },
      },
    },
  }));

  // Two lines, not one. A tail read can slice mid-line, so the reader discards whatever came
  // first - which on a one-line file is the only thing there. Real transcripts always have a
  // user turn ahead of the assistant's, so this matches them rather than working around them.
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'do the thing' } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: assistantText }] },
    }),
    '',
  ].join('\n'));

  return { home, transcript };
}

function runHook({ home, transcript, stopHookActive = false, env = {} }) {
  try {
    const stdout = execFileSync('node', [HOOK], {
      input: JSON.stringify({
        session_id: 'wiring-test',
        transcript_path: transcript,
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // Task 4 (hook message i18n) wired the compliance-step "not-checked" banners through
        // t(); this suite asserts /has not downloaded your rules yet/, /did not check the AI's reply/ (literal English), so the
        // locale is pinned defensively.
        OWNMIND_LOCALE_FORCE: 'en',
        ...env,
      },
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

/** Whatever the hook wrote to the terminal, which the fallback puts in a file. */
function bannerText(home) {
  const file = path.join(home, '.ownmind', 'logs', 'banner-pending.jsonl');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

test('the hook runs without a ReferenceError when nothing matches', () => {
  // The failure mode this whole file exists for: a name that does not exist, swallowed by a
  // catch, leaving a check that never runs and a suite that never notices.
  const { home, transcript } = stageHome({
    assistantText: 'the tests are green',
    selectors: [{ id: 1, keywords: ['nothing-like-this'], tags: [] }],
  });
  const result = runHook({ home, transcript });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /ReferenceError/);
});

test('a machine with no enforcement cache says the turn was not checked', () => {
  // Fresh install, offline, failed sync. Silence would read as "no rule applies", and the
  // difference is whether this machine is enforcing anything at all.
  const { home, transcript } = stageHome({
    assistantText: 'anything at all', selectors: [], present: false,
  });
  const result = runHook({ home, transcript });
  assert.equal(result.status, 0);
  assert.match(bannerText(home), /has not downloaded your rules yet/);
});

// v1.26.171 — the audit found every notice went to /dev/tty, which a hook can never open
// (no controlling terminal, any platform), and the fallback spool is read by nobody. The
// documented channel that renders on the user's screen is JSON stdout with `systemMessage`.
test('a not-checked notice reaches the user as systemMessage JSON on stdout', () => {
  const { home, transcript } = stageHome({
    assistantText: 'anything at all', selectors: [], present: false,
  });
  const result = runHook({ home, transcript });
  assert.equal(result.status, 0);
  // Parsed with the real parser, not matched with a regex: Claude Code will do the same,
  // and stdout that is almost-JSON renders nothing at all.
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.systemMessage, /has not downloaded your rules yet/);
  assert.match(parsed.systemMessage, /did not check the AI's reply/);
  // The spool remains as the audit record.
  assert.match(bannerText(home), /has not downloaded your rules yet/);
});

test('a quiet turn emits no stdout at all', () => {
  // An empty systemMessage would still render a blank line under every reply. Silence on a
  // clean turn has to stay byte-for-byte silent.
  const { home, transcript } = stageHome({
    assistantText: 'the tests are green',
    selectors: [{ id: 1, keywords: ['nothing-like-this'], tags: [] }],
  });
  const result = runHook({ home, transcript });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('the check runs even when this Stop came from a previous block', () => {
  // stop_hook_active is true on the rewrite. If the compliance step sat behind that early
  // return, the corrected reply would never be examined and one rejection would buy a
  // permanently unchecked turn.
  const { home, transcript } = stageHome({
    assistantText: 'still doing the forbidden thing',
    selectors: [], present: false,
  });
  const result = runHook({ home, transcript, stopHookActive: true });
  assert.equal(result.status, 0);
  assert.match(
    bannerText(home), /has not downloaded your rules yet/,
    'the compliance step did not run on a rewrite - it is behind the early return',
  );
});

test('an explicitly disabled hook does nothing at all, including this check', () => {
  // OWNMIND_REPLY_LINT_DISABLE exits at the top of main(), well before the compliance step.
  // That is the right behaviour - off means off - but it also means the step's own "disabled"
  // branch is unreachable from here, so this asserts what actually happens rather than what
  // the step would have said.
  const { home, transcript } = stageHome({
    assistantText: 'anything', selectors: [{ id: 1, always_check: true, tags: [] }],
  });
  const result = runHook({ home, transcript, env: { OWNMIND_REPLY_LINT_DISABLE: '1' } });
  assert.equal(result.status, 0);
  assert.equal(bannerText(home), '', 'a disabled hook must be silent, not merely quieter');
});

// v1.26.171 throttle (the user's call, 2026-08-14): state-shaped "NOT checked" notices
// announce on state change and every 10th turn, not under every reply. The alternative was
// outage-length spam, and the rational user response to that is switching the product off.
test('the same not-checked state speaks once, then goes quiet, but keeps its audit trail', () => {
  const { home, transcript } = stageHome({
    assistantText: 'anything at all', selectors: [], present: false,
  });
  const first = runHook({ home, transcript });
  assert.equal(first.status, 0);
  assert.match(JSON.parse(first.stdout).systemMessage, /has not downloaded your rules yet/);

  const second = runHook({ home, transcript });
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), '', 'the unchanged state must not repeat on the very next turn');

  const spool = bannerText(home);
  const mentions = spool.split('has not downloaded your rules yet').length - 1;
  assert.equal(mentions, 2, 'both turns must reach the audit spool, spoken or not');
});
