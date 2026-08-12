import auth from './auth.js';

// The ranking moved to utils/roles.js so authorization decisions can import it without
// pulling in this middleware and, through auth.js, the database pool. Imported rather than
// re-exported straight through, because the guards below call it by name; re-exported
// because every existing caller imports it from this module.
import { isAtLeast } from '../utils/roles.js';

export { isAtLeast };

/**
 * adminAuth — allows admin + super_admin
 */
export default function adminAuth(req, res, next) {
  auth(req, res, (err) => {
    if (err) return next(err);

    if (!req.user || !isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    next();
  });
}

/**
 * superAdminAuth — allows super_admin only
 */
export function superAdminAuth(req, res, next) {
  auth(req, res, (err) => {
    if (err) return next(err);

    if (!req.user || req.user.role !== 'super_admin') {
      return res.status(403).json({ error: '需要超級管理員權限' });
    }

    next();
  });
}
