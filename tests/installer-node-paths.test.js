import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Bug report #15 (2026-08-06, machine TANK): `bash ~/.ownmind/scripts/bootstrap.sh` aborted
 * inside install.sh and printed nothing at all, so every step after that point — the
 * SessionStart hook, the git hooks, the scanner schedule, the self-check — never ran on any
 * Windows machine that upgraded through this path.
 *
 * The cause: under Git Bash, `$HOME` is `/c/Users/Vin`. The MSYS runtime converts paths
 * passed as ARGUMENTS to a native binary, so `node helper.cjs "$FILE"` is fine. It does not
 * convert a path sitting inside the source text of `node -e "...'$FILE'..."` — node.exe
 * receives the leading slash, resolves it against the drive root, and throws ENOENT.
 *
 * `scripts/install-helpers/path-helpers.sh` has solved this since v1.26.7 and had been
 * wired into exactly one script. These tests derive the list of offenders from the scripts
 * themselves so nobody has to remember, and fail closed on anything they cannot parse.
 */

const SCRIPTS = ['install.sh', 'scripts/update.sh', 'scripts/interactive-upgrade.sh'];

/** Shell variables that are known NOT to hold a filesystem path. */
const NON_PATH_VARS = new Set([
  'MCP_ENTRY',      // a JSON literal spliced in as an object
  'API_URL', 'API_KEY',
  'OSTYPE', 'HOSTNAME',
  'ts', 'trigger', 'platform', 'machine', 'version',
  'api_key', 'api_url',
]);

/**
 * Locate every inline Node invocation and return its source text.
 *
 * Fails closed: if an opening `node -e "` has no matching close, that is reported rather
 * than skipped — an unparseable block is exactly where an unconverted path would hide.
 */
function inlineNodeBlocks(file) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const lines = text.split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const open = /(?:^|[^#])\bnode\s+-[ep]\s+"/.exec(lines[i]);
    if (!open) continue;

    // Single-line form: `node -p "…"` opens and closes on the same line. Match the shell
    // double-quoted string itself so a following `2>>"$LOG"` redirect is not swallowed
    // into the body — that mistake made this guard report the redirect as an offender.
    const single = /\bnode\s+-[ep]\s+"((?:[^"\\]|\\.)*)"/.exec(lines[i]);
    if (single) {
      blocks.push({ file, line: i + 1, body: single[1], tail: lines[i] });
      continue;
    }

    // Multi-line form: scan for the line whose first non-space character is the closer.
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*"/.test(lines[j])) { end = j; break; }
    }
    assert.notEqual(end, -1,
      `${file}:${i + 1} — cannot find the closing quote of this node -e block; ` +
      'the guard fails closed rather than skipping it');
    blocks.push({ file, line: i + 1, body: lines.slice(i + 1, end).join('\n'), tail: lines[end] });
    i = end;
  }
  return blocks;
}

describe('paths inside inline Node source are Windows-native', () => {
  for (const file of SCRIPTS) {
    it(`${file} converts every interpolated path`, () => {
      const offenders = [];
      for (const block of inlineNodeBlocks(file)) {
        const vars = block.body.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g) || [];
        for (const raw of vars) {
          const name = raw.replace(/[${}]/g, '');
          if (NON_PATH_VARS.has(name)) continue;
          if (name.endsWith('_WIN') || name.endsWith('_win')) continue;
          // `claude_settings` and friends are locals already assigned via to_win_path;
          // the assignment test below is what proves that.
          if (/^(claude_settings|p|c|target_file)$/.test(name)) continue;
          offenders.push(`${block.file}:${block.line} interpolates $${name}`);
        }
        // A bare $HOME/... literal inside the Node source is the original defect.
        if (/\$\{?HOME\}?\//.test(block.body)) {
          offenders.push(`${block.file}:${block.line} embeds a raw $HOME path`);
        }
      }
      assert.deepEqual(offenders, [],
        'these must go through to_win_path (scripts/install-helpers/path-helpers.sh)');
    });
  }

  it('every _WIN variable is produced by to_win_path, not by hand', () => {
    for (const file of SCRIPTS) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const assigns = text.match(/^\s*[A-Za-z_][A-Za-z0-9_]*_WIN=.*$/gm) || [];
      for (const line of assigns) {
        // OWNMIND_DIR_WIN in install.sh predates this change and uses `cygpath -w` on
        // purpose: it is embedded in a backslash-escaped Windows command string, not read
        // by node's fs. START_CMD_WIN is then built from it. Everything else must use the
        // shared helper.
        if (/cygpath -w/.test(line)) continue;
        if (/=\s*"?\$\{?[A-Za-z_][A-Za-z0-9_]*_WIN\}?/.test(line)) continue;
        assert.match(line, /to_win_path/, `${file}: ${line.trim()}`);
      }
    }
  });

  it('install.sh and update.sh source path-helpers.sh with an identity fallback', () => {
    for (const file of ['install.sh', 'scripts/update.sh']) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      assert.match(text, /install-helpers\/path-helpers\.sh/, `${file} must source the helper`);
      assert.match(text, /to_win_path\(\)\s*\{\s*echo "\$1"; \}/,
        `${file} must define an identity fallback when the helper is missing`);
    }
  });
});

describe('installers never discard a Node error stream', () => {
  for (const file of ['install.sh', 'scripts/update.sh']) {
    it(`${file} routes node stderr to a log, not /dev/null`, () => {
      const offenders = inlineNodeBlocks(file)
        .filter((b) => /2>\s*\/dev\/null/.test(b.tail))
        .map((b) => `${b.file}:${b.line}`);
      assert.deepEqual(offenders, [],
        'set -e plus a discarded stderr is how a fatal error produced no output at all');
    });
  }
});

describe('the upgrade log survives rollback', () => {
  const text = readFileSync(new URL('../scripts/interactive-upgrade.sh', import.meta.url), 'utf8');

  it('does not write the log inside the directory rollback replaces', () => {
    const assign = /^LOG_FILE=.*$/m.exec(text);
    assert.ok(assign, 'LOG_FILE assignment not found');
    assert.doesNotMatch(assign[0], /OWNMIND_DIR/,
      'rollback is rm -rf "${OWNMIND_DIR}" — a log in there is deleted before anyone reads it');
  });

  it('rollback still targets OWNMIND_DIR, so the test above is load-bearing', () => {
    const fn = /rollback\(\)\s*\{[\s\S]*?\n\}/.exec(text);
    assert.ok(fn, 'rollback() not found');
    assert.match(fn[0], /rm -rf "\$\{OWNMIND_DIR\}"/);
  });
});

describe('to_win_path is inert off Windows', () => {
  it('returns its input unchanged when cygpath is absent', () => {
    const out = execFileSync('bash', ['-c',
      'PATH=/usr/bin:/bin; . scripts/install-helpers/path-helpers.sh; to_win_path "/c/Users/Vin/.claude/settings.json"',
    ], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
    assert.equal(out.trim(), '/c/Users/Vin/.claude/settings.json');
  });
});
