import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';
import { buildReadableWhere } from '../utils/memory-visibility.js';

/**
 * What a client needs in order to decide, without asking the server, whether anything is
 * relevant to this turn and whether a file is off limits.
 *
 * Three lists, because three consumers need three different things:
 *
 *   selectors    every rule, no text        the "is anything relevant" pre-filter
 *   guards       path rules, no text        the hard block on an edit
 *   injectables  annotated rules, WITH text what is put in front of the AI at prompt time
 *
 * Rule text stays on the server for `selectors`, where the judge already is. That keeps the
 * payload around 20KB for 150 rules - measured, 39 to 171 bytes of enforcement metadata per
 * rule - and, more importantly, means the judge's coverage is bounded by the database rather
 * than by whatever the client managed to cache. `injectables` is the exception because
 * injection's whole job is to put the rule's words in front of the AI; its size is bounded
 * by how many rules carry an enforcement block, not by how many rules exist.
 *
 * Every list is FLAT. The `metadata.enforcement.*` nesting belongs to the database row and
 * does not survive this function, so no client-side consumer may reach for it. An earlier
 * draft had all three consumers reading the nested shape: each one returned false on every
 * real machine and passed every test that handed it a hand-built row.
 */

const BUNDLE_TYPES = ['iron_rule', 'team_standard', 'principle', 'coding_standard'];

/**
 * @param {Array<object>} rows memory rows straight from the database
 * @returns {{selectors: Array<object>, guards: Array<object>, injectables: Array<object>}}
 */
export function buildBundle(rows) {
  const selectors = [];
  const guards = [];
  const injectables = [];

  for (const row of rows || []) {
    if (!row) continue;
    const enforcement = (row.metadata && row.metadata.enforcement) || {};
    const keywords = Array.isArray(enforcement.keywords) ? enforcement.keywords : [];
    const alwaysCheck = enforcement.always_check === true;
    const guard = enforcement.guard;
    // A guard with no paths can never match anything. Listing it would report a protection
    // that does not exist, which is worse than reporting none.
    const hasGuard = Boolean(guard && Array.isArray(guard.paths) && guard.paths.length > 0);
    const repoMatch = hasGuard ? (guard.repo_match || '') : '';

    selectors.push({
      id: row.id,
      type: row.type,
      tags: Array.isArray(row.tags) ? row.tags : [],
      keywords,
      always_check: alwaysCheck,
      repo_match: repoMatch,
    });

    if (hasGuard) {
      guards.push({
        id: row.id,
        // Same reason the injectables carry it: what the assistant is told when it is blocked
        // has to match what it was told when the rule was injected. A team standard the user
        // cannot waive and a personal rule they can must not produce the same message.
        type: row.type,
        title: row.title || '',
        repo_match: repoMatch,
        paths: guard.paths,
        owner: guard.owner || '',
      });
    }

    // An un-annotated rule is still judged - the judge reads the database - it simply is not
    // pushed in front of the AI up front.
    if (keywords.length > 0 || alwaysCheck || hasGuard) {
      injectables.push({
        id: row.id,
        // The type decides which precedence sentence goes in front of this rule, and that
        // sentence is the whole point of injecting it - a team standard belongs to the
        // company and the user cannot wave it through, their own iron rule they can. Ship
        // the type or the client has to guess, and guessing here means telling someone their
        // colleague's rule is theirs to waive.
        type: row.type,
        title: row.title || '',
        content: row.judge_text || row.content || '',
        keywords,
        always_check: alwaysCheck,
        repo_match: repoMatch,
        paths: hasGuard ? guard.paths : [],
        owner: hasGuard ? (guard.owner || '') : '',
      });
    }
  }

  return { selectors, guards, injectables };
}

/**
 * @param {{queryFn?: Function}} [deps]
 * @returns {import('express').Router}
 */
export function createEnforcementBundleRouter({ queryFn = defaultQuery } = {}) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      // buildReadableWhere, not `user_id = $1`. Team standards are readable across accounts,
      // and the standard this feature was built to enforce belongs to a colleague, not to
      // the account running the check - measured against a real database: an owner-scoped
      // query cannot see it at all.
      const result = await queryFn(
        `SELECT m.id, m.type, m.code, m.title, m.content, m.tags, m.metadata
           FROM memories m
          WHERE m.status = 'active'
            AND m.type IN (${BUNDLE_TYPES.map((_, i) => `$${i + 2}`).join(', ')})
            AND ${buildReadableWhere({ alias: 'm', userParam: '$1' })}`,
        [req.user?.id, ...BUNDLE_TYPES],
      );
      return res.json(buildBundle(result.rows));
    } catch (err) {
      // Deliberately not an empty bundle. Empty is indistinguishable from "this account has
      // no rules", and the client's empty-response guard would then hold a stale cache
      // forever without anyone being told the sync had stopped working.
      logger.warn?.('enforcement-bundle: query failed', { err: err.message });
      return res.status(500).json({ error: 'failed to build enforcement bundle' });
    }
  });

  return router;
}

export default createEnforcementBundleRouter;
