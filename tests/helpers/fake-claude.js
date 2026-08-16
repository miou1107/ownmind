/**
 * A stand-in for the Claude Code CLI, in the shape the real one is installed in.
 *
 * WHY IT IS SHARED. Two test files built this independently and one of them got Windows
 * wrong: it wrote a file named `claude.cmd` whose contents were a node script, which cmd.exe
 * cannot run and which `resolveClaudeBin` correctly refuses to unwrap. The test then failed
 * for a reason that had nothing to do with what it was checking. A fake that has to match a
 * platform's launch rules is one decision, and one decision belongs in one place.
 *
 * WHAT IT PRODUCES:
 *   - POSIX: an executable node script named `claude`
 *   - Windows: `claude.js` plus a `claude.cmd` shim that runs it — the shape npm installs, and
 *     the only shape node can start there
 *
 * The stand-in records its argv and stdin so a caller can assert on what would have been sent.
 * A real run costs ~18s and the user's own quota, which is why nothing here uses one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp-dir.js';

/**
 * @param {object}  [opts]
 * @param {string}  [opts.stdout]     what the fake CLI prints
 * @param {number}  [opts.exitCode]
 * @param {number}  [opts.delayMs]    to drive the caller's timeout
 * @param {string}  [opts.prefix]     temp directory prefix, so a failure names its own test
 * @returns {{dir: string, bin: string, invocation: () => {argv: string[], stdin: string}}}
 */
export function fakeClaude({ stdout = '', exitCode = 0, delayMs = 0, prefix = 'om-fake-claude-' } = {}) {
  const dir = tempDir(prefix);
  const record = path.join(dir, 'invocation.json');
  const bin = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');

  const script = `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  setTimeout(() => {
    process.stdout.write(${JSON.stringify(stdout)});
    process.exit(${exitCode});
  }, ${delayMs});
});
`;

  if (process.platform === 'win32') {
    const js = path.join(dir, 'claude.js');
    fs.writeFileSync(js, script);
    fs.writeFileSync(bin, `@echo off\r\nnode "${js}" %*\r\n`);
  } else {
    fs.writeFileSync(bin, script, { mode: 0o755 });
  }

  return { dir, bin, invocation: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}
