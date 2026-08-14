// v1.26.173 — the background update's outcome gets a delivery path again.
//
// v1.26.129 gave the detached updater a way to say what it did. v1.26.171 removed the
// SessionStart flush that was supposed to print it — correctly, because SessionStart stdout
// is read by the model rather than the user, and the flush erased the audit record on its
// way out. Nobody noticed that this was the one notice with no other delivery path: it is
// produced by a child that outlives its session, so there is no turn left to attach it to.
// Between those two versions, a failed update was written to a file nobody reads.
//
// These tests run the Stop hook as a program. What only that can show is whether a queued
// outcome actually reaches stdout, and whether the queue is drained afterwards — the two
// halves that a unit test of the queue module cannot see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');

const queueFile = (home) => path.join(home, '.ownmind', 'logs', 'update-pending.jsonl');

/** A staged $HOME with a transcript the hook will read, and optionally a queued outcome. */
function stageHome({ queued = [] } = {}) {
  const home = tempDir('om-update-notice-');
  fs.mkdirSync(path.join(home, '.ownmind', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ownmind', 'state'), { recursive: true });

  // No credentials on purpose: this notice must not depend on the machine being able to
  // reach the server. A failed update is exactly the situation where it might not.
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'do the thing' } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done' }] },
    }),
    '',
  ].join('\n'));

  if (queued.length) {
    fs.writeFileSync(
      queueFile(home),
      queued.map((block) => JSON.stringify({ block, source: 'auto_update' })).join('\n') + '\n',
    );
  }
  return { home, transcript };
}

function runHook({ home, transcript }) {
  try {
    const stdout = execFileSync('node', [HOOK], {
      input: JSON.stringify({
        session_id: 'update-notice-test',
        transcript_path: transcript,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OWNMIND_REPLY_LINT_NO_NETWORK: '1',
      },
      timeout: 30_000,
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? -1, stdout: String(err.stdout ?? '') };
  }
}

test('a queued update failure reaches the user as systemMessage JSON on stdout', () => {
  const { home, transcript } = stageHome({
    queued: ['【OwnMind】ownmind 自動更新失敗：拉新版失敗（本機檔案可能被改過）。\n要不要我幫你回報給管理者？'],
  });
  const result = runHook({ home, transcript });
  assert.equal(result.status, 0);
  // Parsed with the real parser, not matched with a regex: Claude Code will do the same, and
  // stdout that is almost-JSON renders nothing at all.
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.systemMessage, /自動更新失敗/);
  assert.match(parsed.systemMessage, /回報/);
});

test('the queue is drained once the notice has gone out', () => {
  const { home, transcript } = stageHome({ queued: ['【OwnMind v9.9.9】已經自動更新到 9.9.9 版'] });
  assert.ok(fs.existsSync(queueFile(home)));
  runHook({ home, transcript });
  assert.ok(!fs.existsSync(queueFile(home)),
    'a delivered outcome must not be shown again on every later turn');
});

test('two queued outcomes both survive to the screen', () => {
  // A machine that failed to update for two days running has two records waiting. Draining
  // by position rather than by "the file existed" is what keeps the older one.
  const { home, transcript } = stageHome({
    queued: ['【OwnMind】ownmind 自動更新失敗：連不上 GitHub。', '【OwnMind v9.9.9】已經自動更新到 9.9.9 版'],
  });
  const parsed = JSON.parse(runHook({ home, transcript }).stdout);
  assert.match(parsed.systemMessage, /連不上 GitHub/);
  assert.match(parsed.systemMessage, /9\.9\.9/);
});

test('an empty queue says nothing about updates', () => {
  // Silence has to keep meaning "nothing happened". This is the control for the tests above:
  // without it they would still pass if the hook narrated an update on every single turn.
  const { home, transcript } = stageHome();
  const { stdout } = runHook({ home, transcript });
  if (stdout.trim() !== '') {
    assert.doesNotMatch(JSON.parse(stdout).systemMessage || '', /自動更新/);
  }
});

test('the outcome is written back to the audit spool as it is delivered', () => {
  // The queue is drained, so the record has to survive somewhere. banner-pending.jsonl is
  // append-only and is that somewhere; queueUserNotice writes it on the way past.
  const { home, transcript } = stageHome({ queued: ['【OwnMind】ownmind 自動更新失敗：磁碟滿了。'] });
  runHook({ home, transcript });
  const spool = fs.readFileSync(path.join(home, '.ownmind', 'logs', 'banner-pending.jsonl'), 'utf8');
  assert.match(spool, /自動更新失敗/);
});
