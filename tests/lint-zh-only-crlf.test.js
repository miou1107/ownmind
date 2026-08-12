import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.26.123 — the mixed-language linter read a CRLF checkout as if none of it were
 * commented.
 *
 * It split the file on '\n', so every line kept a trailing '\r'. `\r` is a line terminator
 * to a JS regex and `.` does not cross one, so `/\/\/.*$/` matched nothing at all and the
 * comment-stripping step did nothing — quietly, with no error. Every `//` comment in the
 * tree was then linted as user-facing UI text.
 *
 * `npm test` runs this linter first, so on Windows with `core.autocrlf=true` the whole
 * suite stopped at the lint step, blaming a file nobody had edited. CI never saw it: the
 * Linux and macOS checkouts are LF.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINTER = path.join(repoRoot, 'scripts', 'lint-zh-only.js');

// A word the linter's own blacklist carries. Read from the source rather than re-typed, so
// this test fails loudly if the blacklist is rewritten instead of quietly passing.
const BLACKLISTED = (() => {
  const src = fs.readFileSync(LINTER, 'utf8');
  const m = src.match(/const BLACKLIST = \[([\s\S]*?)\]/);
  assert.ok(m, 'could not find BLACKLIST in lint-zh-only.js');
  const first = m[1].match(/'([^']+)'/);
  assert.ok(first, 'BLACKLIST appears to be empty');
  return first[1];
})();

/** Run the linter over a one-file directory written with the given line ending. */
function lint(fileBody, eol) {
  const dir = tempDir('ownmind-lintzh-');
  try {
    fs.writeFileSync(path.join(dir, 'Sample.jsx'), fileBody.split('\n').join(eol));
    const r = spawnSync(process.execPath, [LINTER, dir], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('lint-zh-only handles CRLF', () => {
  const commented = `// a note mentioning ${BLACKLISTED} in passing\nexport default function Sample() { return null; }\n`;
  const live = `export default function Sample() { return <div>${BLACKLISTED}</div>; }\n`;

  it('a blacklisted word inside a comment is ignored — LF', () => {
    const r = lint(commented, '\n');
    assert.equal(r.status, 0, `a comment is not UI text; got:\n${r.out}`);
  });

  it('a blacklisted word inside a comment is ignored — CRLF', () => {
    // The regression. Before the fix this exited 1 and named the comment.
    const r = lint(commented, '\r\n');
    assert.equal(r.status, 0, `CRLF must not turn every comment into a violation; got:\n${r.out}`);
  });

  it('reverse control: the same word outside a comment still fails — LF', () => {
    const r = lint(live, '\n');
    assert.equal(r.status, 1, 'hard-coded UI text must still be caught');
  });

  it('reverse control: the same word outside a comment still fails — CRLF', () => {
    // Without this, the fix could have been "strip more" and silently stopped linting.
    const r = lint(live, '\r\n');
    assert.equal(r.status, 1, 'the CRLF fix must not have disabled detection');
  });
});
