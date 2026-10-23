import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildInstallArchive } from '../services/install-archive.js';
import { SERVER_VERSION } from '../utils/server-version.js';

/**
 * Zero-touch install, the server half.
 *
 *   GET /install.sh, /install.ps1, /install-manual.md   anonymous; the same files the public
 *                                                       repository carries, so nothing secret
 *   GET /api/install/archive                            the checkout as .tar.gz, for a machine
 *                                                       without git; behind auth like
 *                                                       /api/version, so a scanner cannot read
 *                                                       the version
 *   GET /api/install/first-load?since=<ISO>             whether this account's first memory
 *                                                       load (an `init` event from a hook)
 *                                                       arrived after `since`
 *
 * Mounted at the root, because the scripts live outside /api; every route carries its full
 * path. The app puts it ahead of the /api rate limit (see src/app.js).
 */

const DEFAULT_REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT = 'text/plain; charset=utf-8';

export function createInstallRouter({ query, auth, logger = console, repoRoot = DEFAULT_REPO_ROOT }) {
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

  router.get('/install.sh', sendText('install.sh'));
  router.get('/install.ps1', sendText('install.ps1', { stripBom: true }));
  router.get('/install-manual.md', sendText('docs/ai-install-runbook.md'));

  router.get('/api/install/archive', auth, async (req, res) => {
    try {
      const version = `v${SERVER_VERSION}`;
      const archive = await buildInstallArchive({ repoRoot, version });
      res.set('X-OwnMind-Release', archive.version);
      res.set('Content-Type', 'application/gzip');
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
