import CryptoJS from 'crypto-js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY === 'default-key-please-change') {
  console.error('FATAL: ENCRYPTION_KEY 未設定或使用預設值，拒絕啟動。請在環境變數設定強密鑰。');
  process.exit(1);
}

/**
 * AES-256-CBC 加密
 * @param {string} text - 明文
 * @returns {string} 加密後的字串
 */
export function encrypt(text) {
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

/**
 * AES-256-CBC 解密
 * @param {string} encrypted - 加密字串
 * @returns {string} 解密後的明文
 */
export function decrypt(encrypted) {
  const bytes = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}
