import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

/**
 * A minimal zip writer: one directory tree in, one .zip file out, no dependency.
 *
 * The release archive for Windows has to be a .zip because Expand-Archive (present in every
 * Windows PowerShell 5.1) reads nothing else, and the server already stages the tree that the
 * .tar.gz is made from. Only what that needs is here: deflate or store per entry, explicit
 * directory entries (PowerShell 5.1 creates parent folders itself, but older extractors do
 * not), UTF-8 names, unix modes in the external attributes, and the central directory.
 * No zip64, no encryption, no streaming of a single file larger than memory: the tree is a
 * source checkout, a few megabytes in a few hundred files. Symbolic links are skipped; the
 * checkout has none and Windows could not create them without a privilege anyway.
 */

const deflateRaw = promisify(zlib.deflateRaw);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
// Made by "unix" (3) at spec 2.0; needed to extract: 2.0 (deflate, directories).
const VERSION_MADE_BY = (3 << 8) | 20;
const VERSION_NEEDED = 20;
const MAX_ENTRIES = 0xffff;

let crcTable = null;

/** CRC-32 (IEEE) of a buffer. zlib.crc32 only exists from Node 22, and the server runs on 20. */
export function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time words for a Date (local time, 2-second resolution, 1980 and later). */
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(SIG_LOCAL, 0);
  h.writeUInt16LE(VERSION_NEEDED, 4);
  h.writeUInt16LE(FLAG_UTF8, 6);
  h.writeUInt16LE(entry.method, 8);
  h.writeUInt16LE(entry.dos.time, 10);
  h.writeUInt16LE(entry.dos.date, 12);
  h.writeUInt32LE(entry.crc, 14);
  h.writeUInt32LE(entry.compressedSize, 18);
  h.writeUInt32LE(entry.size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  name.copy(h, 30);
  return h;
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const h = Buffer.alloc(46 + name.length);
  h.writeUInt32LE(SIG_CENTRAL, 0);
  h.writeUInt16LE(VERSION_MADE_BY, 4);
  h.writeUInt16LE(VERSION_NEEDED, 6);
  h.writeUInt16LE(FLAG_UTF8, 8);
  h.writeUInt16LE(entry.method, 10);
  h.writeUInt16LE(entry.dos.time, 12);
  h.writeUInt16LE(entry.dos.date, 14);
  h.writeUInt32LE(entry.crc, 16);
  h.writeUInt32LE(entry.compressedSize, 20);
  h.writeUInt32LE(entry.size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30); // extra field length
  h.writeUInt16LE(0, 32); // comment length
  h.writeUInt16LE(0, 34); // disk number
  h.writeUInt16LE(0, 36); // internal attributes
  h.writeUInt32LE(entry.externalAttrs >>> 0, 38);
  h.writeUInt32LE(entry.offset, 42);
  name.copy(h, 46);
  return h;
}

/** Every file and directory under `dir` as { name, abs, stat }, directories before their content, sorted. */
async function walk(dir, prefix = '') {
  const out = [];
  const names = (await fsp.readdir(dir)).sort();
  for (const n of names) {
    const abs = path.join(dir, n);
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) continue;
    const name = `${prefix}${n}`;
    if (st.isDirectory()) {
      out.push({ name: `${name}/`, abs, stat: st, dir: true });
      out.push(...(await walk(abs, `${name}/`)));
    } else if (st.isFile()) {
      out.push({ name, abs, stat: st, dir: false });
    }
  }
  return out;
}

function write(handle, buf, state) {
  return handle.write(buf, 0, buf.length, state.pos).then(() => { state.pos += buf.length; });
}

/**
 * Write the tree under `dir` to `out` as a zip. Member names are relative to `dir` with forward
 * slashes, so `dir/install.ps1` is the member `install.ps1`.
 *
 * @param {{ dir: string, out: string }} opts
 * @returns {Promise<{ entries: number }>}
 */
export async function writeZipFromDir({ dir, out }) {
  const items = await walk(dir);
  if (items.length > MAX_ENTRIES) throw new Error(`zip: too many entries (${items.length})`);
  const handle = await fsp.open(out, 'w');
  const state = { pos: 0 };
  const entries = [];
  try {
    for (const item of items) {
      const dos = dosDateTime(item.stat.mtime);
      const mode = item.stat.mode & 0o7777;
      let data = Buffer.alloc(0);
      if (!item.dir) data = await fsp.readFile(item.abs);
      if (data.length > 0xfffffffe) throw new Error(`zip: ${item.name} is too large`);
      let method = METHOD_STORE;
      let body = data;
      if (data.length > 0) {
        const packed = await deflateRaw(data);
        if (packed.length < data.length) { method = METHOD_DEFLATE; body = packed; }
      }
      const entry = {
        name: item.name,
        method,
        dos,
        crc: crc32(data),
        compressedSize: body.length,
        size: data.length,
        // Unix mode in the high half; 0x10 is the MS-DOS directory bit.
        externalAttrs: item.dir ? ((0o40000 | (mode || 0o755)) << 16) | 0x10 : ((0o100000 | (mode || 0o644)) << 16),
        offset: state.pos,
      };
      await write(handle, localHeader(entry), state);
      if (body.length) await write(handle, body, state);
      entries.push(entry);
    }
    const centralStart = state.pos;
    for (const entry of entries) await write(handle, centralHeader(entry), state);
    const centralSize = state.pos - centralStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    await write(handle, end, state);
  } finally {
    await handle.close();
  }
  return { entries: entries.length };
}

/**
 * Read the central directory of a zip and return its members. Used by the tests (and anyone who
 * wants to check an archive without an unzip tool): it verifies sizes and CRC-32 while it inflates.
 *
 * @param {string} file
 * @returns {Array<{ name: string, data: Buffer, isDirectory: boolean }>}
 */
export function readZipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_END) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const result = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip: bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${name}`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === METHOD_DEFLATE ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size) throw new Error(`zip: size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
    result.push({ name, data, isDirectory: name.endsWith('/') });
  }
  return result;
}
