import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProjectName } from '../shared/helpers.js';

/**
 * v1.26.98 — the "most common project" column was blank because nothing sent a project.
 *
 * The team page reads `session_logs.details.project`. That field is only ever written by
 * `ownmind_log_session`, which the AI may or may not call; when it does not, the server
 * rebuilds the session from the activity log, and no activity event carried a project.
 *
 * Measured on 2026-08-07: four members had every session rebuilt that way, and a fifth had
 * 76 of 95. So the column was blank for four people entirely and four fifths of the fifth.
 *
 * The value was never actually unknown — `mcp/index.js` has derived it since v1.17.37. It
 * simply never travelled with anything except the session log. These pin that it now does,
 * on all three emitters, and that the server reads it back.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('v1.26.98 — resolveProjectName', () => {
  it('takes the directory name from the project directory', () => {
    assert.equal(resolveProjectName({ CLAUDE_PROJECT_DIR: '/Users/someone/work/my-app' }), 'my-app');
  });

  it('prefers the explicit project directory over the process cwd', () => {
    assert.equal(resolveProjectName({ CLAUDE_PROJECT_DIR: '/a/chosen-one' }), 'chosen-one');
    assert.equal(resolveProjectName({ OWNMIND_PROJECT_DIR: '/a/fallback-one' }), 'fallback-one');
  });

  it('never returns a path, only the last segment', () => {
    // The directory name is work context. The path to it says where somebody keeps their
    // files, which this product does not need in order to group work by project.
    const out = resolveProjectName({ CLAUDE_PROJECT_DIR: '/Users/someone/private/place/app' });
    assert.equal(out, 'app');
    assert.equal(out.includes('/'), false);
    assert.equal(out.includes('someone'), false);
  });

  it('returns null at the home directory and the root', () => {
    // A basename there names the machine's owner, not a project.
    assert.equal(resolveProjectName({ CLAUDE_PROJECT_DIR: os.homedir() }), null);
    assert.equal(resolveProjectName({ CLAUDE_PROJECT_DIR: '/' }), null);
  });

  it('never throws on rubbish input', () => {
    for (const env of [{}, { CLAUDE_PROJECT_DIR: '' }, { CLAUDE_PROJECT_DIR: null }]) {
      assert.doesNotThrow(() => resolveProjectName(env));
    }
  });
});

describe('v1.26.98 — the shell hook puts it on every event it writes', () => {
  /** Run the hook's log_event against a controlled HOME and read what it wrote. */
  function loggedDetails({ projectDir, useHomeAsProjectDir = false }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-proj-'));
    // The child runs with HOME pointing at this temp directory, so "the home directory" has
    // to mean that one — comparing against the real one would test nothing the code sees.
    if (useHomeAsProjectDir) projectDir = home;
    try {
      const src = fs.readFileSync(path.join(repoRoot, 'hooks', 'ownmind-session-start.sh'), 'utf8');
      // Take the setup block and the function itself, so this runs what ships.
      const setupStart = src.indexOf('OWNMIND_PROJECT_DIR_RESOLVED=');
      assert.ok(setupStart > 0, 'the hook no longer derives a project name');
      const setup = src.slice(setupStart, src.indexOf('\nfi\n', setupStart) + 4);
      const fnStart = src.indexOf('log_event() {');
      const fn = src.slice(fnStart, src.indexOf('\n}\n', fnStart) + 3);

      execFileSync('bash', ['-c', [
        `OWNMIND_DIR=${JSON.stringify(path.join(home, '.ownmind'))}`,
        `LOG_DIR="$OWNMIND_DIR/logs"`,
        'API_KEY=""; API_URL=""',
        projectDir === null ? 'unset CLAUDE_PROJECT_DIR' : `CLAUDE_PROJECT_DIR=${JSON.stringify(projectDir)}`,
        setup,
        fn,
        'log_event "init" "status" "ok"',
      ].join('\n')], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'ignore'] });

      const logDir = path.join(home, '.ownmind', 'logs');
      const file = fs.readdirSync(logDir).find((f) => f.endsWith('.jsonl'));
      const line = fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n').pop();
      return JSON.parse(line).details;   // throws if the JSON was malformed
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it('records the project alongside the event\'s own fields', () => {
    const details = loggedDetails({ projectDir: '/tmp/some-repo' });
    assert.equal(details.project, 'some-repo');
    assert.equal(details.status, 'ok', 'the event lost its own field');
  });

  it('still emits valid JSON when the directory name contains a quote', () => {
    // The shell hook builds its JSON by hand, so an unescaped quote would produce a line the
    // server rejects wholesale — the event would vanish rather than arrive imperfect.
    const details = loggedDetails({ projectDir: '/tmp/it\'s "quoted"' });
    assert.ok(typeof details.project === 'string');
    assert.equal(details.status, 'ok');
  });

  it('omits it rather than writing an empty one when there is no project', () => {
    const details = loggedDetails({ projectDir: null, useHomeAsProjectDir: true });
    assert.equal('project' in details, false);
    assert.equal(details.status, 'ok');
  });
});

describe('v1.26.98 — the other two emitters carry it too', () => {
  const mcpLog = fs.readFileSync(path.join(repoRoot, 'mcp', 'ownmind-log.js'), 'utf8');
  const nodeHook = fs.readFileSync(path.join(repoRoot, 'hooks', 'ownmind-session-start.js'), 'utf8');
  const mcpIndex = fs.readFileSync(path.join(repoRoot, 'mcp', 'index.js'), 'utf8');

  it('the MCP activity logger attaches it', () => {
    assert.match(mcpLog, /const PROJECT_NAME = resolveProjectName\(\)/);
    assert.match(mcpLog, /rest\.project = PROJECT_NAME/);
  });

  it('the Node hook attaches it, to the local log and the server report alike', () => {
    // Only one of the two would give the same event two shapes depending on the path it took.
    assert.equal((nodeHook.match(/project: PROJECT_NAME/g) || []).length, 2);
  });

  it('an explicit project from the caller is not overwritten', () => {
    for (const [name, src] of [['mcp', mcpLog], ['node hook', nodeHook]]) {
      assert.match(src, /project === undefined/, `${name} clobbers a caller-supplied project`);
    }
  });

  it('the MCP no longer keeps its own copy of the derivation', () => {
    // Two derivations are two answers to "which project is this" on one machine.
    assert.match(mcpIndex, /const AUTO_PROJECT = resolveProjectName\(\)/);
    assert.ok(!/CLAUDE_PROJECT_DIR[\s\S]{0,120}path\.basename\(dir\)/.test(mcpIndex));
  });
});

describe('v1.26.98 — the server reads it back into the recovered session', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'routes', 'memory.js'), 'utf8');

  it('counts the projects seen on the activity rows', () => {
    assert.match(src, /projectCounts\.set\(project/);
  });

  it('picks the most common, not the first', () => {
    // One stray event from another directory must not relabel an entire session.
    assert.match(src, /projectCounts\.entries\(\)[\s\S]{0,120}sort/);
  });

  it('omits the field when no event carried one', () => {
    // Writing null would read as "we asked and the answer was none".
    assert.match(src, /\.\.\.\(topProject \? \{ project: topProject \} : \{\}\)/);
  });
});
