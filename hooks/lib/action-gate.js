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
 * Check if a command matches a guard's applies_pattern.
 * If the pattern is invalid, returns true (fail toward enforcement).
 * @param {string} command
 * @param {string} pattern
 * @returns {boolean}
 */
function patternMatches(command, pattern) {
  // No pattern or empty pattern: always matches
  if (!pattern || typeof pattern !== 'string' || !pattern.trim()) return true;

  try {
    const regex = new RegExp(pattern);
    return regex.test(command);
  } catch {
    // Invalid regex: fail toward enforcement (return true)
    return true;
  }
}

/**
 * Match action guards whose triggers include the detected command trigger.
 *
 * Detects the trigger from the command using detectCommandTrigger. Also
 * applies special logic for version-tag pushes, which count as deployments
 * even if the general classifier identifies them as plain git pushes.
 *
 * Guards may carry an applies_pattern field (regex string) to further
 * restrict matching. If present, the guard only matches if the pattern
 * matches the command. Invalid patterns are treated as always matching
 * (fail toward enforcement).
 *
 * @param {string} command — bash command
 * @param {Array} guards — array of guard objects
 * @returns {Array} guards whose triggers match the detected trigger and patterns match
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

  // Filter guards: only action guards with matching triggers and patterns
  return (guards || []).filter(
    (g) =>
      g &&
      g.kind === 'action' &&
      Array.isArray(g.triggers) &&
      g.triggers.some((t) => triggers.has(t)) &&
      patternMatches(command, g.applies_pattern)
  );
}
