import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A simulated clean Mac, for tests that must not see anything the developer has installed.
 *
 * Nobody can hand this project a second Mac, so the machine of a colleague who has installed
 * nothing is approximated on the developer's own: a throwaway HOME, and a PATH that holds only
 * the tools every fresh macOS ships. No git (the system one is a stub that opens an
 * install-the-developer-tools dialog), no node, no npm, no brew.
 *
 * What this seals and what it does not:
 *   - Sealed: HOME, PATH, XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL all point into the throwaway
 *     home or at a bin directory of symlinks, and Claude Code's own variables are dropped so a
 *     spawned `claude` does not think it is nested inside the developer's session.
 *   - Not sealed: absolute paths. A script that calls /usr/bin/git or /opt/homebrew/bin/node
 *     by full path still reaches them. The installer under test is expected to use PATH.
 *
 * A real clean Mac is not quite "no git": /usr/bin/git exists as a stub that opens the
 * install-the-developer-tools dialog. `xcodeStub: true` reproduces that: `git` is on PATH, prints
 * the stub's own message and exits 1 (leaving `gitMarker` behind, so a test can prove it was never
 * run), and `xcode-select -p` exits 2 as it does when the tools are absent. The installer finds
 * the stubs through OWNMIND_XCODE_SELECT and OWNMIND_GIT_STUB_DIR, which are set in `env`.
 *
 * `bin/` is created outside HOME on purpose: a clean home must stay empty until the thing
 * under test writes to it.
 */

export const DEFAULT_KEEP = [
  'bash', 'sh', 'curl', 'tar', 'gzip', 'sed', 'awk', 'grep', 'mkdir', 'mv', 'rm', 'cp', 'ln',
  'chmod', 'cat', 'date', 'uname', 'sleep', 'head', 'tail', 'tr', 'cut', 'wc', 'dirname',
  'basename', 'env', 'printf', 'touch', 'find', 'xargs', 'osascript', 'mktemp', 'sw_vers', 'id',
  'whoami', 'tee', 'sort', 'uniq', 'readlink', 'stat', 'df',
  // Stock macOS ships both; the installer warns when it cannot find them.
  'sqlite3', 'launchctl',
];

/** Where a stock macOS keeps these tools. Searched in this order, never through the caller's PATH. */
const SYSTEM_DIRS = ['/bin', '/usr/bin', '/sbin', '/usr/sbin'];

function findSystemTool(name) {
  for (const dir of SYSTEM_DIRS) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

/**
 * @param {{ keep?: string[], xcodeStub?: boolean }} [options] tool names to link into the simulated PATH. Names that
 *   do not exist in a system directory are skipped rather than failing, so the same list works
 *   on a Mac and on a Linux CI runner.
 * @returns {{ home: string, binDir: string, env: Record<string, string>, gitMarker: string, cleanup: () => void }}
 */
export function makeCleanMac({ keep = DEFAULT_KEEP, xcodeStub = false } = {}) {
  const root = fs.realpathSync(os.tmpdir());
  const home = fs.realpathSync(fs.mkdtempSync(path.join(root, 'clean-mac-home-')));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'clean-mac-bin-')));

  for (const name of keep) {
    const target = findSystemTool(name);
    if (target) fs.symlinkSync(target, path.join(binDir, name));
  }

  const gitMarker = path.join(binDir, 'git-was-run');
  if (xcodeStub) {
    fs.writeFileSync(path.join(binDir, 'git'), [
      '#!/bin/sh',
      `: > "${gitMarker}"`,
      'echo "xcode-select: note: No developer tools were found, requesting install." >&2',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'xcode-select'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  }

  const env = {
    HOME: home,
    PATH: binDir,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    ...(xcodeStub ? { OWNMIND_XCODE_SELECT: path.join(binDir, 'xcode-select'), OWNMIND_GIT_STUB_DIR: binDir } : {}),
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  };

  return { home, binDir, env, gitMarker, cleanup };
}
