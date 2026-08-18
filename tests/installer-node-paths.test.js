import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

/**
 * Every shell script in the repo that can invoke node inline. Discovered rather than
 * listed: a hand-written list is how `hooks/ownmind-iron-rule-check.sh` — which install.sh
 * registers on Windows with no platform branch — carried the identical defect through the
 * release that was named after it.
 */
function shellScripts() {
  // v1.26.106 — fileURLToPath, not .pathname. On Windows a file: URL pathname is
  // '/C:/Users/...'; node then resolves that against the current drive root and looks for
  // 'C:C:Users...'. This file threw MODULE_NOT_FOUND / ENOENT on every Windows run while
  // passing on macOS, where the pathname happens to be a valid path.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = execFileSync('git', ['ls-files', '*.sh'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    // Fixtures deliberately contain broken shapes; they are not shipped to a machine.
    .filter((f) => !f.startsWith('tests/'));
  assert.ok(out.length >= 8, `expected to discover the shell scripts, found ${out.length}`);
  return out;
}

const SCRIPTS = shellScripts();

/** Shell variables that are known NOT to hold a filesystem path. */
const NON_PATH_VARS = new Set([
  'MCP_ENTRY',      // a JSON literal spliced in as an object
  'API_URL', 'API_KEY',
  'OSTYPE', 'HOSTNAME',
  'ts', 'trigger', 'platform', 'machine', 'version',
  'api_key', 'api_url',
  // version strings and event names, not paths
  'VERSION', 'PKG_VER', 'CLIENT_VER', 'SERVER_VER', 'TRIGGER',
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

  // Every spelling of "evaluate this string": -e, -p, --eval, --print, and the long forms
  // with an `=`. `node --eval "…"` slipped straight past the first version of this guard.
  const INLINE_FLAG = String.raw`(?:-[ep]|--eval|--print)(?:\s+|=)`;

  for (let i = 0; i < lines.length; i += 1) {
    // Comment lines are documentation, not code — path-helpers.sh's own usage example is
    // a `node -p "require('${OWNMIND_DIR}/package.json')…"` illustrating the bug.
    if (/^\s*#/.test(lines[i])) continue;
    const open = new RegExp(String.raw`(?:^|[^#])\bnode\s+${INLINE_FLAG}"`).exec(lines[i]);
    if (!open) continue;

    // Single-line form: `node -p "…"` opens and closes on the same line. Match the shell
    // double-quoted string itself so a following `2>>"$LOG"` redirect is not swallowed
    // into the body — that mistake made this guard report the redirect as an offender.
    const single = new RegExp(String.raw`\bnode\s+${INLINE_FLAG}"((?:[^"\\]|\\.)*)"`).exec(lines[i]);
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
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const offenders = [];
      for (const block of inlineNodeBlocks(file)) {
        const vars = block.body.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g) || [];
        for (const raw of vars) {
          const name = raw.replace(/[${}]/g, '');
          if (NON_PATH_VARS.has(name)) continue;
          // Names are not evidence. The only thing that clears a variable is an assignment
          // in this same file that runs it through to_win_path. An earlier version of this
          // test exempted `claude_settings` by name with a comment claiming the assignment
          // test covered it; the assignment test only looked at `*_WIN`, so reverting that
          // very fix left the suite green.
          const assigned = new RegExp(
            String.raw`^\s*(?:local\s+)?${name}=.*to_win_path`, 'm'
          ).test(text);
          if (assigned) continue;
          // A `*_WIN` name is already-converted by construction; the separate assignment
          // test below is what holds that construction to account.
          if (/_win$/i.test(name)) continue;
          if (/^(p|c)$/.test(name)) continue;  // process.argv locals inside the JS itself
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
      const assigns = text.match(/^\s*(?:local\s+)?[A-Za-z_][A-Za-z0-9_]*_(?:WIN|win)=.*$/gm) || [];
      for (const line of assigns) {
        // OWNMIND_DIR_WIN in install.sh predates this change and uses `cygpath -w` on
        // purpose: it is embedded in a backslash-escaped Windows command string, not read
        // by node's fs. START_CMD_WIN is then built from it. Everything else must use the
        // shared helper.
        if (/cygpath -w/.test(line)) continue;
        if (/=\s*"?\$\{?[A-Za-z_][A-Za-z0-9_]*_(?:WIN|win)\}?/.test(line)) continue;
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

  /**
   * v1.30.15 — the guard above reads inline `node -e` blocks only, and `npm install` is
   * neither. So `install.sh` ran `npm install -q 2>/dev/null`, 25 lines above its own comment
   * saying stderr must never go to /dev/null, and the guard had nothing to say about it.
   *
   * What that cost: npm's own diagnosis — a proxy refusal, a permissions error under
   * node_modules, a registry outage, a lockfile conflict — was thrown away, and every one of
   * them surfaced as the same sentence, "Try: npm install -g npm@latest and retry", which
   * addresses none of them. The install then exits 1 with the reason already destroyed, so
   * there is nothing left to look at afterwards either.
   *
   * Written as a scan for the dependency step rather than a hard-coded line number, since the
   * point is the shape and not this one occurrence.
   */
  for (const file of ['install.sh', 'scripts/update.sh']) {
    it(`${file} keeps npm's own error text when dependency installation fails`, () => {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const offenders = text.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !/^\s*#/.test(line))
        .filter(({ line }) => /\bnpm\s+(install|ci|ping)\b/.test(line))
        .filter(({ line }) => /2>\s*\/dev\/null/.test(line) || /&>\s*\/dev\/null/.test(line))
        .map(({ n }) => `${file}:${n}`);
      assert.deepEqual(offenders, [],
        'npm is the only thing that knows why npm failed; discarding it leaves a canned '
        + 'suggestion in place of the diagnosis');
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

describe('to_win_path is inert when cygpath is absent', () => {
  // v1.26.106 — the PATH here was `/usr/bin:/bin`, chosen to mean "no cygpath". Under Git
  // Bash cygpath lives in /usr/bin, so on Windows the premise was false: cygpath was found,
  // to_win_path converted, and the test failed while the helper did exactly its job. The
  // name said "off Windows" but nothing made it skip there.
  //
  // An empty PATH makes the premise true on every platform. `command -v` is a shell builtin
  // and keeps working, which is all to_win_path needs to reach its else branch.
  it('returns its input unchanged when cygpath is absent', () => {
    const out = execFileSync('bash', ['-c',
      'PATH=; . scripts/install-helpers/path-helpers.sh; to_win_path "/c/Users/Vin/.claude/settings.json"',
    ], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
    assert.equal(out.trim(), '/c/Users/Vin/.claude/settings.json');
  });
});
