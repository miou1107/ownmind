import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decodeTextBuffer, stripNul, stripNulEscapes } = require('../scripts/install-helpers/read-text-file.cjs');

// Built, never written literally: a raw NUL in a test file is invisible in review and turns
// the file binary to git and grep. Same reasoning as read-text-file.cjs.
const NUL = String.fromCharCode(0);
const countNul = (s) => s.split(NUL).length - 1;
const { readLatestRegisterLog, serializeReport } = require('../scripts/install-helpers/self-check.cjs');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * v1.26.106 — a Windows-only defect, asserted from any platform.
 *
 * install.ps1 wrote the register-scanner-task log with `Tee-Object -FilePath`. Windows
 * PowerShell 5.1's Tee-Object has no -Encoding parameter at all, so it always writes
 * UTF-16LE; self-check.cjs read it back as UTF-8 and uploaded the result. Measured on a real
 * machine: a 298-byte log became mojibake carrying 148 NUL bytes, and every
 * register-task-*.log on that machine, back to 2026-05-09, is UTF-16LE.
 *
 * That payload is the input to the v1.17.83 incident — Postgres JSONB rejects NUL, the whole
 * INSERT fails, and the client's spool re-sends the identical row until someone notices the
 * run of 500s. That was fixed server-side. This is the client half.
 *
 * Nothing here needs Windows: the encoding is a property of the bytes, so the fixture is the
 * bytes. That is the point — the reason this survived months is that every test touching it
 * needed a Windows machine with a real install behind it.
 */

/** The bytes Windows PowerShell 5.1 actually produces: BOM ff fe, then UTF-16LE. */
function utf16leWithBom(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

const REAL_LOG = "[ownmind] using node: C:\\Program Files\\nodejs\\node.exe\r\n"
  + "[ownmind] task 'OwnMind Usage Scanner' registered; first run in 5 min, then every 120 min.\r\n";

describe('decodeTextBuffer — decode by BOM, not by assumption', () => {
  it('UTF-16LE with BOM round-trips, and carries no NUL', () => {
    const out = decodeTextBuffer(utf16leWithBom(REAL_LOG));
    assert.equal(out, REAL_LOG);
    assert.equal(countNul(out), 0,
      'a decoded log must not contain NUL — that is what Postgres rejects');
  });

  it('the same bytes read as UTF-8 are the failure this guards against', () => {
    // Not a test of our code; a statement of what the old line did, so the fixture cannot be
    // mistaken for an arbitrary one.
    const broken = utf16leWithBom(REAL_LOG).toString('utf8');
    assert.ok(countNul(broken) > 100,
      'reading UTF-16LE as UTF-8 is what produced 148 NUL bytes');
  });

  it('UTF-16BE with BOM decodes too', () => {
    const le = Buffer.from('hello', 'utf16le');
    const be = Buffer.allocUnsafe(le.length);
    for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
    assert.equal(decodeTextBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'hello');
  });

  it('UTF-8 BOM is stripped rather than left to break JSON.parse', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')]);
    const out = decodeTextBuffer(buf);
    assert.equal(out, '{"a":1}');
    assert.deepEqual(JSON.parse(out), { a: 1 });
  });

  it('plain UTF-8 is returned untouched, including non-ASCII', () => {
    assert.equal(decodeTextBuffer(Buffer.from('已註冊 scanner', 'utf8')), '已註冊 scanner');
  });

  it('an empty file is empty, not a crash', () => {
    assert.equal(decodeTextBuffer(Buffer.alloc(0)), '');
  });
});

describe('readLatestRegisterLog — the caller that was uploading the mojibake', () => {
  it('reads a UTF-16LE register log as text, with no NUL left to upload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownmind-reglog-'));
    try {
      writeFileSync(join(dir, 'register-task-20260809-102105.log'), utf16leWithBom(REAL_LOG));
      const got = readLatestRegisterLog(dir);
      assert.ok(got, 'a register log in the directory must be found');
      assert.equal(countNul(got.content), 0);
      assert.match(got.content, /OwnMind Usage Scanner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks the newest log when several exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownmind-reglog-'));
    try {
      writeFileSync(join(dir, 'register-task-20260101-000000.log'), utf16leWithBom('older\r\n'));
      // mtime resolution is coarse enough that two writes in the same millisecond tie; set
      // them apart explicitly rather than relying on the clock.
      const newer = join(dir, 'register-task-20260809-102105.log');
      writeFileSync(newer, utf16leWithBom('newer\r\n'));
      const now = Date.now();
      require('fs').utimesSync(join(dir, 'register-task-20260101-000000.log'), now / 1000 - 60, now / 1000 - 60);
      require('fs').utimesSync(newer, now / 1000, now / 1000);
      assert.match(readLatestRegisterLog(dir).content, /newer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a directory that does not exist', () => {
    assert.equal(readLatestRegisterLog(join(tmpdir(), 'ownmind-does-not-exist-9f3a')), null);
  });
});

describe('stripNul / stripNulEscapes', () => {
  it('stripNul removes NUL and leaves everything else', () => {
    assert.equal(stripNul('a' + NUL + 'b' + NUL), 'ab');
    assert.equal(stripNul('plain'), 'plain');
  });

  // The distinction the first draft of this fix got wrong: after JSON.stringify there is no
  // NUL character left to find, only its escape, and that escape is what Postgres rejects.
  it('stripNul alone does NOT clean serialized JSON — this is why the escape form exists', () => {
    const serialized = JSON.stringify({ d: 'a' + NUL + 'b' });
    assert.equal(countNul(stripNul(serialized)), 0, 'no raw NUL survives stringify');
    assert.match(serialized, /\\u0000/i, 'but the escape does, and it is the poison');
    assert.equal(JSON.parse(stripNul(serialized)).d.length, 3,
      'so stripNul leaves the NUL in place once the JSON is parsed again');
  });

  it('stripNulEscapes removes the escape, and the parsed value is clean', () => {
    const out = stripNulEscapes(JSON.stringify({ d: 'a' + NUL + 'b' }));
    assert.doesNotMatch(out, /\\u0000/i);
    assert.equal(JSON.parse(out).d, 'ab');
  });

  it('leaves other unicode escapes alone', () => {
    const out = stripNulEscapes(JSON.stringify({ d: 'café ' }));
    assert.equal(JSON.parse(out).d, 'café ');
  });
});

describe('serializeReport — NUL never leaves this machine', () => {
  it('strips NUL from the serialized payload', () => {
    const report = { checks: [{ name: 'scheduler', detail: 'a' + NUL + 'b' }] };
    const out = serializeReport(report);
    assert.equal(countNul(out), 0);
    assert.deepEqual(JSON.parse(out).checks[0].detail, 'ab');
  });

  it('is still valid JSON for an ordinary report', () => {
    const report = { ok: true, checks: [], env: { platform: 'win32' } };
    assert.deepEqual(JSON.parse(serializeReport(report)), report);
  });
});

describe('the writer side — install.ps1 must not use Tee-Object for a log node reads', () => {
  const installPs1 = readFileSync(join(repoRoot, 'install.ps1'), 'utf8');
  // Comments are stripped first: the fix's own comment quotes the line it replaced, and a
  // grep-style assertion that cannot tell code from the note explaining the code would fail
  // on a correct file — the kind of false positive that gets an assertion deleted rather
  // than understood.
  const code = installPs1.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('does not write the register log through Tee-Object', () => {
    // Windows PowerShell 5.1's Tee-Object has no -Encoding parameter, so there is no correct
    // way to use it here — the check is for the cmdlet, not for a missing flag.
    assert.doesNotMatch(code, /Tee-Object\s+-FilePath/,
      'Tee-Object on PS 5.1 always writes UTF-16LE; use Write-Utf8NoBom');
  });

  it('writes the register log through Write-Utf8NoBom', () => {
    assert.match(installPs1, /Write-Utf8NoBom\s+-Path\s+\$RegisterLogPath/);
  });

  it('still captures stderr and still reads the exit code', () => {
    // The rewrite could silently drop either. Both are why the log exists at all.
    assert.match(installPs1, /\$RegisterOutput\s*=\s*&\s*powershell[^\n]*2>&1/);
    assert.match(installPs1, /\$regExit\s*=\s*\$LASTEXITCODE/);
  });
});
