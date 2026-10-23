require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// Không dùng secret mặc định cố định — ai biết chuỗi đó sẽ tự ký được token admin.
// Thiếu JWT_SECRET thì sinh ngẫu nhiên mỗi lần khởi động (cán bộ phải đăng nhập lại sau restart).
let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[Config] ⚠️ Chưa đặt JWT_SECRET trong .env — dùng secret tạm, phiên đăng nhập sẽ mất khi restart');
}

module.exports = {
  PORT: process.env.PORT || 3001,
  MONGO_URI: process.env.MONGO_URI || '',
  JWT_SECRET,

  // Tên hiển thị của đơn vị — dùng trong tin nhắn Zalo, tiêu đề báo cáo, payload 1022.
  ORG_NAME: process.env.ORG_NAME || 'UBND xã Phước Năng',
  // Tên địa bàn (không kèm "UBND") — dùng làm nơi diễn ra mặc định khi dân không nhập địa chỉ.
  ORG_AREA: process.env.ORG_AREA || 'Xã Phước Năng, Đà Nẵng',

  ZALO_APP_ID: process.env.ZALO_APP_ID || '',
  ZALO_APP_SECRET: process.env.ZALO_APP_SECRET || '',
  // Chỉ là giá trị khởi tạo lần đầu. Sau khi chạy, token thật nằm trong DATA_DIR/zalo-token.json
  // trên VPS (xem src/utils/zaloToken.js) và được ưu tiên hơn 2 biến này.
  ZALO_OA_TOKEN: process.env.ZALO_OA_TOKEN || '',
  ZALO_REFRESH_TOKEN: process.env.ZALO_REFRESH_TOKEN || '',
  ZALO_GROUP_ID: process.env.ZALO_GROUP_ID || '',
  // Mã xác thực tên miền Zalo (meta zalo-platform-site-verification), lấy trên developers.zalo.me
  ZALO_SITE_VERIFICATION: process.env.ZALO_SITE_VERIFICATION || '',

  // Lưu trữ trên VPS (thay Redis + Cloudinary):
  // - DATA_DIR: token Zalo, cache profile, danh sách nhóm/follower (file JSON)
  // - UPLOAD_DIR: ảnh phản ánh của dân + đính kèm nội bộ, serve công khai tại /uploads
  // Mặc định nằm trong Backend/ — nên trỏ ra ngoài thư mục code trên VPS (VD /var/lib/phuocnang)
  // để `git reset --hard` khi deploy không đụng tới dữ liệu.
  DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data')),
  UPLOAD_DIR: path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads')),

  // URL công khai của Backend (VD https://gopy.phuocnang.vn). BẮT BUỘC ở production: link ảnh
  // gửi lên Cổng góp ý 1022 và nhóm Zalo phải là URL tuyệt đối truy cập được từ Internet.
  PUBLIC_URL,
  // URL form web ReportApp — mặc định suy ra từ PUBLIC_URL + /report
  // (Backend/server.js serve tĩnh Frontend/ReportApp/dist tại đường dẫn này).
  REPORT_APP_URL: process.env.REPORT_APP_URL || (PUBLIC_URL ? `${PUBLIC_URL}/report` : ''),

  // Cổng góp ý 1022 (gopy.danang.gov.vn) — đồng bộ phản ánh sang hệ thống thành phố.
  // Xác thực: HTTP Basic Auth. Bắt buộc User-Agent trình duyệt (WAF chặn UA lạ).
  // Toàn bộ đọc từ .env; thiếu BASE_URL/USERNAME/PASSWORD thì tính năng tự tắt.
  CGY1022_BASE_URL: process.env.CGY1022_BASE_URL || '',
  CGY1022_USERNAME: process.env.CGY1022_USERNAME || '',
  CGY1022_PASSWORD: process.env.CGY1022_PASSWORD || '',
  CGY1022_GOPY_PATH: process.env.CGY1022_GOPY_PATH || '/api/gopy',
  CGY1022_USER_ID: process.env.CGY1022_USER_ID || '0',
  CGY1022_DEFAULT_EMAIL: process.env.CGY1022_DEFAULT_EMAIL || '',
  // Giá trị API "nguồn góp ý" do 1022 cấp riêng cho từng đơn vị. Nhãn hiển thị trên dropdown
  // quản lý 1022 KHÁC giá trị API (An Hải: nhãn "Góp ý Zalo P.An Hải" ↔ giá trị "ZaloAnHai") —
  // phải hỏi 1022 giá trị chính xác cho Phước Năng; "Zalo" là giá trị chung luôn hoạt động.
  CGY1022_NGUON: process.env.CGY1022_NGUON || 'Zalo',
  // JSON map tên danh mục → linhVucId của 1022, VD: {"Môi trường, Hạ tầng, Xây dựng": 1}
  CGY1022_LINHVUC_MAP: process.env.CGY1022_LINHVUC_MAP || '{}',
  CGY1022_LINHVUC_DEFAULT: process.env.CGY1022_LINHVUC_DEFAULT || '',
  // Danh sách linhVucId 1022 được hiện SĐT công dân (cách nhau dấu phẩy).
  // Mặc định 1 = Hạ tầng đô thị, 21 = An ninh trật tự (theo Document/TichHop_1022_TomTat.md) —
  // các lĩnh vực còn lại ẩn SĐT để bảo vệ riêng tư trên dashboard/nhóm nội bộ.
  CGY1022_SHOW_PHONE_LINHVUC: process.env.CGY1022_SHOW_PHONE_LINHVUC || '1,21',
};
