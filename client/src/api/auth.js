// 登入憑證管理 — 統一 localStorage 存取，避免散落
//
// v1.31.1（資安掃描第 12 條）：存的是「登入憑證」（session token，oms_ 開頭），不再是 api_key。
// api_key 是 MCP 和每支掛勾用的永久金鑰、不會過期；以前登入就把它交給瀏覽器存在 localStorage，
// 頁面上任何一段被塞進來的程式都讀得到。登入憑證 7 天沒用、或 30 天到期、或登出、或改密碼就失效。
// 見 src/utils/web-session.js。
//
// 同時管理 must_change_password 旗標（user 預設密碼還沒改、必須先改才能用其他功能）
//
// 用法：
//   import { getSessionToken, setSessionToken, clearSessionToken } from './auth';

const STORAGE_KEY = 'ownmind.session';
// v1.31.1 以前存 api_key 的位置。載入時就刪掉：那是一把永久金鑰，不該再留在瀏覽器裡。
// 代價是升級後每個人要重新登入一次。
const PRE_SESSION_KEY = 'ownmind.api_key';
const STORAGE_KEY_MUST_CHANGE = 'ownmind.must_change_password';

import { SESSION_CHANGED } from './events.js';
import { LEGACY_STORAGE_KEYS } from './legacy-keys.js';

try {
  localStorage.removeItem(PRE_SESSION_KEY);
} catch {
  // 隱私模式 — 本來就存不進去
}

// Announce a key change so the session provider refetches the identity.
//
// Deliberately not left to callers: making LoginPage remember to call refresh() after
// setSessionToken() is exactly the kind of instruction that gets dropped when a second login
// path appears. The project rule is to enforce with logic rather than memory, so the
// write itself notifies.
function notifySessionChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SESSION_CHANGED));
}

export function getSessionToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setSessionToken(key) {
  if (!key || typeof key !== 'string') return;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // 隱私模式 / quota 滿 — 忽略，下次重新登入即可
  }
  notifySessionChanged();
}

export function clearSessionToken() {
  // 一併清 must_change_password 旗標、避免下次別 user 登入時讀到上次殘留
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PRE_SESSION_KEY);
    localStorage.removeItem(STORAGE_KEY_MUST_CHANGE);
    // v1.26.46：連舊後台那四個鍵一起清。當時是因為指路牌會把一把真的能用的憑證寫進
    // om_api_key 交給舊後台，只清自己那一份的話，登出等於沒登出 —— 下一個在同一台
    // 瀏覽器打開舊後台的人會被還原成上一個人。
    //
    // v1.26.60：舊後台跟指路牌都沒了，已經沒有東西會寫這四個鍵。但**照清不誤**：用過
    // 舊後台的瀏覽器裡還留著，而 om_api_key 是一把每一支 adminAuth API 都通的憑證。
    // 見 legacy-keys.js。
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
