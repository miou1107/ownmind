import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A path that cannot be written on any platform.
 *
 * v1.26.123 — three tests used `/root/no-permission/x.json` for this. On Linux and macOS
 * that is unwritable to a normal user, which is what they meant. On Windows it is not a
 * privileged location at all: it resolves to `C:\root\no-permission`, the writer creates it
 * with `mkdir -p` and the write succeeds. Measured on a developer box, that directory had
 * accumulated `x.json` and `x.jsonl` from earlier runs.
 *
 * Two of the three only asserted "must not throw", so a successful write satisfied them —
 * they reported the error path as covered on Windows while never once entering it. The
 * third asserted the return value and failed honestly, which is how this was found.
 *
 * A file standing where a directory has to go fails everywhere, for a reason no platform
 * disagrees about: `mkdir` cannot descend through it (`ENOTDIR`, and Windows agrees), and
 * neither can `open`. It also lives in the temp directory, so the test leaves nothing on a
 * real disk.
 */
export function makeUnwritablePath(leaf = 'x.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-unwritable-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file, standing where a directory would have to be\n');
  return {
    path: path.join(blocker, leaf),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
