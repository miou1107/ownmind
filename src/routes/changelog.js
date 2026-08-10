/**
 * GET /api/changelog — recent releases, for the dashboard footer's timeline.
 *
 * Behind auth for the same reason GET /api/version is: the only consumer renders
 * inside the dashboard shell, which is already gated by RequireAuth, so
 * requiring a key costs nothing — and release notes handed to an unauthenticated
 * scanner are a list of the fixes this instance may not have yet.
 *
 * Parsed once at module load. CHANGELOG.md cannot change under a running
 * process: a new changelog arrives only with a new image, which is a new
 * process.
 */

import express from 'express';
import { loadChangelogEntries } from '../utils/changelog.js';

const ENTRIES = loadChangelogEntries();

export function createChangelogRouter({ auth }) {
  const router = express.Router();

  router.get('/', auth, (req, res) => {
    res.json({ entries: ENTRIES });
  });

  return router;
}
