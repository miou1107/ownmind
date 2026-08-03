// API 模組 barrel — 統一對外 export
// 用法：import { apiGet, getApiKey } from '@/api';（或相對路徑）

export { apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client.js';
export {
  getApiKey, setApiKey, clearApiKey,
  getMustChangePassword, setMustChangePassword, clearMustChangePassword,
} from './auth.js';
