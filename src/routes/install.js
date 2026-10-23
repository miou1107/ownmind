import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildInstallArchive } from '../services/install-archive.js';
import { isSupportedPlatform } from '../../shared/node-runtime.js';
import { SERVER_VERSION } from '../utils/server-version.js';

/**
 * Zero-touch install, the server half.
 *
 *   GET /install.sh, /install.ps1, /install-manual.md   anonymous; /install.sh is scripts/bootstrap.sh and
 *                                                       /install.ps1 is scripts/bootstrap.ps1 (the entry
 *                                                       that works without git), /install-manual.md is
 *                                                       docs/ai-install-runbook.md; the same files the
 *                                                       public repository carries, so nothing secret
 *   GET /api/install/archive[?format=zip]               the checkout as .tar.gz (or .zip, which is
 *                                                       what Windows PowerShell can unpack), for a
 *                                                       machine without git; behind auth like
 *                                                       /api/version, so a scanner cannot read
 *                                                       the version. HEAD answers only the
 *                                                       X-OwnMind-Release header (archive updates)
 *   GET /api/install/node?os=&arch=                     the official Node LTS archive for the private
 *                                                       runtime, cached on the server; 503 tells the
 *                                                       installer to go to nodejs.org itself
 *   GET /api/install/first-load?since=<ISO>             whether this account's first memory
 *                                                       load (an `init` event from a hook)
 *                                                       arrived after `since`
 *
 * Mounted at the root, because the scripts live outside /api; every route carries its full
 * path. The app puts it ahead of the /api rate limit (see src/app.js).
 */

const DEFAULT_REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT = 'text/plain; charset=utf-8';

export function createInstallRouter({ query, auth, logger = console, repoRoot = DEFAULT_REPO_ROOT, nodeArchive }) {
  const router = Router();

  // install.ps1 keeps a BOM on disk so `powershell -File` reads it as UTF-8; `irm | iex`
  // would choke on it as the first character of the first line.
  const sendText = (file, { stripBom = false } = {}) => (req, res) => {
    let body;
    try {
      body = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      return res.status(404).json({ error: file === 'docs/ai-install-runbook.md' ? 'manual_not_available' : 'script_not_available' });
    }
    if (stripBom && body.charCodeAt(0) === 0xfeff) body = body.slice(1);
    res.type(TEXT).send(body);
  };

  // The one-liners the install prompt hands out fetch these two URLs. They serve the bootstrap
  // scripts, not the root install.sh / install.ps1: those clone with a version-control tool a
  // colleague's computer may not have, while the bootstrap scripts fall back to the release archive.
  router.get('/install.sh', sendText('scripts/bootstrap.sh'));
  router.get('/install.ps1', sendText('scripts/bootstrap.ps1', { stripBom: true }));
  router.get('/install-manual.md', sendText('docs/ai-install-runbook.md'));

  // HEAD answers which release the archive holds without building or sending it: an archive
  // install asks this to decide whether it has anything to download (shared/archive-update.js).
  // Express would otherwise run the GET handler for a HEAD and build the archive to answer it.
  router.head('/api/install/archive', auth, (req, res) => {
    res.set('X-OwnMind-Release', `v${SERVER_VERSION}`);
    res.set('Content-Type', req.query.format === 'zip' ? 'application/zip' : 'application/gzip');
    res.status(200).end();
  });

  router.get('/api/install/archive', auth, async (req, res) => {
    const format = req.query.format === undefined || req.query.format === '' ? 'tar.gz' : req.query.format;
    if (format !== 'tar.gz' && format !== 'zip') {
      return res.status(400).json({ error: 'unsupported_format' });
    }
    try {
      const version = `v${SERVER_VERSION}`;
      const archive = await buildInstallArchive({ repoRoot, version, format });
      res.set('X-OwnMind-Release', archive.version);
      res.set('Content-Type', format === 'zip' ? 'application/zip' : 'application/gzip');
      res.set('Content-Length', String(fs.statSync(archive.path).size));
      // pipeline destroys the file stream when the client goes away mid-download.
      pipeline(fs.createReadStream(archive.path), res, (err) => {
        if (err) logger.warn('install archive: download interrupted', { error: err.message });
      });
    } catch (err) {
      logger.error('install archive: build failed', { error: err.message });
      res.status(500).json({ error: 'archive_unavailable' });
    }
  });

  router.get('/api/install/node', auth, async (req, res) => {
    const os = typeof req.query.os === 'string' ? req.query.os : '';
    const arch = typeof req.query.arch === 'string' ? req.query.arch : '';
    if (!isSupportedPlatform({ os, arch })) {
      return res.status(400).json({ error: 'unsupported_platform' });
    }
    try {
      if (!nodeArchive) throw new Error('node archive service not configured');
      const archive = await nodeArchive.getArchive({ os, arch });
      res.set('X-Node-Version', archive.version);
      res.set('X-Sha256', archive.sha256);
      const size = fs.statSync(archive.path).size;
      res.set('Content-Type', os === 'win32' ? 'application/zip' : 'application/gzip');
      res.set('Content-Length', String(size));
      pipeline(fs.createReadStream(archive.path), res, (err) => {
        if (err) logger.warn('install node: download interrupted', { error: err.message });
      });
    } catch (err) {
      logger.warn('install node: nodejs.org archive unavailable', { error: err.message });
      for (const h of ['Content-Type', 'Content-Length', 'X-Node-Version', 'X-Sha256']) res.removeHeader(h);
      res.status(503).json({ error: 'node_upstream_unavailable' });
    }
  });

  router.get('/api/install/first-load', auth, async (req, res) => {
    const since = typeof req.query.since === 'string' ? req.query.since : '';
    const sinceMs = since ? Date.parse(since) : NaN;
    if (Number.isNaN(sinceMs)) {
      return res.status(400).json({ error: 'since must be an ISO timestamp' });
    }
    try {
      const r = await query(
        `SELECT ts FROM activity_logs
          WHERE user_id = $1 AND event = 'init' AND source = 'hook' AND ts > $2
          ORDER BY ts DESC LIMIT 1`,
        [req.user.id, new Date(sinceMs).toISOString()],
      );
      const row = r.rows[0];
      res.json(row ? { loaded: true, at: new Date(row.ts).toISOString() } : { loaded: false, at: null });
    } catch (err) {
      logger.error('install first-load failed', { error: err.message });
      res.status(500).json({ error: 'first_load_unavailable' });
    }
  });

  return router;
}
