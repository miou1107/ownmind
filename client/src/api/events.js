// Cross-layer event names, in one place both layers may import.
//
// These were duplicated as bare string literals: 'ownmind:session-changed' was written
// independently in api/auth.js and session/SessionContext.jsx, and 'ownmind:auth-expired'
// in three files. The covering tests asserted only that dispatchEvent and addEventListener
// appeared somewhere, so a one-character typo in either half would have silently disabled
// the refresh — login would show a role-less console until a manual reload — with the
// suite still green.
//
// This module lives under api/ rather than session/ so the api layer needs no dependency
// on the session layer.

/** A stored credential changed, so anything derived from it should reload. */
export const SESSION_CHANGED = 'ownmind:session-changed';

/** The credential is gone or rejected; whoever owns routing should return to /login. */
export const AUTH_EXPIRED = 'ownmind:auth-expired';
