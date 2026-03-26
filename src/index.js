import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`OwnMind API 伺服器已啟動，監聽埠號 ${PORT}`);
});
