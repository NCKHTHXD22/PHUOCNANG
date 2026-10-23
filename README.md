# Zalo OA Phản ánh - Góp ý — UBND xã Phước Năng

Hệ thống tiếp nhận và xử lý phản ánh, góp ý của người dân qua **Zalo Official Account**, đồng bộ lên **Cổng góp ý thành phố Đà Nẵng (1022)**, kèm web admin cho cán bộ xã. Clone từ dự án An Hải, rút gọn về đúng phạm vi phản ánh.

## Chức năng

1. **Gửi phản ánh qua Zalo** — người dân bấm menu OA "Gửi Phản ánh - Góp ý" → mở form web (ReportApp) → đăng nhập Zalo.
   - Lần đầu: hiện thông báo **xin phép sử dụng số điện thoại**; đồng ý thì SĐT được lưu vào DB.
   - Các lần sau: không hỏi lại, form **tự điền SĐT** đã cho phép (có nút đổi số / thu hồi quyền).
2. **Đồng bộ lên Cổng góp ý thành phố (1022)** — ngay khi gửi; lỗi thì tự thử lại mỗi 10 phút.
3. **Thông báo đến Nhóm tiếp nhận** — tin nhắn vào nhóm Zalo của danh mục phản ánh.
4. **Theo dõi tình trạng xử lý theo mã phản ánh** — trang "Phản ánh của tôi" trong ReportApp (trạng thái lấy trực tiếp từ 1022).
5. **Thông báo kết quả xử lý từ 1022** — tự kiểm tra mỗi 5 phút, khi 1022 báo "Đã xử lý" thì nhắn Zalo cho người dân và nhóm cán bộ phụ trách.
6. **Web admin** — phân công, soạn dự thảo, lãnh đạo duyệt/từ chối, gửi kết quả cho dân; quản lý tài khoản, nhóm Zalo, thống kê - báo cáo.

## Cấu trúc

```
/
├── Backend/              Express + MongoDB — API, webhook Zalo, đồng bộ 1022
├── Frontend/Web/         Web admin cho cán bộ (React + Vite), chạy tại /app
├── Frontend/ReportApp/   Form gửi/theo dõi phản ánh cho người dân, chạy tại /report
├── Document/             DEPLOY.md + tài liệu API Cổng góp ý 1022
└── .github/workflows/    CI/CD — tự deploy lên VPS khi push main
```

## Lưu trữ (trên VPS)

| Dữ liệu | Nơi lưu |
|---|---|
| Phản ánh, tài khoản, người dân + SĐT đã cho phép | MongoDB |
| Token Zalo OA (tự refresh) | `DATA_DIR/zalo-token.json` |
| Ảnh phản ánh, đính kèm xử lý | `UPLOAD_DIR/` → phục vụ tại `/uploads/...` |

Không dùng Redis hay Cloudinary.

## Chạy dev

```bash
cp Backend/.env.example Backend/.env           # điền MONGO_URI, ZALO_*, JWT_SECRET...
cd Backend && npm install && npm run dev       # http://localhost:3001
cd Frontend/Web && npm install && npm run dev  # http://localhost:5173/app/
cd Frontend/ReportApp && npm install && npm run dev  # http://localhost:5174/report/
```

Vite dev server proxy `/api` → `localhost:3001`.

## Triển khai

Xem [Document/DEPLOY.md](Document/DEPLOY.md) — VPS, Nginx, SSL, PM2, CI/CD, cấu hình Zalo OA.

## Thông tin cần bổ sung khi triển khai

- **Zalo OA**: `ZALO_APP_ID`, `ZALO_APP_SECRET`, token OA (cấp quyền qua `/`), ID các nhóm Zalo tiếp nhận, mã xác thực tên miền.
- **Database**: `MONGO_URI`.
- **VPS**: tên miền (`PUBLIC_URL`), thư mục `DATA_DIR`/`UPLOAD_DIR`, secrets GitHub Actions.
- **Cổng 1022**: tài khoản `CGY1022_*`, giá trị `CGY1022_NGUON` và bảng `linhVucId` cho Phước Năng.
- **Logo xã**: `Document/Logophuoc_nang.png` (bản thu nhỏ ở `Frontend/Web/public/images/logo.png`, `Frontend/ReportApp/public/logo.png`).
