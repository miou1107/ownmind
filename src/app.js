import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// v1.19.12: trust the reverse proxy's (nginx / caddy) X-Forwarded-For header
// Without this, express-rate-limit counts by socket IP, treats all requests as the
// same client, and false-positives.
// "1" means trust only the nearest 1 proxy layer (example.com's nginx). Multi-layer CDN
// environments need adjusting.
// Addresses the ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning in the v1.19.11 prod container log
app.set('trust proxy', 1);

// security and basic middleware
app.use(helmet({ contentSecurityPolicy: false }));
// CORS: only allow the origin specified by the CORS_ORIGIN env var; if unset, block cross-origin
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
// JSON body limit 10MB to fit a scanner 500-event batch (a single event can be ~2KB)
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '請求太頻繁，請稍後再試' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登入嘗試太頻繁，請 15 分鐘後再試' },
});
app.use('/api/admin/login', authLimiter);
app.use('/api/admin/setup', authLimiter);
// v1.19.8 code-review I-1: align with /api/admin/setup to avoid being hit by mistake
// (during first_run this won't block a user's trial-and-error, because the limit is
// 10 times per 15 minutes, enough to try password formats; once an admin exists the
// endpoint auto-returns 403, and the rate limit is just a backstop against stray hits)
app.use('/api/setup/init', authLimiter);
app.use('/api', apiLimiter);

// v1.19.8: first-run redirect middleware
// users table empty → /admin/* auto-redirects to /setup (first-install guide)
// users table non-empty → /setup auto-redirects to /admin/login (avoid users wandering into the closed wizard)
// must be mounted before the /admin static handler to intercept GET /admin/login
import { firstRunRedirect } from './middleware/first-run-redirect.js';
app.use(firstRunRedirect);

// static files (Admin backend)
app.use('/admin', express.static(join(__dirname, 'public')));

// v1.20: the new unified backend (coexists with the old /admin and /me; a single entry with three-role routing)
// SPA fallback uses middleware (Express 5's path-to-regexp no longer accepts the old /dashboard/* wildcard)
// Flow: express.static tries to find the file first; only on miss does the fallback return index.html for react-router to take over
app.use('/dashboard', express.static(join(__dirname, 'public', 'dashboard')));
app.use('/dashboard', (req, res, next) => {
  // only do SPA fallback for GET requests; other methods (POST etc.) go to the normal error handling
  if (req.method !== 'GET') return next();
  // exclude requests with a file extension (asset/image/font etc.) — on miss, let it 404 normally, don't return HTML
  // otherwise the browser parses HTML as an image and the cache breaks
  if (req.path.includes('.')) return next();
  const filePath = join(__dirname, 'public', 'dashboard', 'index.html');
  res.sendFile(filePath, (err) => {
    if (err) next();
  });
});

// v1.19.8: setup wizard static page (serves src/public/setup.html)
// serves setup.html directly under the / path, no separate folder needed
app.get('/setup', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'setup.html'));
});

// v1.17.24: user usage report page (the user role can view it too, path /ownmind/me/)
// v1.17.88: added a trailing-slash redirect — /me without a trailing slash 404'd directly, now 301 → me/
// Use a relative redirect ('me/' not '/me/') to avoid nginx reverse proxy stripping it:
// after the /ownmind prefix the Location header would become absolute and send the user
// to a /me/ without the prefix.
// Relative 'me/' against the current URL /ownmind/me is joined by the browser into /ownmind/me/ ✓
// Conditional: only redirect when originalUrl does not end with /, otherwise next() to the static middleware.
// (Express defaults to strict routing=false, so both /me and /me/ match this route)
app.get('/me', (req, res, next) => {
  if (req.originalUrl.endsWith('/')) return next();
  res.redirect(301, 'me/');
});
app.use('/me', express.static(join(__dirname, 'public', 'me')));

// request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// mount routes
import memoryRoutes from './routes/memory.js';
import sessionRoutes from './routes/session.js';
import handoffRoutes from './routes/handoff.js';
import adminRoutes from './routes/admin.js';
import secretRoutes from './routes/secret.js';
import exportRoutes from './routes/export.js';
import activityRoutes from './routes/activity.js';
import usageRoutes from './routes/usage/index.js';
import broadcastRoutes from './routes/broadcast.js';
import adminWorkLogRoutes from './routes/admin-work-log.js';
import adminIronRuleUpgradeRoutes from './routes/admin-iron-rule-upgrade.js';
import meRoutes from './routes/me.js';
import { createNarrativeRouter } from './routes/me-narrative.js';
import { createDebugRouter } from './routes/debug.js';
import setupRoutes from './routes/setup.js';
import adminPasswordResetRoutes from './routes/admin-password-reset.js';
import bugReportsRoutes from './routes/bug-reports.js';
import { createVersionRouter } from './routes/version.js';
import { query } from './utils/db.js';
import auth from './middleware/auth.js';

// v1.19.8: setup wizard API endpoints (public, no auth needed)
// must be mounted before /api/admin to avoid /api/admin swallowing them
app.use('/api/setup', setupRoutes);

// v1.19.9: admin emergency reset of another user's password (must be mounted before /api/admin)
// the path is /api/admin/users/:id/reset-password
app.use('/api/admin/users', adminPasswordResetRoutes);

app.use('/api/memory', memoryRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/handoff', handoffRoutes);
// sub-paths must be mounted before /api/admin, otherwise adminRoutes swallows them
app.use('/api/admin/work-log', adminWorkLogRoutes);
app.use('/api/admin/iron-rules', adminIronRuleUpgradeRoutes);  // v1.18.0 upgrade assistant
app.use('/api/admin', adminRoutes);
app.use('/api/secret', secretRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/broadcast', broadcastRoutes);
// sub-paths must be mounted before /api/me, otherwise meRoutes receives the request first and 404s
app.use('/api/me/narrative', createNarrativeRouter({ query, auth }));
app.use('/api/me', meRoutes);
app.use('/api/bug-reports', bugReportsRoutes);
app.use('/api/debug', createDebugRouter({ query, auth }));
app.use('/api/version', createVersionRouter({ auth }));

// root path redirects to Admin
app.get('/', (req, res) => {
  res.redirect('/ownmind/admin/');
});

// health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Public bootstrap scripts — served without auth so fresh machines can
// `curl -fsSL https://example.com/ownmind/bootstrap.sh | bash` before they
// have an API key. See docs/superpowers/plans/2026-04-23-universal-bootstrap.md.
//
// Read once at boot instead of per-request sendFile: (a) avoids needing the
// `dotfiles: 'allow'` option when tests run inside hidden worktree paths;
// (b) served content is guaranteed to match the deployed commit (no hot-reload
// drift); (c) zero disk I/O per request.
import { readFileSync } from 'fs';
// v1.17.10 reporter Bob: bootstrap.ps1 keeps a UTF-8 BOM on disk to support `powershell -File`
// (PS 5.1 needs the BOM to read Chinese correctly), but the `iwr | iex` path treats the leading U+FEFF as a cmdlet
// call and emits a warning. On serve, strip the leading BOM so iex runs quietly.
function stripBom(s) {
  return s.length > 0 && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
const bootstrapSh = stripBom(readFileSync(join(__dirname, '..', 'scripts', 'bootstrap.sh'), 'utf8'));
const bootstrapPs1 = stripBom(readFileSync(join(__dirname, '..', 'scripts', 'bootstrap.ps1'), 'utf8'));
app.get('/bootstrap.sh', (req, res) => {
  res.type('text/x-shellscript; charset=utf-8').send(bootstrapSh);
});
app.get('/bootstrap.ps1', (req, res) => {
  res.type('text/plain; charset=utf-8').send(bootstrapPs1);
});

// error-handling middleware
app.use((err, req, res, next) => {
  logger.error('Uncaught error', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || '伺服器內部錯誤'
  });
});

export default app;
