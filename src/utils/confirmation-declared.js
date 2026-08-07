/**
 * v1.26.97 — how a bug report's submit confirmation was obtained, as declared by the client.
 *
 * `confirm_string` is checked for its value, which is not the same as knowing who typed it.
 * The server sees a string equal to the expected phrase and has no way to tell the person
 * from the AI acting on their behalf — they authenticate with the same API key, since
 * console login returns that same key. Demonstrated in bug report #18, which was itself
 * filed without the user typing anything.
 *
 * So this records a claim, not a fact, and the name says so. Splitting the credentials is
 * the only thing that would make it a fact; that is backlog 36.
 *
 * Shared by the route and its tests rather than duplicated, so the two cannot drift — the
 * same arrangement as src/utils/activity-insert.js.
 */

/** Values a client may declare. Anything else is not trusted into one of these. */
export const DECLARED_VALUES = ['user_typed', 'ai_filled'];

/** What an absent, unrecognised or malformed declaration is recorded as. */
export const DECLARED_UNKNOWN = 'unknown';

/**
 * @param {unknown} value — whatever arrived in the request body
 * @returns {'user_typed' | 'ai_filled' | 'unknown'}
 *
 * Unrecognised input becomes `unknown`, never `user_typed`: a missing field must not read
 * as the stronger of the two, and an older client that does not send the field at all is
 * exactly that case.
 */
export function normalizeConfirmationDeclared(value) {
  return DECLARED_VALUES.includes(value) ? value : DECLARED_UNKNOWN;
}
