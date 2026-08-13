/**
 * Action gate: guard matching against real command lines.
 *
 * Matches action guards against a detected command trigger, including special
 * handling for version-tag pushes which are deployments even when the general
 * classifier detects them as plain git pushes.
 */

import { detectCommandTrigger } from '../../shared/helpers.js';

/**
 * Regex for version-tag pushes.
 * Matches git push commands with version-like tags that indicate a deployment.
 * Examples: v0.35.13, ima-v1.2.9, ima-rc123
 */
const TAG_PUSH = /git\s+push\b.*\s(?:refs\/tags\/)?(?:v\d|ima-v|ima-rc)/;

/**
 * Match action guards whose triggers include the detected command trigger.
 *
 * Detects the trigger from the command using detectCommandTrigger. Also
 * applies special logic for version-tag pushes, which count as deployments
 * even if the general classifier identifies them as plain git pushes.
 *
 * @param {string} command — bash command
 * @param {Array} guards — array of guard objects
 * @returns {Array} guards whose triggers match the detected trigger
 */
export function matchGuards(command, guards) {
  // Reject null/undefined/empty commands
  if (typeof command !== 'string' || !command.trim()) return [];

  // Build the set of triggers this command activates
  const triggers = new Set();

  // Detect trigger from command classifier
  const detected = detectCommandTrigger(command);
  if (detected) triggers.add(detected);

  // Special case: version-tag pushes are deployments
  if (TAG_PUSH.test(command)) triggers.add('deploy');

  // No triggers matched, return empty array
  if (!triggers.size) return [];

  // Filter guards: only action guards with matching triggers
  return (guards || []).filter(
    (g) =>
      g &&
      g.kind === 'action' &&
      Array.isArray(g.triggers) &&
      g.triggers.some((t) => triggers.has(t))
  );
}
