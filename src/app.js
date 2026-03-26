import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import logger from './utils/logger.js';

const app = express();

// 安全性與基本中介層
app.use(helmet());
app.use(cors());
app.use(express.json());

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

app.use('/api/memory', memoryRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/handoff', handoffRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/secret', secretRoutes);
app.use('/api/export', exportRoutes);

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
