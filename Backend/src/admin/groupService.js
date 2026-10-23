const { readJSON, writeJSON } = require('../utils/localStore');

// Danh sách nhóm Zalo OA đã thấy qua webhook — lưu trên VPS tại <DATA_DIR>/groups.json (thay Redis).
const STORE_KEY = 'groups';

let _cache = null;

function saveGroups(groups) {
  try {
    writeJSON(STORE_KEY, groups);
  } catch (e) {
    console.warn('[Group] Không lưu được file:', e.message);
  }
}

async function getStoredGroups() {
  if (!_cache) _cache = readJSON(STORE_KEY, []);
  return _cache;
}

async function addGroup({ group_id, name }) {
  const groups = await getStoredGroups();
  const idx = groups.findIndex(g => g.group_id === group_id);
  if (idx >= 0) {
    // Webhook không phải lúc nào cũng kèm tên nhóm — không ghi đè tên cũ bằng rỗng
    groups[idx] = { ...groups[idx], name: name || groups[idx].name, group_id };
  } else {
    groups.push({ group_id, name, added_at: new Date().toISOString() });
  }
  _cache = groups;
  saveGroups(groups);
  return groups;
}

async function removeGroup(groupId) {
  const groups = await getStoredGroups();
  const filtered = groups.filter(g => g.group_id !== groupId);
  _cache = filtered;
  saveGroups(filtered);
  return filtered;
}

module.exports = { getStoredGroups, addGroup, removeGroup };
