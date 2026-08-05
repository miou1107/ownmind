// v1.26.65 — "I found nothing" and "I could not look" must not produce the same line.
//
// Traced 2026-08-05 on a Windows machine of Vin's. Three consecutive scheduled
// scans logged `sent=0` for all five tools; a manual run minutes later sent 169
// events the server had never seen (`dup=0`). Same machine, same code, same
// credentials.
//
// defaultListJsonlFiles swallowed every error from readdir and returned an empty
// list, with a comment asserting an interpretation the code cannot actually make:
//
//     } catch { /* baseDir does not exist: clean env, return empty */ }
//
// A missing directory, a permission failure and a wrongly resolved home all came
// out as `sent=0`. That is why a dead collector looked healthy for twenty days.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { createClaudeCodeAdapter, defaultListJsonlFiles } =
  await import('../shared/scanners/claude-code.js');
const { createCodexAdapter } = await import('../shared/scanners/codex.js');

const TMP = path.join(os.tmpdir(), `ownmind-blind-${process.pid}-${Date.now()}`);

beforeEach(async () => { await fs.mkdir(TMP, { recursive: true }); });
afterEach(async () => {
  // Restore permissions first or the cleanup itself fails.
  try { await fs.chmod(path.join(TMP, 'locked'), 0o755); } catch { /* may not exist */ }
  try { await fs.rm(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('defaultListJsonlFiles — a clean environment and a broken one are different', () => {
  it('still returns nothing when the directory genuinely does not exist', () => {
    // This is the case the old comment described, and it is legitimately silent:
    // a machine that has never run Claude Code has no projects directory.
    return assert.doesNotReject(async () => {
      const files = await defaultListJsonlFiles(path.join(TMP, 'never-existed'));
      assert.deepEqual(files, []);
    });
  });

  it('refuses to report a path it cannot list as empty', async () => {
    // A regular file where a directory was expected. readdir fails with ENOTDIR on
    // every platform, including Windows, which is the point: the earlier version of
    // this test locked a directory with chmod, and on Windows chmod only toggles the
    // read-only attribute, so readdir still worked and the test quietly asserted
    // nothing on the exact platform the bug came from.
    const notADir = path.join(TMP, 'not-a-directory');
    await fs.writeFile(notADir, 'this is a file');

    await assert.rejects(
      () => defaultListJsonlFiles(notADir),
      (err) => {
        assert.notEqual(err.code, 'ENOENT', 'this path exists; it just is not listable');
        return true;
      },
      'a path reported as empty is indistinguishable from one that holds no data',
    );
  });

  it('refuses to report an unreadable directory as empty', async (t) => {
    const locked = path.join(TMP, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(locked, 'x.jsonl'), '');
    await fs.chmod(locked, 0o000);

    // Permission bits do not bite when running as root, and chmod does not control
    // directory listing on Windows at all. Skip out loud rather than return quietly:
    // a test that silently asserts nothing is the same defect this release is about.
    let readable = true;
    try { await fs.readdir(locked); } catch { readable = false; }
    if (readable) {
      t.skip('chmod does not block readdir here (root, or Windows); see the ENOTDIR case above');
      return;
    }

    await assert.rejects(
      () => defaultListJsonlFiles(locked),
      (err) => {
        assert.notEqual(err.code, 'ENOENT', 'a permission failure is not a missing directory');
        return true;
      },
    );
  });
});

describe('one unreadable file must not take the whole tool down with it', () => {
  // Amiee has no `codex` row in collector_heartbeat at all, on a server where the
  // other eight members do — including members who almost certainly never run Codex.
  // "Not using it" cannot produce a missing row; a throwing adapter can.
  //
  // Both adapters call readIncremental inside the file loop with nothing around it,
  // and build the heartbeat only after the loop finishes. So a single file that
  // cannot be opened costs the tool its data *and* its check-in, every run.
  //
  // Codex supplies a routine trigger: it moves sessions from ~/.codex/sessions to
  // ~/.codex/archived_sessions, and the scanner walks both. A file archived between
  // the listing and the open is an ENOENT on a path that was there a moment ago.

  const line = (n) => JSON.stringify({
    type: 'assistant', uuid: `u${n}`, sessionId: 's1', timestamp: '2026-08-05T00:00:00Z',
    message: { model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } },
  });

  function vanishing(badFile, code = 'ENOENT') {
    return async (file) => {
      if (file === badFile) {
        const err = new Error(`${code}: no such file`);
        err.code = code;
        throw err;
      }
      return { lines: [line(1)], nextOffset: 10 };
    };
  }

  it('claude-code keeps the files it could read', async () => {
    const adapter = createClaudeCodeAdapter({
      baseDir: TMP,
      listFiles: async () => ['/a/one.jsonl', '/a/gone.jsonl', '/a/two.jsonl'],
      readIncremental: vanishing('/a/gone.jsonl'),
    });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 2, 'the two readable files must still produce events');
    assert.ok(r.heartbeat, 'losing the check-in is how this stays invisible on the server');
  });

  it('claude-code reports what it skipped and why', async () => {
    const adapter = createClaudeCodeAdapter({
      baseDir: TMP,
      listFiles: async () => ['/a/one.jsonl', '/a/gone.jsonl'],
      readIncremental: vanishing('/a/gone.jsonl', 'EACCES'),
    });
    const r = await adapter.readSince({});
    assert.deepEqual(r.skipped, ['EACCES'], 'a count with no reason costs an hour to chase');
  });

  it('codex survives a session archived mid-scan', async () => {
    const adapter = createCodexAdapter({
      baseDirs: ['/a/sessions'],
      listFiles: async () => [
        '/a/sessions/rollout-2026-08-05-00000000-0000-4000-8000-000000000001.jsonl',
        '/a/sessions/rollout-2026-08-05-00000000-0000-4000-8000-000000000002.jsonl',
      ],
      readIncremental: vanishing(
        '/a/sessions/rollout-2026-08-05-00000000-0000-4000-8000-000000000001.jsonl',
      ),
    });
    const r = await adapter.readSince({});
    assert.ok(r.heartbeat, 'no heartbeat is exactly why Amiee has no codex row');
    assert.deepEqual(r.skipped, ['ENOENT']);
  });

  it('never writes the word undefined where a reason belongs', async () => {
    // A throw that is not an Error has no `.message`. Logging it raw produces
    // "skipped /a/one.jsonl: undefined", which is the same defect as everything
    // else in this release: a line that appears to explain and does not.
    const warnings = [];
    const adapter = createClaudeCodeAdapter({
      baseDir: TMP,
      listFiles: async () => ['/a/one.jsonl'],
      readIncremental: async () => { throw 'a bare string, not an Error'; },
      logger: { warn: (m) => warnings.push(m) },
    });

    const r = await adapter.readSince({});
    assert.deepEqual(r.skipped, ['UNKNOWN']);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /undefined/);
    assert.match(warnings[0], /bare string/);
  });

  it('codex survives one malformed line without losing the file or the check-in', async () => {
    // This fits the production evidence better than the archival race does. That race
    // is intermittent, so over months at least one run would have got a heartbeat
    // through. A member with *never* a codex row needs something that fails on every
    // run, and one bad line in a session file does exactly that.
    //
    // canonicalizeCodexMaterial throws on a non-finite number, and
    // buildEventFromTokenCount calls it unguarded — in the same loop where a
    // malformed JSON line is already caught and skipped. That inconsistency is the
    // defect.
    const tc = (total) => JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-05T00:00:00Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 10, cached_input_tokens: 2, output_tokens: 5,
            reasoning_output_tokens: 1, total_tokens: 16,
          },
          total_token_usage: { total_tokens: total },
        },
      },
    });

    const adapter = createCodexAdapter({
      baseDirs: ['/a/sessions'],
      listFiles: async () => [
        '/a/sessions/rollout-2026-08-05-00000000-0000-4000-8000-000000000001.jsonl',
      ],
      readIncremental: async () => ({
        lines: [tc(100), tc('not a number'), tc(300)],
        nextOffset: 99,
      }),
    });

    const r = await adapter.readSince({});
    assert.equal(r.events.length, 2, 'the two good lines must still be sent');
    assert.ok(r.heartbeat, 'one bad line must not cost the tool its check-in');
    assert.ok(r.skipped.length >= 1, 'and the bad line has to be counted, not swallowed');
  });

  it('an adapter that reads everything reports nothing skipped', async () => {
    const adapter = createClaudeCodeAdapter({
      baseDir: TMP,
      listFiles: async () => ['/a/one.jsonl'],
      readIncremental: async () => ({ lines: [line(1)], nextOffset: 10 }),
    });
    assert.deepEqual((await adapter.readSince({})).skipped, []);
  });
});

describe('the adapter reports how much it could see', () => {
  it('says how many files it scanned, so sent=0 can be read', async () => {
    // Even with no error, `sent=0` is ambiguous: a correctly resolved but empty
    // home looks exactly like a home full of data the scanner cannot reach.
    // The file count separates them at a glance.
    const base = path.join(TMP, 'projects', 'proj-a');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, 's1.jsonl'), '');
    await fs.writeFile(path.join(base, 's2.jsonl'), '');

    const adapter = createClaudeCodeAdapter({ baseDir: path.join(TMP, 'projects') });
    const result = await adapter.readSince({});

    assert.equal(result.events.length, 0, 'the files are empty, so there is nothing to send');
    assert.equal(result.scanned, 2, 'but two files were visible, which is the whole difference');
  });

  it('reports zero visible files for a clean machine', async () => {
    const adapter = createClaudeCodeAdapter({ baseDir: path.join(TMP, 'nope') });
    const result = await adapter.readSince({});
    assert.equal(result.scanned, 0);
  });
});
