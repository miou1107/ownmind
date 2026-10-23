// GET /api/admin/users — the team list, with the four fields behind the team page's
// "最近一次載入記憶" column.
//
// The column answers one question for the admin: is this member's OwnMind actually loading
// memories on their computer? Memory loads are hook-sourced `init` events in activity_logs;
// installs and install errors are install_check_logs rows. One query serves the whole team
// (lateral joins per user, both riding their (user_id, ...) indexes), so the page costs one
// round trip however many members there are.
//
// v1.30.38: the full api_key is not in this list. Authentication looks a user up by key alone,
// so every admin holding every key — the super_admin's included — let any admin act as the
// super_admin. The prefix is for display; the full key comes one user at a time from
// GET /users/:id/api-key (src/routes/admin-api-key.js).
//
// v1.26.49: must_change_password is here so the page can show whether each user is still on
// their initial password.

export const LIST_USERS_SQL = `
  SELECT u.id, u.name, u.email, u.role,
         LEFT(u.api_key, 8) AS api_key_prefix,
         u.must_change_password, u.created_at, u.updated_at, u.deactivated_at,
         m.last_memory_load_at,
         i.last_machine,
         i.first_install_at,
         i.last_install_error_at
  FROM users u
  LEFT JOIN LATERAL (
    SELECT a.ts AS last_memory_load_at
    FROM activity_logs a
    WHERE a.user_id = u.id AND a.event = 'init' AND a.source = 'hook'
    ORDER BY a.ts DESC
    LIMIT 1
  ) m ON TRUE
  LEFT JOIN LATERAL (
    SELECT MIN(c.ts) AS first_install_at,
           -- An install error is an error_* report, or a post_install report whose
           -- self-check counted at least one failure.
           MAX(c.ts) FILTER (
             WHERE LEFT(c.trigger_kind, 6) = 'error_'
                OR (c.trigger_kind = 'post_install'
                    AND CASE WHEN jsonb_typeof(c.summary->'fail') = 'number'
                             THEN (c.summary->>'fail')::numeric > 0 ELSE FALSE END)
           ) AS last_install_error_at,
           (ARRAY_AGG(c.machine ORDER BY c.ts DESC) FILTER (WHERE c.machine IS NOT NULL))[1] AS last_machine
    FROM install_check_logs c
    WHERE c.user_id = u.id
  ) i ON TRUE
  ORDER BY u.created_at DESC
`;

export function createListUsersHandler({ query, logger }) {
  return async function listUsers(req, res) {
    try {
      const result = await query(LIST_USERS_SQL);
      res.json(result.rows);
    } catch (err) {
      logger.error('list users failed', { error: err.message });
      res.status(500).json({ error: '查詢失敗' });
    }
  };
}
