/**
 * GET /api/version — the running server's version, for the dashboard footer.
 *
 * The version was already reachable through GET /api/memory/init and
 * GET /api/usage/admin/clients, but neither suits a footer that every signed-in
 * user sees: init returns the caller's whole compact memory set, and the clients
 * endpoint is admin-only and computes install coverage. This returns one string.
 *
 * Behind auth deliberately. The only consumer renders inside the dashboard
 * shell, which is already gated by RequireAuth, so requiring a key costs
 * nothing — and an unauthenticated version endpoint on a public instance just
 * tells a scanner which release to look up advisories for.
 */

import express from 'express';
import { SERVER_VERSION } from '../utils/server-version.js';

export function createVersionRouter({ auth }) {
  const router = express.Router();

  router.get('/', auth, (req, res) => {
    res.json({ version: SERVER_VERSION });
  });

  return router;
}
