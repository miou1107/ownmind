'use strict';

/**
 * Read a text file that some other tool wrote, without assuming it chose UTF-8.
 *
 * Why this exists (v1.26.106):
 *
 *   install.ps1 wrote the register-scanner-task log with `Tee-Object -FilePath`. Windows
 *   PowerShell 5.1's Tee-Object has no -Encoding parameter at all, so it always writes
 *   UTF-16LE. self-check.cjs read that file with { encoding: 'utf8' } and uploaded the
 *   result, which meant a 298-byte log arrived at the server as mojibake carrying 148 NUL
 *   bytes. Measured on a real machine: every register-task-*.log on it, back to
 *   2026-05-09, is UTF-16LE.
 *
 *   That is the same failure v1.17.83 is named after — Postgres JSONB rejects NUL, the
 *   whole INSERT fails, the client's retry spool re-sends the identical row forever, and
 *   the server logs a run of 500s. The fix then was to strip NUL server-side before the
 *   INSERT. This is the other half: stop producing them.
 *
 *   self-check.cjs already *reports* `default_outfile_encoding: 'Unicode (UTF-16 LE BOM)'`
 *   for PowerShell 5.x, in a field right next to the one it was garbling. Knowing a fact
 *   and acting on it are different things.
 *
 * Decoding is by BOM only, deliberately. Every writer this guards against — Out-File, `>`,
 * `2>`, `2>>`, Tee-Object under PS 5.1 — emits one. Guessing at a BOM-less file would mean
 * a heuristic that can misread real UTF-8, and a wrong guess here corrupts the diagnostic
 * someone is reading precisely because something else already failed.
 */

const fs = require('fs');

// Built rather than written literally. A raw NUL in the source of the code that removes NUL
// is invisible in review, survives copy-paste unnoticed, and turns the file binary to git
// and grep — this file was written that way once already. Same reasoning as the BOM
// comparison in ensure-pretooluse-hooks.cjs.
const NUL = String.fromCharCode(0);

/**
 * Decode a buffer using its byte-order mark, defaulting to UTF-8.
 *
 * The BOM itself is removed: it is metadata about the file, not content, and a leading
 * U+FEFF breaks JSON.parse and shows up as a stray glyph in anything that renders the text.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeTextBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE. Node has no utf16be decoder, so swap each pair and reuse utf16le. An odd
    // trailing byte cannot be part of a code unit; dropping it beats throwing inside a
    // reader whose whole job is to salvage a diagnostic.
    const body = buf.slice(2);
    const even = body.length - (body.length % 2);
    const swapped = Buffer.allocUnsafe(even);
    for (let i = 0; i < even; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  return buf.toString('utf8');
}

/**
 * @param {string} filePath
 * @returns {string}
 * @throws whatever fs.readFileSync throws — every caller here already has its own catch,
 *         and swallowing it would hide a missing file behind an empty log.
 */
function readTextFileSync(filePath) {
  return decodeTextBuffer(fs.readFileSync(filePath));
}

/**
 * Remove NUL from a string bound for the server.
 *
 * A backstop, not the fix: correct decoding above is what stops NUL being produced. This
 * catches what decoding cannot — a machine whose logs were written before this landed, a
 * genuinely binary file that ended up with a .log name, a dirty environment variable.
 * Postgres JSONB rejects the whole document over one NUL, so one bad byte anywhere costs
 * the entire report.
 */
function stripNul(s) {
  return typeof s === 'string' ? s.split(NUL).join('') : s;
}

/**
 * Remove NUL from a string that has already been through JSON.stringify.
 *
 * stripNul is not enough there and the difference is easy to miss: JSON.stringify does not
 * emit a raw NUL, it emits a six-character escape: backslash, u, then four zeros.
 * NUL character finds nothing and reports success while the payload is still poisoned.
 *
 * Postgres agrees with the escape, not with the byte — the error v1.17.83 was diagnosed from
 * is "unsupported Unicode escape sequence", raised on the escape inside the JSON document.
 * So this is the form that actually has to go, and the raw pass runs too for any value that
 * reached the string by another route.
 */
function stripNulEscapes(jsonText) {
  if (typeof jsonText !== 'string') return jsonText;
  // Case-insensitive, because JSON accepts either case in the four hex digits.
  return stripNul(jsonText).replace(/\\u0000/gi, '');
}

module.exports = { decodeTextBuffer, readTextFileSync, stripNul, stripNulEscapes, NUL };
