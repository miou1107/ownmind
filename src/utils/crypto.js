import CryptoJS from 'crypto-js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY === 'default-key-please-change') {
  console.error('FATAL: ENCRYPTION_KEY is not set or uses the default value; refusing to start. Set a strong key in the environment variables.');
  process.exit(1);
}

/**
 * AES-256-CBC encryption
 * @param {string} text - plaintext
 * @returns {string} the encrypted string
 */
export function encrypt(text) {
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

/**
 * AES-256-CBC decryption
 * @param {string} encrypted - the encrypted string
 * @returns {string} the decrypted plaintext
 */
export function decrypt(encrypted) {
  const bytes = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}
