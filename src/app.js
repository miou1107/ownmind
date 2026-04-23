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
app.use('/api', apiLimiter);

// 靜態檔案（Admin 後台）
app.use('/admin', express.static(join(__dirname, 'public')));

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

app.use('/api/memory', memoryRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/handoff', handoffRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/secret', secretRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/broadcast', broadcastRoutes);

// 根路徑導向 Admin
app.get('/', (req, res) => {
  res.redirect('/ownmind/admin/');
});

// 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 錯誤處理中介層
app.use((err, req, res, next) => {
  logger.error('未捕獲的錯誤', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || '伺服器內部錯誤'
  });
});

export default app;
