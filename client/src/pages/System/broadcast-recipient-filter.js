// v1.26.62 — suggestion filter for the 新增廣播 recipient picker.
//
// Pure on purpose: it holds no React and no fetch, so the rule deciding who
// the admin can pick is testable on its own (tests/broadcast-recipient-filter.test.js).
// It replaces a free-text user_id box, so a member the admin has already
// chosen must not appear again — that is how duplicate ids used to reach the
// payload.

/**
 * @param {Array<{id:number,name?:string,email?:string}>} users  Rows from `/api/admin/users`.
 * @param {string} query        What the admin has typed.
 * @param {Array<number>} selectedIds  Ids already turned into chips.
 * @returns {Array<object>} Matching rows in the order `users` gave them.
 */
export function filterMembers(users, query, selectedIds) {
  if (!Array.isArray(users)) return [];

  const taken = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const needle = String(query ?? '').trim().toLowerCase();

  return users.filter((u) => {
    if (!u || taken.has(u.id)) return false;
    if (needle === '') return true;
    const name = String(u.name ?? '').toLowerCase();
    const email = String(u.email ?? '').toLowerCase();
    return name.includes(needle) || email.includes(needle);
  });
}
