import auth from './auth.js';

/**
 * 管理員認證中介層
 * 先驗證 API Key，再檢查是否為 admin 角色
 */
export default function adminAuth(req, res, next) {
  auth(req, res, (err) => {
    if (err) return next(err);

    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    next();
  });
}
