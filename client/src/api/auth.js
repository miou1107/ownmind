// 認證 token 管理 — 統一 localStorage 存取，避免散落
// api_key 由 POST /api/me/login 拿到、所有後續 API 請求都帶 Bearer header
//
// 同時管理 must_change_password 旗標（user 預設密碼還沒改、必須先改才能用其他功能）
//
// 用法：
//   import { getApiKey, setApiKey, clearApiKey } from './auth';
//   setApiKey('abc123');
//   const key = getApiKey();  // 'abc123' or null
//   clearApiKey();           // 登出時用、會一併清 must_change_password

const STORAGE_KEY = 'ownmind.api_key';
const STORAGE_KEY_MUST_CHANGE = 'ownmind.must_change_password';

import { SESSION_CHANGED } from './events.js';
import { LEGACY_STORAGE_KEYS } from './legacy-keys.js';

// Announce a key change so the session provider refetches the identity.
//
// Deliberately not left to callers: making LoginPage remember to call refresh() after
// setApiKey() is exactly the kind of instruction that gets dropped when a second login
// path appears. The project rule is to enforce with logic rather than memory, so the
// write itself notifies.
function notifySessionChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SESSION_CHANGED));
}

export function getApiKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setApiKey(key) {
  if (!key || typeof key !== 'string') return;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // 隱私模式 / quota 滿 — 忽略，下次重新登入即可
  }
  notifySessionChanged();
}

export function clearApiKey() {
  // 一併清 must_change_password 旗標、避免下次別 user 登入時讀到上次殘留
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY_MUST_CHANGE);
    // v1.26.46：連舊後台那四個鍵一起清。
    //
    // 指路牌會把一把「真的可以用」的憑證寫進 om_api_key 交給舊後台（見
    // legacy-handoff.js）。只清自己那一份的話，一個點過指路牌的管理員在新後台登出之後
    // om_api_key 還留著，下一個在同一台瀏覽器打開 /admin/ 的人會被舊後台的
    // restoreSession() 直接還原成他的身分，而且那把 key 每一支 adminAuth API 都通。
    // 改之前瀏覽器裡只有一個地方放這個憑證、而且舊後台的登出會清它；多寫一個地方就
    // 必須連同這裡一起清，否則登出等於沒登出。
    for (const key of Object.values(LEGACY_STORAGE_KEYS)) {
      localStorage.removeItem(key);
    }
  } catch {
    // 同上
  }
  notifySessionChanged();
}

// must_change_password 旗標：true 時 RequireFreshPassword 守門員會強制導 /preference/security
// login 時 setMustChangePassword(r.data.must_change_password)
// 改密碼成功（3.7 SecurityPage 完工後）會 clearMustChangePassword()
export function getMustChangePassword() {
  try {
    return localStorage.getItem(STORAGE_KEY_MUST_CHANGE) === '1';
  } catch {
    return false;
  }
}

export function setMustChangePassword(must) {
  try {
    if (must) {
      localStorage.setItem(STORAGE_KEY_MUST_CHANGE, '1');
    } else {
      localStorage.removeItem(STORAGE_KEY_MUST_CHANGE);
    }
  } catch {
    // 同上
  }
}

export function clearMustChangePassword() {
  try {
    localStorage.removeItem(STORAGE_KEY_MUST_CHANGE);
  } catch {
    // 同上
  }
}
