/**
 * hooks/lib/resolve-claude-bin.js — turn `claude` into something node can actually spawn.
 *
 * WHY THIS EXISTS. `judgeLocally` spawned the CLI by name with no shell, which is correct on
 * macOS and Linux and cannot work on Windows. Measured on Windows 10, node v25.8.1, with the
 * CLI installed through npm (`C:\Users\…\AppData\Roaming\npm\claude.cmd`):
 *
 *     spawn('claude')      -> ENOENT   node does not apply PATHEXT, and the extensionless
 *                                      `claude` sitting beside it is a shell script Windows
 *                                      cannot execute
 *     spawn('claude.cmd')  -> EINVAL   node refuses to start a .cmd without a shell; that
 *                                      refusal is the CVE-2024-27980 fix, not a bug
 *
 * So the judge failed on every single turn on Windows, and — because ENOENT is classified as
 * `no-cli` — it said `claude is not on this machine` about a machine that has it installed.
 * A wrong diagnosis is worse than a blank one: it sends the reader after a missing install
 * that is not missing.
 *
 * WHY NOT `shell: true`, the usual answer. The judge's argv carries `--system-prompt` with a
 * multi-line prompt in it. With `shell: true` node hands `cmd.exe /d /s /c` one concatenated
 * string and escapes nothing, so quotes, `%VAR%` and `^` in that prompt would be re-parsed by
 * cmd. Fixing the spawn by corrupting the payload is not a fix.
 *
 * WHAT IT DOES INSTEAD. It finds the real executable and, when that turns out to be an npm
 * shim, reads the node script the shim would have run and runs that directly with the node
 * we are already inside. There is no shell anywhere in the result, so argv survives byte for
 * byte on every platform.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Extensions Windows will execute directly, in the order a shim search should prefer them. */
const DIRECT_EXTS = ['.exe', '.com'];
/** Extensions that are batch shims — executable by cmd.exe only, which is what we avoid. */
const SHIM_EXTS = ['.cmd', '.bat'];

/**
 * What a `.cmd` shim would actually have run.
 *
 * THE LINE THIS READS is the one carrying `%*` — the shim's own forwarding of argv, i.e. the
 * command it exists to run. Reading the whole file instead was the first version of this and
 * it is wrong in a way that only shows on a real machine: npm's node shim also contains
 * `IF EXIST "%dp0%\node.exe"`, so a file-wide search can pick the interpreter out of a branch
 * that was not taken and use it as the target.
 *
 * TWO KINDS OF TARGET, because both are installed in the wild:
 *
 *   - a node script (`"%dp0%\node_modules\…\cli.js" %*`) — npm's shim for a JS bin, and what
 *     this function was first written for
 *   - a native executable (`"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`)
 *     — which is what Claude Code installs today, measured on the machine this was fixed on.
 *     The first version of this fix passed thirteen tests and then failed against the real
 *     CLI for exactly this reason, which is the whole argument for checking the real one.
 *
 * `%dp0%`/`%~dp0` expand against the shim's own directory, as cmd would have done.
 *
 * Returns null when the file names nothing that exists — a shim wrapping something this
 * cannot unwrap must produce a clear failure rather than a confident wrong answer.
 *
 * @returns {{target: string, kind: 'node-script'|'executable'}|null}
 */
export function targetFromShim(shimPath, contents) {
  const dir = path.dirname(shimPath);

  for (const line of contents.split(/\r?\n/)) {
    if (!line.includes('%*')) continue;

    for (const match of line.matchAll(/"([^"\r\n]+\.(js|mjs|cjs|exe|com))"/gi)) {
      // Separators are normalised after the expansion, not before: a shim written on Windows
      // spells the path with backslashes, and this function has to be exercisable by the test
      // suite on Linux and macOS too — the platforms where nobody can otherwise see it work.
      const expanded = match[1]
        .replace(/%~?dp0%?[\\/]?/gi, `${dir}${path.sep}`)
        .replace(/[\\/]+/g, path.sep);

      const resolved = path.resolve(dir, expanded);
      if (!fs.existsSync(resolved)) continue;

      const ext = match[2].toLowerCase();
      return {
        target: resolved,
        kind: ext === 'exe' || ext === 'com' ? 'executable' : 'node-script',
      };
    }
  }
  return null;
}

/**
 * Candidate files for a bare command name, in PATH order then PATHEXT order.
 *
 * `where.exe` would answer this too, but it is one more process on a path that runs on every
 * checked turn, and it cannot be exercised on the CI legs that are not Windows. Reading the
 * two environment variables is the same lookup and is testable everywhere.
 */
function candidates(bin, env, sep) {
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const out = [];
  for (const dir of dirs) {
    for (const ext of [...DIRECT_EXTS, ...SHIM_EXTS]) {
      if (exts.includes(ext)) out.push(path.join(dir, bin + ext));
    }
  }
  return out;
}

/**
 * Resolve a command into `{ command, prefixArgs }` that `spawn` can start with no shell.
 *
 * The caller spawns `command` with `[...prefixArgs, ...argv]`. Off Windows nothing is
 * resolved — the platform's own PATH lookup is correct there, and a resolver that only runs
 * where it is needed cannot break where it is not.
 *
 * Throws with a named cause when Windows has the CLI in a form nothing here can start. That
 * is deliberate: the caller classifies a throw, and this one must not arrive looking like
 * ENOENT, because "installed in a shape I cannot launch" and "not installed" send the reader
 * to different places.
 *
 * @param {string} bin
 * @param {object} [deps] — injected for tests; nothing here reads the real machine when given
 * @returns {{command: string, prefixArgs: string[]}}
 */
export function resolveClaudeBin(bin, {
  platform = process.platform,
  env = process.env,
  nodeExec = process.execPath,
  fsModule = fs,
  sep = path.delimiter,
} = {}) {
  if (platform !== 'win32') return { command: bin, prefixArgs: [] };

  // An absolute or relative path was given: honour it, and still unwrap a shim, because a
  // path pointing straight at a .cmd hits the same EINVAL as a bare name does.
  const named = bin.includes(path.sep) || bin.includes('/') || path.extname(bin);
  const files = named ? [bin] : candidates(bin, env, sep);

  const tried = [];
  for (const file of files) {
    tried.push(file);
    if (!fsModule.existsSync(file)) continue;

    const ext = path.extname(file).toLowerCase();
    if (DIRECT_EXTS.includes(ext)) return { command: file, prefixArgs: [] };

    // A file that was named explicitly and is neither a known executable nor a shim is handed
    // back untouched, so the operating system gets to say what is wrong with it. Reporting
    // `not-found` for a file the caller can see would be this defect's own mistake, repeated:
    // a confident wrong sentence about something that is plainly there.
    if (named && !SHIM_EXTS.includes(ext)) return { command: file, prefixArgs: [] };

    if (SHIM_EXTS.includes(ext)) {
      // A shim that cannot be read is reported, never skipped. Skipping it would fall through
      // to "not found", which is the wrong sentence about a file that is plainly there.
      let contents;
      try {
        contents = fsModule.readFileSync(file, 'utf8');
      } catch (err) {
        throw named_(`${file} could not be read: ${err.message}`, 'shim-unreadable');
      }
      const found = targetFromShim(file, contents);
      if (found) {
        return found.kind === 'executable'
          ? { command: found.target, prefixArgs: [] }
          : { command: nodeExec, prefixArgs: [found.target] };
      }
      throw named_(
        `${file} is a shim this cannot unwrap — it names no program or script that exists`,
        'shim-unknown'
      );
    }
  }

  throw named_(
    `${bin} was not found as an executable on PATH (looked at ${tried.length} candidate${tried.length === 1 ? '' : 's'})`,
    'not-found'
  );
}

function named_(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}
