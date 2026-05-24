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

// v1.19.12：信任反向代理（nginx / caddy）的 X-Forwarded-For header
// 不開的話、express-rate-limit 會用 socket IP 算次數、所有請求都被當同一個 client、誤判
// "1" 代表只信任最近 1 層 proxy（kkvin.com 的 nginx）。多層 CDN 環境要調整。
// 對應 v1.19.11 prod 容器 log 的 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR 警告
app.set('trust proxy', 1);

// 安全性與基本中介層
app.use(helmet({ contentSecurityPolicy: false }));
// CORS：只允許 CORS_ORIGIN 環境變數指定的 origin；未設定則禁止跨域
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
// JSON body limit 10MB 以容納 scanner 500-event batch（單 event 可達 ~2KB）
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
// v1.19.8 code-review I-1：跟 /api/admin/setup 對齊、避免被誤打
// （first_run 階段不會擋使用者試錯、因為這個限制是 15 分鐘 10 次、夠他試密碼格式；
// 建好 admin 後 endpoint 自動回 403、rate limit 只是防誤打的後盾）
app.use('/api/setup/init', authLimiter);
app.use('/api', apiLimiter);

// v1.19.8：first-run redirect middleware
// users 表為空 → /admin/* 自動 redirect 到 /setup（首次安裝引導）
// users 表非空 → /setup 自動 redirect 到 /admin/login（避免使用者誤入已關閉的 wizard）
// 掛在 /admin static 之前才能截到 GET /admin/login
import { firstRunRedirect } from './middleware/first-run-redirect.js';
app.use(firstRunRedirect);

// 靜態檔案（Admin 後台）
app.use('/admin', express.static(join(__dirname, 'public')));

// v1.20：新版統合後台（並存於舊 /admin 與 /me、單一入口含三角色分流）
// SPA fallback 用 middleware（Express 5 path-to-regexp 不再接受 /dashboard/* 舊式 wildcard）
// 流程：express.static 先試找檔案、找不到才走 fallback 回 index.html 讓 react-router 接管
app.use('/dashboard', express.static(join(__dirname, 'public', 'dashboard')));
app.use('/dashboard', (req, res, next) => {
  // 只對 GET 請求做 SPA fallback、其他方法（POST 等）走原本錯誤處理
  if (req.method !== 'GET') return next();
  // 排除帶副檔名的請求（asset/image/font 等）— 找不到就讓它正常 404、不要回 HTML
  // 否則瀏覽器收到 HTML 當圖片解析、快取會壞
  if (req.path.includes('.')) return next();
  const filePath = join(__dirname, 'public', 'dashboard', 'index.html');
  res.sendFile(filePath, (err) => {
    if (err) next();
  });
});

// v1.19.8：setup wizard 靜態頁（serve src/public/setup.html）
// 直接吃 / 路徑下的 setup.html、不需要獨立資料夾
app.get('/setup', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'setup.html'));
});

// v1.17.24: 用戶用量報告頁（user role 也可看，路徑 /ownmind/me/）
// v1.17.88: 加 trailing slash redirect — /me 沒尾斜線直接 404，現在 301 → me/
// 用相對路徑 redirect（'me/' 而非 '/me/'）避免 nginx reverse proxy strip 掉
// /ownmind prefix 後 Location header 變絕對路徑、把使用者導到沒 prefix 的 /me/。
// 相對 'me/' 對當前 URL /ownmind/me 而言會被瀏覽器拼成 /ownmind/me/ ✓
// 條件式：只在 originalUrl 不以 / 結尾時 redirect，否則 next() 給 static middleware。
// （Express 預設 strict routing=false，/me 跟 /me/ 都會 match 這條 route）
app.get('/me', (req, res, next) => {
  if (req.originalUrl.endsWith('/')) return next();
  res.redirect(301, 'me/');
});
app.use('/me', express.static(join(__dirname, 'public', 'me')));

// 請求日誌
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// 掛載路由
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
import { query } from './utils/db.js';
import auth from './middleware/auth.js';

// v1.19.8：setup wizard API endpoints（公開、無需 auth）
// 必須在 /api/admin 之前 mount，避免 /api/admin 吃掉
app.use('/api/setup', setupRoutes);

// v1.19.9：admin 緊急重設他人密碼（必須在 /api/admin 之前 mount）
// path 是 /api/admin/users/:id/reset-password
app.use('/api/admin/users', adminPasswordResetRoutes);

app.use('/api/memory', memoryRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/handoff', handoffRoutes);
// 子路徑要在 /api/admin 之前 mount，否則 adminRoutes 會吃掉
app.use('/api/admin/work-log', adminWorkLogRoutes);
app.use('/api/admin/iron-rules', adminIronRuleUpgradeRoutes);  // v1.18.0 升級助手
app.use('/api/admin', adminRoutes);
app.use('/api/secret', secretRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/broadcast', broadcastRoutes);
// 子路徑要在 /api/me 之前 mount，否則 meRoutes 會先接到請求並回 404
app.use('/api/me/narrative', createNarrativeRouter({ query, auth }));
app.use('/api/me', meRoutes);
app.use('/api/bug-reports', bugReportsRoutes);
app.use('/api/debug', createDebugRouter({ query, auth }));

// 根路徑導向 Admin
app.get('/', (req, res) => {
  res.redirect('/ownmind/admin/');
});

// 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Public bootstrap scripts — served without auth so fresh machines can
// `curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash` before they
// have an API key. See docs/superpowers/plans/2026-04-23-universal-bootstrap.md.
//
// Read once at boot instead of per-request sendFile: (a) avoids needing the
// `dotfiles: 'allow'` option when tests run inside hidden worktree paths;
// (b) served content is guaranteed to match the deployed commit (no hot-reload
// drift); (c) zero disk I/O per request.
import { readFileSync } from 'fs';
// v1.17.10 回報者 Adam：bootstrap.ps1 在磁碟保留 UTF-8 BOM 支援 `powershell -File`
// (PS 5.1 需要 BOM 才能正確讀中文)，但 `iwr | iex` 路徑會把開頭 \uFEFF 當 cmdlet
// 呼叫，吐 warning。serve 時 strip 首字元 BOM 讓 iex 安靜執行。
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

// 錯誤處理中介層
app.use((err, req, res, next) => {
  logger.error('未捕獲的錯誤', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || '伺服器內部錯誤'
  });
});

export default app;
