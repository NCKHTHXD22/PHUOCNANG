require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const CONFIG = require('./src/config');
const { handleWebhook } = require('./src/handlers/webhookHandler');
const { setTokensManually, getTokenInfo } = require('./src/utils/zaloToken');
const { URL_PREFIX } = require('./src/utils/mediaStorage');
const { ensureDir } = require('./src/utils/localStore');

const app = express();

// Nginx đứng trước nên phải tin X-Forwarded-For, nếu không mọi request đều mang IP 127.0.0.1
// và giới hạn tần suất (api/middleware/rateLimit.js) sẽ tính chung cho tất cả mọi người.
app.set('trust proxy', 1);

// CORS — chỉ đúng các origin của dự án. Web admin + ReportApp mặc định chạy cùng tên miền
// với Backend (Express serve /app và /report) nên thường không cần thêm gì.
// Deploy frontend ở tên miền khác (VD Vercel) thì khai báo CORS_ORIGINS trong .env (ngăn cách dấu phẩy).
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3001',
  CONFIG.PUBLIC_URL,
  ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // Không có Origin = gọi cùng tên miền, app di động, curl…
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    console.warn(`[CORS] Từ chối origin lạ: ${origin}`);
    return cb(null, false);
  },
}));

// Body parsing — giới hạn kích thước để 1 request JSON khổng lồ không ngốn hết RAM
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Chặn chèn truy vấn MongoDB qua tham số (?field[$ne]=…) trên toàn bộ request
app.use(require('./api/middleware/sanitizeMongo'));

// Thư mục lưu dữ liệu trên VPS (token Zalo, cache) + ảnh/file upload
ensureDir(CONFIG.DATA_DIR);
ensureDir(CONFIG.UPLOAD_DIR);
console.log(`[Storage] Dữ liệu: ${CONFIG.DATA_DIR}`);
console.log(`[Storage] Ảnh/file upload: ${CONFIG.UPLOAD_DIR}`);
if (!CONFIG.PUBLIC_URL) {
  console.warn('[Storage] ⚠️ Chưa đặt PUBLIC_URL — link ảnh sẽ là đường dẫn tương đối, Cổng 1022 và nhóm Zalo không mở được');
}

// Kết nối MongoDB + seed dữ liệu mặc định
mongoose.connect(CONFIG.MONGO_URI)
  .then(async () => {
    console.log('[MongoDB] Kết nối thành công');

    const AdminUser = require('./src/models/AdminUser');
    const Category = require('./src/models/Category');

    // Seed tài khoản admin mặc định — mật khẩu lấy từ ADMIN_PASSWORD, không có thì sinh ngẫu nhiên
    const adminCount = await AdminUser.countDocuments();
    if (adminCount === 0) {
      const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
      await AdminUser.create({
        username: 'admin',
        password,
        fullName: 'Quản trị viên',
        role: 'superadmin',
      });
      console.log(`[Admin] Đã tạo tài khoản mặc định: admin / ${process.env.ADMIN_PASSWORD ? '(ADMIN_PASSWORD trong .env)' : password} — đổi mật khẩu sau khi đăng nhập!`);
    }

    // Seed 4 danh mục phản ánh mặc định — zaloGroupId để trống, superadmin gán nhóm Zalo
    // tiếp nhận cho từng danh mục ở trang "Cài đặt nhóm Zalo" trên web admin.
    const catCount = await Category.countDocuments();
    if (catCount === 0) {
      const defaultCategories = [
        { name: 'Môi trường, Hạ tầng, Xây dựng',    zaloGroupId: '', icon: '🏗️', order: 1 },
        { name: 'Văn hoá, Giáo dục, Y tế',            zaloGroupId: '', icon: '🏫', order: 2 },
        { name: 'Dịch vụ công, Thủ tục hành chính',  zaloGroupId: '', icon: '📋', order: 3 },
        { name: 'An ninh trật tự, PCCC',              zaloGroupId: '', icon: '🚔', order: 4 },
      ];
      await Category.insertMany(defaultCategories);
      console.log('[Seed] Đã tạo 4 danh mục phản ánh mặc định (chưa gán nhóm Zalo)');
    }

    require('./src/services/groupSyncService').startGroupSyncSchedule();
    require('./src/services/deadlineReminderService').startDeadlineReminder();
    require('./src/services/cgy1022RetryService').startCgy1022Retry();
    require('./src/services/cgy1022StatusService').startCgy1022StatusPoll();
  })
  .catch(err => console.error('[MongoDB] Lỗi kết nối:', err.message));

// Request logging
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ── Ảnh / file đính kèm lưu trên VPS ──────────────────
// Ảnh + video hiển thị trực tiếp; tài liệu (pdf/docx/xlsx…) luôn tải xuống. nosniff để trình
// duyệt không đoán kiểu file rồi chạy như HTML/JS.
app.use(URL_PREFIX, express.static(CONFIG.UPLOAD_DIR, {
  index: false,
  dotfiles: 'deny',
  maxAge: '30d',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!/\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|webm|3gp)$/i.test(filePath)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));

// ── Webhook Zalo ──────────────────────────────────────
app.get('/webhook', (req, res) => {
  res.json({ token: req.query.token || '' });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    await handleWebhook(req.body);
  } catch (err) {
    console.error('[Webhook] Lỗi xử lý:', err.message);
  }
});

// ── Cập nhật token Zalo OA thủ công ───────────────────
// Bảo vệ bằng TOKEN_SETUP_KEY trong .env — không đặt thì tính năng tắt (trước đây ai cũng
// ghi đè được token của OA qua trang này).
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function checkSetupKey(input) {
  const expected = process.env.TOKEN_SETUP_KEY || '';
  if (!expected || typeof input !== 'string') return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const tokenPageLimit = require('./api/middleware/rateLimit').rateLimit({
  name: 'set-tokens', windowMs: 15 * 60 * 1000, max: 10,
});

app.get('/admin/set-tokens', (_req, res) => {
  if (!process.env.TOKEN_SETUP_KEY) {
    return res.status(404).send('Chưa bật: đặt TOKEN_SETUP_KEY trong Backend/.env để dùng trang này.');
  }
  const info = getTokenInfo();
  res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cập nhật Zalo Token - ${escapeHtml(CONFIG.ORG_NAME)}</title>
  <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px}
  textarea,input{width:100%;padding:8px;margin:8px 0;box-sizing:border-box;font-size:12px}
  textarea{height:80px}
  button{background:#0068ff;color:white;padding:10px 24px;border:none;cursor:pointer;border-radius:4px;font-size:16px}
  label{font-weight:bold}.info{background:#f1f5f9;padding:10px;border-radius:6px;font-size:13px}</style></head>
  <body><h2>Cập nhật Zalo Token - ${escapeHtml(CONFIG.ORG_NAME)}</h2>
  <p class="info">Token hiện tại: ${info.hasAccessToken ? 'đã có' : 'CHƯA CÓ'} · cập nhật lần cuối: ${escapeHtml(info.updatedAt || 'chưa rõ')}</p>
  <form method="POST" action="/admin/set-tokens">
    <label>Mã quản trị (TOKEN_SETUP_KEY):</label>
    <input type="password" name="setup_key" required autocomplete="off">
    <label>Access Token:</label>
    <textarea name="access_token" placeholder="Dán access_token vào đây" required></textarea>
    <label>Refresh Token:</label>
    <textarea name="refresh_token" placeholder="Dán refresh_token vào đây" required></textarea>
    <button type="submit">Lưu token</button>
  </form></body></html>`);
});

app.post('/admin/set-tokens', tokenPageLimit, async (req, res) => {
  const { access_token, refresh_token, setup_key } = req.body;
  if (!checkSetupKey(setup_key)) return res.status(403).send('Sai mã quản trị');
  if (!access_token || !refresh_token) return res.send('Lỗi: Cần cả 2 token');
  try {
    await setTokensManually(String(access_token).trim(), String(refresh_token).trim());
    res.send('<h2>✅ Token đã lưu trên máy chủ! Hệ thống sẽ tự động refresh.</h2>');
  } catch (err) {
    res.send(`<h2>❌ Lỗi: ${escapeHtml(err.message)}</h2>`);
  }
});

// ── REST API cho web admin + ReportApp ─────────────────
const apiRouter = require('./api/routes/index');
app.use('/api', apiRouter);

// ── Xác thực tên miền Zalo ─────────────────────────────
if (CONFIG.ZALO_SITE_VERIFICATION) {
  app.get(`/zalo_verifier${CONFIG.ZALO_SITE_VERIFICATION}.html`, (req, res) => {
    res.type('html').send('There Is No Limit To What You Can Accomplish Using Zalo!');
  });
}

// ── Trang gốc: nhận OAuth callback cấp quyền OA (lấy token lần đầu) ──
app.get('/', async (req, res) => {
  const { code } = req.query;
  if (code) {
    try {
      const axios = require('axios');
      const params = new URLSearchParams();
      params.append('code', String(code));
      params.append('app_id', CONFIG.ZALO_APP_ID);
      params.append('grant_type', 'authorization_code');
      const r = await axios.post(
        'https://oauth.zaloapp.com/v4/oa/access_token',
        params,
        { headers: { secret_key: CONFIG.ZALO_APP_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token, refresh_token } = r.data;
      if (access_token) {
        await setTokensManually(access_token, refresh_token);
        console.log('[OAuth] Lấy token mới từ OAuth thành công');
        return res.type('html').send('<h2>✅ Cấp quyền thành công! Token đã lưu trên máy chủ. Bot sẵn sàng hoạt động.</h2>');
      }
      return res.type('html').send(`<h2>❌ Lỗi: ${escapeHtml(JSON.stringify(r.data))}</h2>`);
    } catch (err) {
      return res.type('html').send(`<h2>❌ Lỗi: ${escapeHtml(err.message)}</h2>`);
    }
  }
  const meta = CONFIG.ZALO_SITE_VERIFICATION
    ? `<meta name="zalo-platform-site-verification" content="${escapeHtml(CONFIG.ZALO_SITE_VERIFICATION)}" />`
    : '';
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8">${meta}</head><body>${escapeHtml(CONFIG.ORG_NAME)} - OA Zalo</body></html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', project: `${CONFIG.ORG_NAME} - Phản ánh góp ý`, timestamp: new Date().toISOString() });
});

// ── Serve web admin build (production) tại /app ────────
const webDist = path.join(__dirname, '..', 'Frontend', 'Web', 'dist');
if (fs.existsSync(webDist)) {
  app.use('/app', express.static(webDist));
  app.get('/app*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

// ── Serve ReportApp build (production) tại /report — form gửi phản ánh, xem promptReportApp() ──
const reportDist = path.join(__dirname, '..', 'Frontend', 'ReportApp', 'dist');
if (fs.existsSync(reportDist)) {
  app.use('/report', express.static(reportDist));
  app.get('/report*', (_req, res) => res.sendFile(path.join(reportDist, 'index.html')));
}

app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 Server ${CONFIG.ORG_NAME} - Phản ánh góp ý chạy tại http://localhost:${CONFIG.PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${CONFIG.PORT}/webhook`);
  console.log(`🖥️  Web admin: http://localhost:${CONFIG.PORT}/app`);
  console.log(`📝 Form phản ánh: http://localhost:${CONFIG.PORT}/report\n`);
});
