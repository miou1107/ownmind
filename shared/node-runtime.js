/**
 * shared/node-runtime.js: the private Node runtime the installer puts in ~/.ownmind/runtime.
 *
 * A colleague's machine often has no Node and no admin rights, so the installer downloads an
 * official Node LTS archive instead. The server hands the same archive out (company networks
 * sometimes block nodejs.org), and the installer script and the server must agree on the
 * archive's name and on how its checksum is checked. This file is that agreement.
 *
 * Only Node built-ins here: shell scripts run it with `node -e`, and it is imported from a
 * bare checkout with no `npm install` behind it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/** The Node line OwnMind runs on. The one place this number is written. */
export const NODE_LTS_MAJOR = 22;

const DIST = 'https://nodejs.org/dist';
const OS_NAMES = { darwin: 'darwin', win32: 'win' };
const OS_EXTENSIONS = { darwin: 'tar.gz', win32: 'zip' };
const ARCHES = new Set(['arm64', 'x64']);

/** Whether `os` (process.platform spelling) and `arch` (process.arch spelling) have an archive. */
export function isSupportedPlatform({ os, arch }) {
  return Object.hasOwn(OS_NAMES, os) && ARCHES.has(arch);
}

/**
 * The file name nodejs.org gives the archive, e.g. `node-v22.11.0-darwin-arm64.tar.gz` or
 * `node-v22.11.0-win-x64.zip`.
 *
 * @param {{ os: 'darwin'|'win32', arch: 'arm64'|'x64', version: string }} opts version as `v22.11.0`
 */
export function nodeArchiveName({ os, arch, version }) {
  if (!isSupportedPlatform({ os, arch })) throw new Error(`unsupported platform: ${os}/${arch}`);
  return `node-${version}-${OS_NAMES[os]}-${arch}.${OS_EXTENSIONS[os]}`;
}

/** Where nodejs.org serves `name`; the version directory is read from the name itself. */
export function nodeDistUrl(name) {
  const m = /^node-(v\d+\.\d+\.\d+)-/.exec(name);
  if (!m) throw new Error(`not a Node archive name: ${name}`);
  return `${DIST}/${m[1]}/${name}`;
}

/** The checksum list for one release, one `<sha256>  <archive name>` line per file. */
export function shasumsUrl(version) {
  return `${DIST}/${version}/SHASUMS256.txt`;
}

/** Whether the file at `filePath` hashes (SHA-256) to `expectedHex`; hex case does not matter. */
export function verifySha256(filePath, expectedHex) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex') === String(expectedHex).trim().toLowerCase()))
      .on('error', reject);
  });
}
