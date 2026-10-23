const { readJSON, writeJSON } = require('../utils/localStore');

// Cache tên + avatar Zalo của người dân, lưu trên VPS tại <DATA_DIR>/profiles.json (thay Redis).
// Giữ trong bộ nhớ, ghi xuống đĩa gộp sau 2 giây để webhook dồn dập không ghi file liên tục.
const STORE_KEY = 'profiles';
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 ngày như bản Redis cũ

let _profiles = null;
let _flushTimer = null;

function load() {
  if (!_profiles) _profiles = readJSON(STORE_KEY, {});
  return _profiles;
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    try {
      const now = Date.now();
      for (const [id, p] of Object.entries(_profiles)) {
        if (now - (p.savedAt || 0) > TTL_MS) delete _profiles[id];
      }
      writeJSON(STORE_KEY, _profiles);
    } catch (err) {
      console.error('[ProfileCache] Ghi file lỗi:', err.message);
    }
  }, 2000);
}

// Không ghi đè avatar đã có bằng rỗng — webhook Zalo thường không kèm avatar,
// chỉ Zalo Profile API (getZaloUserProfile) mới trả avatar thật đáng tin cậy.
async function saveProfile(userId, displayName, avatar = '') {
  if (!userId || !displayName || displayName === userId) return;
  const profiles = load();
  const finalAvatar = avatar || profiles[userId]?.avatar || '';
  profiles[userId] = { display_name: displayName, avatar: finalAvatar, savedAt: Date.now() };
  scheduleFlush();
}

// Lấy profile của nhiều userId từ cache; fallback gọi Zalo API nếu cache miss
// HOẶC nếu cache có nhưng thiếu avatar (webhook ghi vào trước, chưa có avatar thật).
async function getProfiles(userIds) {
  if (!userIds?.length) return {};
  const profiles = load();
  const result = {};
  for (const id of userIds) {
    if (profiles[id]) result[id] = { display_name: profiles[id].display_name, avatar: profiles[id].avatar };
  }

  const needFetch = userIds.filter(id => !result[id] || !result[id].avatar);
  if (needFetch.length) {
    // Lazy require tránh circular dependency khi module load
    const { getZaloUserProfile } = require('../utils/zaloApi');
    await Promise.all(needFetch.map(async (id) => {
      try {
        const profile = await getZaloUserProfile(id);
        if (profile?.display_name || profile?.avatar) {
          const displayName = profile.display_name || result[id]?.display_name || id;
          const avatar = profile.avatar || result[id]?.avatar || '';
          await saveProfile(id, displayName, avatar);
          result[id] = { display_name: displayName, avatar };
        }
      } catch {}
    }));
  }

  return result;
}

module.exports = { saveProfile, getProfiles };
