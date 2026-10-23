const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CONFIG = require('../config');
const { ensureDir } = require('./localStore');

// ============================================================
// Lưu ảnh / video / file đính kèm trực tiếp trên ổ đĩa VPS (thay Cloudinary).
// File nằm ở <UPLOAD_DIR>/<folder>/<yyyy-mm>/<tên ngẫu nhiên>.<ext>, serve công khai tại
// /uploads/... (xem server.js). Tên file luôn do server sinh — không dùng tên người dùng gửi
// lên để tránh ghi đè / path traversal.
// ============================================================

const URL_PREFIX = '/uploads';

// Đuôi file chấp nhận theo MIME — chỉ những loại này mới được lưu
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

const DOC_EXTS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];

// Nhận diện ảnh theo vài byte đầu (magic number) — không tin hoàn toàn MIME do client khai báo
function sniffImageExt(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return '.heic';
  }
  return null;
}

function toPublicUrl(relPath) {
  const urlPath = `${URL_PREFIX}/${relPath.split(path.sep).join('/')}`;
  return CONFIG.PUBLIC_URL ? `${CONFIG.PUBLIC_URL}${urlPath}` : urlPath;
}

function writeBuffer(buffer, folder, ext) {
  const month = new Date().toISOString().slice(0, 7);
  const relDir = path.join(folder, month);
  const absDir = path.join(CONFIG.UPLOAD_DIR, relDir);
  ensureDir(absDir);
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(absDir, name), buffer);
  return toPublicUrl(path.join(relDir, name));
}

// Lưu ảnh — kiểm tra nội dung đúng là ảnh. Trả URL công khai.
function saveImage(buffer, folder = 'feedback') {
  const ext = sniffImageExt(buffer);
  if (!ext) throw new Error('File không phải ảnh hợp lệ (chỉ nhận JPG, PNG, WEBP, GIF, HEIC)');
  return writeBuffer(buffer, folder, ext);
}

// Lưu video / tài liệu đính kèm nội bộ. kind: 'video' | 'file'
function saveAttachment(buffer, { mimetype, originalname }, kind, folder = 'attachments') {
  const extFromName = path.extname(originalname || '').toLowerCase();
  let ext = EXT_BY_MIME[mimetype];
  if (kind === 'file') {
    // Trình duyệt hay khai MIME sai cho file Office → tin đuôi file, nhưng chỉ trong danh sách cho phép
    ext = DOC_EXTS.includes(extFromName) ? extFromName : null;
  } else if (kind === 'video') {
    if (!ext || !mimetype.startsWith('video/')) ext = null;
  }
  if (!ext) throw new Error('Định dạng file không được hỗ trợ');
  return writeBuffer(buffer, folder, ext);
}

// URL (tuyệt đối hoặc tương đối) → đường dẫn file trên đĩa nếu là file do hệ thống lưu, ngược lại null.
// Dùng để đọc thẳng từ đĩa khi cần gửi lại ảnh/file lên Zalo, khỏi tải qua HTTP.
function resolveLocalPath(url) {
  if (!url) return null;
  let pathname = url;
  if (/^https?:\/\//i.test(url)) {
    if (!CONFIG.PUBLIC_URL || !url.startsWith(`${CONFIG.PUBLIC_URL}${URL_PREFIX}/`)) return null;
    pathname = url.slice(CONFIG.PUBLIC_URL.length);
  }
  if (!pathname.startsWith(`${URL_PREFIX}/`)) return null;
  const rel = decodeURIComponent(pathname.slice(URL_PREFIX.length + 1).split('?')[0]);
  const abs = path.resolve(CONFIG.UPLOAD_DIR, rel);
  if (!abs.startsWith(CONFIG.UPLOAD_DIR + path.sep)) return null; // chặn ../
  return fs.existsSync(abs) ? abs : null;
}

module.exports = { URL_PREFIX, saveImage, saveAttachment, resolveLocalPath };
