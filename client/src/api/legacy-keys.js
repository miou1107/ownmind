// The legacy console's localStorage key names, in a module with no imports.
//
// Two files need them and they must not disagree: legacy-handoff.js writes them when a
// signpost is followed, and auth.js clears them on logout. Putting them in either of
// those files would make the other import it, and auth.js is already imported by
// legacy-handoff.js, so the cycle would run through the credential code.
//
// Read by src/public/index.html's restoreSession() IIFE, which enters the dashboard when
// om_api_key and om_role are both present.

export const LEGACY_STORAGE_KEYS = {
  apiKey: 'om_api_key',
  role: 'om_role',
  userId: 'om_user_id',
  userName: 'om_user_name',
};
