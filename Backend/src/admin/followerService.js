const axios = require('axios');
const { getToken, refreshAccessToken } = require('../utils/zaloToken');
const { readJSON, writeJSON } = require('../utils/localStore');
const { getProfiles } = require('./profileCache');

const STORE_KEY = 'followers';

// In-memory cache
let _cache = null;
let _syncedAt = null;

// Danh sách follower lưu trên VPS tại <DATA_DIR>/followers.json (thay Redis)
function saveToFile(followers) {
  try {
    writeJSON(STORE_KEY, { followers, syncedAt: _syncedAt });
  } catch (e) {
    console.warn('[Follower] Không lưu được file:', e.message);
  }
}

function loadFromFile() {
  return readJSON(STORE_KEY, null);
}

// ─── Zalo API helpers ───
async function zaloGet(url) {
  const doReq = (token) => axios.get(url, { headers: { access_token: token } });
  let res = await doReq(getToken());
  if (res.data?.error === -216) {
    try {
      const newToken = await refreshAccessToken();
      res = await doReq(newToken);
    } catch (refreshErr) {
      throw new Error('TOKEN_EXPIRED');
    }
  }
  return res.data;
}

async function fetchAllFollowerIds() {
  const ids = [];
  let offset = 0;
  const count = 50;

  while (true) {
    const data = encodeURIComponent(JSON.stringify({ offset, count }));
    const result = await zaloGet(
      `https://openapi.zalo.me/v2.0/oa/getfollowers?data=${data}`
    );

    if (result?.error !== 0) {
      console.error('[Follower] Lỗi lấy follower:', result?.message);
      break;
    }

    const followers = result?.data?.followers || [];
    for (const f of followers) ids.push(f.user_id);

    if (followers.length < count) break;
    offset += count;
    await new Promise((r) => setTimeout(r, 300));
  }

  return ids;
}

async function getFollowerProfile(userId) {
  // Template literal giữ userId là số nguyên, tránh lỗi -201 "user_id is not valid"
  const data = encodeURIComponent(`{"user_id":${userId}}`);
  const result = await zaloGet(
    `https://openapi.zalo.me/v2.0/oa/getprofile?data=${data}`
  );
  if (result?.error !== 0) return { user_id: userId, display_name: '', avatar: '' };
  return {
    user_id: userId,
    display_name: result?.data?.display_name || '',
    avatar: result?.data?.avatar || '',
  };
}

// ─── Public API ───
async function syncFollowers() {
  console.log('[Follower] Đang đồng bộ danh sách follower...');
  const ids = await fetchAllFollowerIds();

  // Lấy profile từ cache webhook trước
  const profileMap = await getProfiles(ids);

  // Fetch từ Zalo API cho những user chưa có tên (hoạt động tốt từ IP Việt Nam)
  const missingIds = ids.filter(id => !profileMap[id]?.display_name);
  console.log(`[Follower] Cần fetch ${missingIds.length} profile từ Zalo API...`);
  for (const userId of missingIds) {
    try {
      const profile = await getFollowerProfile(userId);
      if (profile.display_name) {
        profileMap[userId] = profile;
        const { saveProfile } = require('./profileCache');
        await saveProfile(userId, profile.display_name, profile.avatar);
      }
    } catch { /* bỏ qua lỗi profile từng user */ }
    await new Promise(r => setTimeout(r, 250));
  }

  const profiles = ids.map(id => ({
    user_id: id,
    display_name: profileMap[id]?.display_name || '',
    avatar: profileMap[id]?.avatar || '',
  }));

  _cache = profiles;
  _syncedAt = new Date().toISOString();

  saveToFile(profiles);

  console.log(`[Follower] Đã đồng bộ ${profiles.length} follower`);
  return profiles;
}

async function getStoredFollowers() {
  if (_cache) return _cache;

  const fromFile = loadFromFile();
  if (fromFile?.followers) {
    _cache = fromFile.followers;
    _syncedAt = fromFile.syncedAt;
    return _cache;
  }

  return [];
}

async function getSyncedAt() {
  if (_syncedAt) return _syncedAt;
  const fromFile = loadFromFile();
  return fromFile?.syncedAt || null;
}

module.exports = { syncFollowers, getStoredFollowers, getSyncedAt };
