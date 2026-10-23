const axios = require('axios');
const { sendZaloText, sendZaloLinkButton, sendZaloToGroup } = require('../utils/zaloApi');
const CONFIG = require('../config');
const Feedback = require('../models/Feedback');

// ============================================================
// Tiếp nhận phản ánh. Người dân gửi qua ReportApp (form web) — chatbot OA chỉ còn nhiệm vụ
// gửi nút mở form (promptReportApp) và trang theo dõi (promptReportAppHistory).
// ============================================================

const NOMINATIM_HEADERS = { 'User-Agent': 'UBND-PhuocNang-GopY/1.0' };

// Khu vực Đà Nẵng mới (sau sáp nhập Quảng Nam 2025) — giới hạn geocode để địa chỉ trùng tên
// đường ở tỉnh khác không bị nhảy ra ngoài. Format Nominatim viewbox: min_lng,max_lat,max_lng,min_lat
// Có thể thu hẹp quanh xã qua GEOCODE_VIEWBOX trong .env để kết quả chính xác hơn.
const GEOCODE_VIEWBOX = process.env.GEOCODE_VIEWBOX || '107.20,16.25,108.80,14.90';

// Geocode địa chỉ tay → lat/lng bằng Nominatim (OpenStreetMap, miễn phí)
async function geocodeAddress(address) {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: `${address}, ${CONFIG.ORG_AREA}, Việt Nam`,
        format: 'json', limit: 1, countrycodes: 'vn', viewbox: GEOCODE_VIEWBOX, bounded: 1,
      },
      headers: NOMINATIM_HEADERS,
      timeout: 5000,
    });
    if (res.data && res.data.length > 0) {
      return { lat: Number(res.data[0].lat), lng: Number(res.data[0].lon) };
    }
  } catch (err) {
    console.error('[Geocode] Lỗi geocode địa chỉ:', err.message);
  }
  return null;
}

// Reverse geocode lat/lng → tên địa chỉ đọc được, dùng khi dân bấm "Lấy vị trí tự động"
// — tránh hiển thị chuỗi tọa độ thô "15.6, 108.0" cho dân và cán bộ.
async function reverseGeocodeAddress(lat, lng) {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon: lng, format: 'json', 'accept-language': 'vi' },
      headers: NOMINATIM_HEADERS,
      timeout: 5000,
    });
    return res.data?.display_name || null;
  } catch (err) {
    console.error('[Geocode] Lỗi reverse geocode:', err.message);
    return null;
  }
}

function isPhone(text) {
  return /^(0|\+84)[3-9]\d{8}$/.test(String(text || '').replace(/\s/g, ''));
}

// Chuẩn hoá SĐT về dạng 0xxxxxxxxx (Zalo trả dạng 84xxxxxxxxx)
function normalizePhone(text) {
  const digits = String(text || '').replace(/[^\d+]/g, '');
  if (/^\+?84[3-9]\d{8}$/.test(digits)) return `0${digits.replace(/^\+?84/, '')}`;
  return digits;
}

async function promptReportApp(userId) {
  if (!CONFIG.REPORT_APP_URL) {
    await sendZaloText(userId, '⚠️ Tính năng góp ý đang được nâng cấp, vui lòng thử lại sau.');
    return;
  }
  await sendZaloLinkButton(
    userId,
    '📝 Gửi Phản ánh - Góp ý',
    `Nhấn nút bên dưới để mở form gửi phản ánh, góp ý tới ${CONFIG.ORG_NAME}.`,
    '✍️ Mở form phản ánh',
    CONFIG.REPORT_APP_URL,
  );
}

// Theo dõi phản ánh nằm trong ReportApp ("Phản ánh của tôi") — ReportApp đăng nhập bằng ID OAuth,
// trùng ID đã ghi khi tạo phản ánh; ID webhook OA thì khác namespace nên không tra trong chat được.
async function promptReportAppHistory(userId) {
  if (!CONFIG.REPORT_APP_URL) {
    await sendZaloText(userId, '⚠️ Tính năng theo dõi phản ánh đang được nâng cấp, vui lòng thử lại sau.');
    return;
  }
  await sendZaloLinkButton(
    userId,
    '📋 Theo dõi phản ánh',
    'Nhấn nút bên dưới rồi chọn "Phản ánh của tôi" để xem tình trạng xử lý theo mã phản ánh.',
    '🔍 Theo dõi phản ánh',
    `${CONFIG.REPORT_APP_URL}?view=history`,
  );
}

// Tạo phản ánh từ ReportApp:
// 1) Đẩy 1022 ĐỒNG BỘ (await syncFeedbackById) để trả mã thật ngay cho route gọi hàm này.
// 2) Không chặn việc lưu phản ánh nếu 1022 lỗi/timeout — trả sync.ok=false, cgy1022RetryService
//    (chạy nền) sẽ tự đẩy lại và nhắn Zalo mã thật cho dân khi thành công.
// 3) Thông báo nhóm Zalo tiếp nhận của danh mục.
async function createFeedbackEntry({
  userId, displayName, contact, content, title,
  categoryId, categoryName, categoryGroupId, imageUrls = [], location,
}) {
  // Vị trí GPS không kèm tên địa điểm → tự reverse geocode
  let loc = location || {};
  if (loc.source === 'gps' && !loc.address && loc.lat != null && loc.lng != null) {
    const addr = await reverseGeocodeAddress(loc.lat, loc.lng);
    if (addr) loc = { ...loc, address: addr };
  }
  // Địa chỉ gõ tay → geocode ước lượng để hiện trên bản đồ (không gửi tọa độ này lên 1022)
  if (loc.source === 'manual' && loc.address && (loc.lat == null || loc.lng == null)) {
    const geo = await geocodeAddress(loc.address);
    if (geo) loc = { ...loc, lat: geo.lat, lng: geo.lng };
  }

  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 5);

  const feedback = await Feedback.create({
    userId,
    displayName: displayName || '',
    contact,
    title,
    content,
    location: loc,
    imageUrl: imageUrls[0] || '',
    imageUrls,
    categoryId: categoryId || null,
    deadline,
  });

  // Đồng bộ 1022 NGAY — notifyOnSuccess: false vì tin xác nhận ngay dưới đây đã có mã.
  const { syncFeedbackById } = require('./cgy1022RetryService');
  const sync = await syncFeedbackById(feedback._id, { notifyOnSuccess: false });

  const codeInfo = sync.ok && sync.gopyId
    ? `Mã phản ánh: ${sync.gopyId}`
    : 'Mã tra cứu đang được đồng bộ, chúng tôi sẽ nhắn Zalo báo mã cho bạn ngay khi có.';

  await sendZaloText(userId,
    '✅ Đã tiếp nhận phản ánh!\n\n' +
    `📌 Tiêu đề: ${title}\n` +
    `${codeInfo}\n\n` +
    `Cảm ơn bạn đã gửi phản ánh tới ${CONFIG.ORG_NAME}!`
  );

  const groupMsg = buildGroupMessage({
    title, displayName, contact, content, categoryName, imageUrls,
    address: loc.address, gopyId: sync.ok ? sync.gopyId : '', createdAt: feedback.createdAt,
  });
  await sendZaloToGroup(groupMsg, categoryGroupId);

  console.log(`[Feedback] Lưu phản ánh userId=${userId} category=${categoryName} images=${imageUrls.length} sync.ok=${sync.ok}`);

  return { feedback, sync };
}

// Tin "PHẢN ÁNH MỚI" gửi nhóm Zalo tiếp nhận — dùng khi tạo mới và khi gửi lại / chuyển nhóm.
function buildGroupMessage({
  title, displayName, contact, content, categoryName, imageUrls = [], address, gopyId, createdAt, resent = false,
}) {
  const { shouldShowPhone, displayCategoryName } = require('./cgy1022Service');
  const time = new Date(createdAt || Date.now()).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  // shouldShowPhone() PHẢI dùng categoryName gốc để tra đúng CGY1022_LINHVUC_MAP —
  // displayCategoryName() chỉ áp dụng ở TEXT hiển thị.
  const nameInfo = displayName ? `👤 Tên: ${displayName}\n` : '';
  const contactLine = contact && shouldShowPhone(categoryName) ? `📞 Liên hệ: ${contact}\n` : '';
  const catInfo = categoryName ? `🏷️ Loại: ${displayCategoryName(categoryName)}\n` : '';
  const locationInfo = address ? `📍 Địa chỉ: ${address}\n` : '';
  const imageInfo = imageUrls.length > 0
    ? `🖼️ ${imageUrls.length} ảnh:\n${imageUrls.map((u, i) => `  ${i + 1}. ${u}`).join('\n')}`
    : '🖼️ Ảnh: Không có';
  const codeLine = gopyId ? `🆔 Mã phản ánh: ${gopyId}` : '🆔 Mã phản ánh: đang đồng bộ...';

  return (
    `📩 PHẢN ÁNH ${resent ? '(GỬI LẠI) ' : 'MỚI '}- ${time}\n` +
    `${'─'.repeat(30)}\n` +
    `📌 Tiêu đề: ${title}\n` +
    `${nameInfo}` +
    `${contactLine}` +
    `${catInfo}` +
    `${locationInfo}` +
    `📝 Nội dung:\n${content}\n` +
    `${imageInfo}\n` +
    `${codeLine}`
  );
}

// Gửi (lại) thông tin 1 phản ánh vào nhóm Zalo tiếp nhận của danh mục hiện tại.
// Trả false nếu danh mục chưa có nhóm và cũng không có ZALO_GROUP_ID mặc định.
async function notifyGroupOfFeedback(feedbackId) {
  const fb = await Feedback.findById(feedbackId).populate('categoryId', 'name zaloGroupId').lean();
  if (!fb) throw new Error('Không tìm thấy phản ánh');
  const groupId = fb.categoryId?.zaloGroupId || CONFIG.ZALO_GROUP_ID;
  if (!groupId) return false;
  const msg = buildGroupMessage({
    title: fb.title || fb.content.slice(0, 60),
    displayName: fb.displayName,
    contact: fb.contact,
    content: fb.content,
    categoryName: fb.categoryId?.name || '',
    imageUrls: fb.imageUrls?.length ? fb.imageUrls : (fb.imageUrl ? [fb.imageUrl] : []),
    address: fb.location?.address,
    gopyId: fb.cgy1022?.gopyId,
    createdAt: fb.createdAt,
    resent: true,
  });
  return sendZaloToGroup(msg, groupId);
}

function isFeedbackTrigger(text) {
  const lower = String(text || '').toLowerCase();
  return (
    lower.includes('#goopy') ||
    lower.includes('#phananh') ||
    lower.includes('góp ý') ||
    lower.includes('gop y') ||
    lower.includes('phản ánh') ||
    lower.includes('phan anh') ||
    lower === 'goopy'
  );
}

function isLookupTrigger(text) {
  const lower = String(text || '').toLowerCase().trim();
  return ['#theodoi', '#tracuu', 'theo dõi', 'theo doi', 'tra cứu', 'tra cuu'].some((k) => lower.includes(k));
}

module.exports = {
  promptReportApp, promptReportAppHistory, isFeedbackTrigger, isLookupTrigger,
  geocodeAddress, reverseGeocodeAddress, createFeedbackEntry, isPhone, normalizePhone,
  buildGroupMessage, notifyGroupOfFeedback,
};
