import auth from './auth.js';

const ROLE_RANK = { user: 0, admin: 1, super_admin: 2 };

export function isAtLeast(userRole, required) {
  return (ROLE_RANK[userRole] ?? -1) >= (ROLE_RANK[required] ?? 99);
}

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
