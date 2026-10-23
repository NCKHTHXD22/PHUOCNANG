const axios = require('axios');
const CONFIG = require('../config');
const { readJSON, writeJSON } = require('./localStore');

// ============================================================
// Vòng đời token Zalo OA — lưu trên VPS tại <DATA_DIR>/zalo-token.json (thay Redis).
// - Khởi động: đọc file (nếu có) → refresh ngay để có access token mới.
// - Tự refresh trước khi hết hạn ~2 giờ (TTL access token = 90.000s = 25 giờ).
// - zaloApi.js gặp lỗi -216 (hết hạn) sẽ gọi refreshAccessToken() rồi thử lại.
// Lưu ý: refresh token Zalo chỉ dùng được 1 lần — KHÔNG chạy 2 tiến trình server cùng lúc
// trên cùng 1 OA, tiến trình thứ 2 refresh sẽ làm hỏng token của tiến trình kia.
// ============================================================

const TOKEN_KEY = 'zalo-token';
const EXPIRES_IN_MS = 90000 * 1000;
const REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;

const saved = readJSON(TOKEN_KEY, {});
let _accessToken = saved.access_token || CONFIG.ZALO_OA_TOKEN;
let _refreshToken = saved.refresh_token || CONFIG.ZALO_REFRESH_TOKEN;
let _updatedAt = saved.updated_at || null;
let _refreshTimer = null;
let _refreshing = null;

if (saved.access_token) console.log('[ZaloToken] Đọc token từ file lưu trên VPS');

function persist() {
  _updatedAt = new Date().toISOString();
  try {
    // mode 0o600: chỉ user chạy server đọc được file token
    writeJSON(TOKEN_KEY, { access_token: _accessToken, refresh_token: _refreshToken, updated_at: _updatedAt }, { mode: 0o600 });
  } catch (err) {
    console.error('[ZaloToken] Không ghi được file token:', err.message);
  }
}

function getToken() {
  return _accessToken;
}

function getTokenInfo() {
  return { hasAccessToken: Boolean(_accessToken), hasRefreshToken: Boolean(_refreshToken), updatedAt: _updatedAt };
}

function scheduleRefresh(delayMs) {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(async () => {
    console.log('[ZaloToken] Proactive refresh token trước khi hết hạn...');
    try {
      await refreshAccessToken();
    } catch (err) {
      console.error('[ZaloToken] Proactive refresh thất bại:', err.message);
      scheduleRefresh(10 * 60 * 1000);
    }
  }, delayMs);
  const hours = Math.round(delayMs / 3600000 * 10) / 10;
  console.log(`[ZaloToken] Sẽ tự refresh sau ${hours} giờ`);
}

async function doRefresh() {
  if (!CONFIG.ZALO_APP_ID || !CONFIG.ZALO_APP_SECRET || !_refreshToken) {
    throw new Error('Thiếu ZALO_APP_ID / ZALO_APP_SECRET / refresh token');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('app_id', CONFIG.ZALO_APP_ID);
  params.append('refresh_token', _refreshToken);

  const res = await axios.post(
    'https://oauth.zaloapp.com/v4/oa/access_token',
    params,
    { headers: { secret_key: CONFIG.ZALO_APP_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, refresh_token } = res.data;
  if (!access_token) throw new Error(`Refresh thất bại: ${JSON.stringify(res.data)}`);

  _accessToken = access_token;
  if (refresh_token) _refreshToken = refresh_token;
  persist();
  console.log('[ZaloToken] Refresh thành công, đã lưu vào file trên VPS');

  scheduleRefresh(EXPIRES_IN_MS - REFRESH_BEFORE_MS);
  return access_token;
}

// Gộp các lần gọi refresh đồng thời (nhiều request cùng gặp -216) thành 1 — refresh token
// chỉ dùng được 1 lần, gọi song song sẽ có lần bị Zalo từ chối.
function refreshAccessToken() {
  if (!_refreshing) {
    _refreshing = doRefresh().finally(() => { _refreshing = null; });
  }
  return _refreshing;
}

async function setTokensManually(accessToken, refreshToken) {
  _accessToken = accessToken;
  _refreshToken = refreshToken;
  persist();
  console.log('[ZaloToken] Token được set thủ công, đã lưu vào file trên VPS');
  scheduleRefresh(EXPIRES_IN_MS - REFRESH_BEFORE_MS);
}

(async () => {
  try {
    await refreshAccessToken();
    console.log('[ZaloToken] Khởi động: Lấy access token mới thành công');
  } catch (err) {
    console.error('[ZaloToken] Khởi động: Không thể refresh:', err.message);
    if (_accessToken) console.warn('[ZaloToken] Dùng token hiện có làm fallback, retry sau 10 phút');
    scheduleRefresh(10 * 60 * 1000);
  }
})();

module.exports = { getToken, getTokenInfo, refreshAccessToken, setTokensManually };
