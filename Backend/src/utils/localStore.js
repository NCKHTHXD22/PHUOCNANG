const fs = require('fs');
const path = require('path');
const CONFIG = require('../config');

// ============================================================
// Lưu dữ liệu nhỏ dạng JSON trên ổ đĩa VPS (thay cho Upstash Redis trước đây).
// Mỗi "key" là 1 file <DATA_DIR>/<key>.json. Ghi theo kiểu ghi file tạm rồi rename
// để không bao giờ để lại file hỏng giữa chừng khi server bị tắt đột ngột.
// ============================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileOf(key) {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`Key không hợp lệ: ${key}`);
  return path.join(CONFIG.DATA_DIR, `${key}.json`);
}

function readJSON(key, fallback = null) {
  try {
    const file = fileOf(key);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[LocalStore] Đọc ${key} lỗi:`, err.message);
    return fallback;
  }
}

function writeJSON(key, value, { mode } = {}) {
  ensureDir(CONFIG.DATA_DIR);
  const file = fileOf(key);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

module.exports = { readJSON, writeJSON, ensureDir };
