import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  NODE_LTS_MAJOR, nodeArchiveName, nodeDistUrl, shasumsUrl, verifySha256,
} from '../../shared/node-runtime.js';

/**
 * Node LTS archives for the private runtime the installer puts on a colleague's machine.
 *
 * The server downloads an archive from nodejs.org once, checks it against the release's
 * SHASUMS256.txt, and keeps it in `cacheDir`; every later request is served from disk. A file
 * counts as cached only when its `<name>.sha256` sidecar exists: the sidecar is written after the
 * checksum passed, so a download cut short never looks finished.
 *
 * Every dependency is injected so tests use no network and no real clock.
 */

const INDEX_URL = 'https://nodejs.org/dist/index.json';
const RELEASE = new RegExp(`^v${NODE_LTS_MAJOR}\\.\\d+\\.\\d+$`);
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const INDEX_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function ok(res, what) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res;
}

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {string} deps.cacheDir
 * @param {() => number} [deps.now] epoch milliseconds
 * @param {{ warn: Function, info?: Function }} [deps.logger]
 * @returns {{ getArchive: (p: { os: string, arch: string }) => Promise<{ path: string, version: string, sha256: string }> }}
 */
export function createNodeArchiveService({ fetch: fetchImpl, cacheDir, now = Date.now, logger = console }) {
  let latest = null; // { version, at }
  const inflight = new Map(); // archive name -> Promise

  async function latestVersion() {
    if (latest && now() - latest.at < INDEX_TTL_MS) return latest.version;
    const res = await ok(await fetchImpl(INDEX_URL, { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) }), 'index.json');
    const entry = (await res.json()).find((e) => typeof e?.version === 'string' && RELEASE.test(e.version));
    if (!entry) throw new Error(`index.json lists no v${NODE_LTS_MAJOR}.x release`);
    latest = { version: entry.version, at: now() };
    return entry.version;
  }

  async function expectedChecksum(version, name) {
    const res = await ok(await fetchImpl(shasumsUrl(version), { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) }), 'SHASUMS256.txt');
    for (const line of (await res.text()).split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line);
      if (m && m[2] === name) return m[1].toLowerCase();
    }
    throw new Error(`SHASUMS256.txt has no line for ${name}`);
  }

  async function download(version, name, target) {
    const expected = await expectedChecksum(version, name);
    const partial = `${target}.partial`;
    try {
      const res = await ok(await fetchImpl(nodeDistUrl(name), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }), name);
      await fsp.mkdir(cacheDir, { recursive: true });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partial));
      if (!(await verifySha256(partial, expected))) throw new Error(`checksum mismatch for ${name}`);
      await fsp.rename(partial, target);
    } catch (err) {
      await fsp.rm(partial, { force: true });
      throw err;
    }
    await fsp.writeFile(`${target}.sha256`, `${expected}\n`);
    logger.info?.('node archive: cached', { name });
    return expected;
  }

  async function readCached(os, arch, version) {
    const name = nodeArchiveName({ os, arch, version });
    const target = path.join(cacheDir, name);
    try {
      const sha256 = (await fsp.readFile(`${target}.sha256`, 'utf8')).trim();
      await fsp.access(target);
      if (/^[0-9a-f]{64}$/.test(sha256)) return { path: target, version, sha256 };
    } catch { /* not cached */ }
    return null;
  }

  // nodejs.org cannot be asked (index.json failed): the newest verified archive already on disk
  // for this platform is still better than sending the colleague to nodejs.org.
  async function newestCached(os, arch) {
    let files;
    try { files = await fsp.readdir(cacheDir); } catch { return null; }
    const versions = files
      .map((f) => /^node-(v\d+\.\d+\.\d+)-/.exec(f)?.[1])
      .filter((v) => v && RELEASE.test(v))
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number);
        const pb = b.slice(1).split('.').map(Number);
        return pb[1] - pa[1] || pb[2] - pa[2];
      });
    for (const version of [...new Set(versions)]) {
      const hit = await readCached(os, arch, version);
      if (hit) return hit;
    }
    return null;
  }

  async function resolve(os, arch) {
    let version;
    try {
      version = await latestVersion();
    } catch (err) {
      const cached = await newestCached(os, arch);
      if (!cached) throw err;
      logger.warn('node archive: nodejs.org index unavailable, serving cached archive', { error: err.message, version: cached.version });
      return cached;
    }
    const name = nodeArchiveName({ os, arch, version });
    const target = path.join(cacheDir, name);
    const hit = await readCached(os, arch, version);
    if (hit) return hit;
    // Two colleagues installing at once share one download.
    if (!inflight.has(name)) {
      const p = download(version, name, target).finally(() => inflight.delete(name));
      inflight.set(name, p);
    }
    return { path: target, version, sha256: await inflight.get(name) };
  }

  return {
    /** Rejects on any upstream or checksum failure; the route turns that into a 503. */
    getArchive({ os, arch }) {
      return resolve(os, arch);
    },
  };
}
