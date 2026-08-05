// The retired console's localStorage key names.
//
// Nothing writes these any more: the signpost that handed the credential across went with
// the console in v1.26.60. They are kept because browsers that used the old console still
// hold them, and `om_api_key` is a live credential string — every adminAuth route accepts
// it. auth.js clears them on logout so a machine that once used the old console stops
// carrying one around.
//
// Drop this file once enough time has passed that no browser still has them.

export const LEGACY_STORAGE_KEYS = {
  apiKey: 'om_api_key',
  role: 'om_role',
  userId: 'om_user_id',
  userName: 'om_user_name',
};
