# Triển khai lên VPS — Phản ánh góp ý Zalo OA · UBND xã Phước Năng

**Kiến trúc:** toàn bộ chạy trên 1 VPS — Nginx (SSL) → Express/PM2 (`Backend/`) → MongoDB.
Express phục vụ luôn:

| Đường dẫn | Nội dung |
|---|---|
| `/app` | Web admin (React, `Frontend/Web/dist`) |
| `/report` | Form gửi phản ánh cho người dân (ReportApp, `Frontend/ReportApp/dist`) |
| `/api/*` | REST API |
| `/webhook` | Webhook Zalo OA |
| `/uploads/*` | Ảnh phản ánh + đính kèm xử lý (lưu trên ổ đĩa VPS) |
| `/` | Nhận OAuth callback cấp quyền OA (lấy token lần đầu) |
| `/admin/set-tokens` | Dán token OA thủ công (cần `TOKEN_SETUP_KEY`) |

Không còn dùng Upstash Redis và Cloudinary: token Zalo lưu ở `DATA_DIR/zalo-token.json`, ảnh lưu ở `UPLOAD_DIR`.

## 1. SSH

Tạo keypair riêng: 1 key admin, 1 key **chỉ cho CI/CD**:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/phuocnang_deploy -N ""
ssh-keygen -t ed25519 -f ~/.ssh/phuocnang_github_deploy -N ""
```

Cài public key vào `~/.ssh/authorized_keys` trên VPS.

## 2. Khảo sát VPS (nếu đã có app khác)

```bash
pm2 list                          # tên app / port đã dùng
ls /etc/nginx/sites-available/    # pattern nginx đang dùng
ss -tlnp | grep node              # port còn trống
```

## 3. MongoDB

Chọn 1 trong 2:
- **MongoDB trên chính VPS** (cài `mongodb-org`, chỉ bind `127.0.0.1`) → `MONGO_URI=mongodb://127.0.0.1:27017/phuocnang_phananh`
- **MongoDB Atlas** → dán connection string vào `MONGO_URI`, nhớ whitelist IP VPS.

## 4. Thư mục dữ liệu (token + ảnh)

Đặt **ngoài** thư mục code để deploy không ảnh hưởng:

```bash
mkdir -p /var/lib/phuocnang/data /var/lib/phuocnang/uploads
chown -R <user-chạy-pm2> /var/lib/phuocnang
chmod 700 /var/lib/phuocnang/data      # chứa token Zalo OA
```

Trong `Backend/.env`:

```
DATA_DIR=/var/lib/phuocnang/data
UPLOAD_DIR=/var/lib/phuocnang/uploads
```

**Sao lưu** định kỳ cả 2 thư mục này cùng MongoDB (VD cron hằng đêm `tar czf` + `mongodump`). Mất `data/zalo-token.json` thì phải cấp quyền OA lại (mục 8).

## 5. Cài đặt app

```bash
mkdir -p /var/www/phuocnang && cd /var/www/phuocnang
git clone <repo-url> .
cp Backend/.env.example Backend/.env      # rồi điền giá trị thật (xem chú thích trong file)
cd Backend && npm install --omit=dev && cd ..
cd Frontend/Web && npm install && npm run build && cd ../..
cd Frontend/ReportApp && cp .env.example .env   # điền VITE_ZALO_APP_ID
npm install && npm run build && cd ../..
pm2 start server.js --name phuocnang-backend --cwd /var/www/phuocnang/Backend -i 1
pm2 save
curl http://localhost:3001/health
```

- Lần chạy đầu tạo tài khoản `admin` — mật khẩu là `ADMIN_PASSWORD` trong `.env`, để trống thì xem trong `pm2 logs`. Đổi mật khẩu ngay sau khi đăng nhập.
- ⚠️ Chỉ chạy **1 tiến trình** (`-i 1`, không dùng cluster): refresh token Zalo chỉ dùng được 1 lần, 2 tiến trình cùng refresh sẽ làm hỏng token.
- ⚠️ `--cwd`: PM2 resolve script **tương đối với `--cwd`**. Luôn dùng `server.js` + `--cwd` tuyệt đối tới `Backend/`.
- `VITE_ZALO_APP_ID` được nhúng lúc build ReportApp → đổi giá trị thì phải build lại.

## 6. DNS + Nginx + SSL

A record `<domain>` → IP VPS, kiểm tra `nslookup <domain> 8.8.8.8`.

`/etc/nginx/sites-available/phuocnang`:

```nginx
server {
    listen 80;
    server_name <domain>;

    # Form phản ánh: tối đa 5 ảnh × 5MB; đính kèm xử lý của cán bộ: video tối đa 100MB
    client_max_body_size 110m;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/phuocnang /etc/nginx/sites-enabled/phuocnang
nginx -t && systemctl reload nginx
certbot --nginx -d <domain> --non-interactive --agree-tos -m <email> --redirect
```

Đặt `PUBLIC_URL=https://<domain>` trong `Backend/.env` rồi `pm2 restart phuocnang-backend`.

## 7. CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` đã có sẵn: push `main` → SSH vào VPS → `git reset --hard` → build 2 frontend → `pm2 delete` + `pm2 start`.

Secrets (repo → Settings → Secrets and variables → Actions, environment `Production`):

| Secret | Giá trị |
|---|---|
| `VPS_HOST` | IP VPS |
| `VPS_USER` | user SSH |
| `VPS_PRIVATE_KEY` | private key CI/CD (bước 1) |
| `VPS_APP_DIR` | `/var/www/phuocnang` |
| `VPS_PORT` | (tuỳ chọn) cổng SSH |

- `git reset --hard` không xoá file bị `.gitignore` (`.env`, `node_modules`), nhưng dữ liệu vẫn nên nằm ngoài thư mục code (mục 4).
- Push file trong `.github/workflows/` cần PAT có scope **`workflow`**.

## 8. Cấu hình Zalo

Trên **developers.zalo.me** (ứng dụng gắn với OA Phước Năng):

1. **Xác thực tên miền** trước: lấy mã xác thực, đặt `ZALO_SITE_VERIFICATION=<mã>` trong `.env` (server tự phục vụ cả meta tag ở `/` lẫn file `/zalo_verifier<mã>.html`), restart rồi bấm xác thực.
2. **Webhook** → `https://<domain>/webhook`, bật các sự kiện: người dùng gửi tin nhắn văn bản, người dùng quan tâm OA, người dùng gửi thông tin (submit info), các sự kiện nhóm (GMF).
3. **Official Account → Callback URL** (cấp quyền OA) → `https://<domain>/`. Mở link cấp quyền OA, đăng nhập bằng tài khoản quản trị OA → server tự lưu token vào `DATA_DIR/zalo-token.json`. (Cách khác: đặt `TOKEN_SETUP_KEY` rồi dán token tại `https://<domain>/admin/set-tokens`.)
4. **Đăng nhập (Social API) → Callback URL** → `https://<domain>/report/` — ReportApp dùng để đăng nhập người dân. Bật quyền lấy số điện thoại nếu được cấp.

Trên **oa.zalo.me → Quản lý menu**:

| Menu | Loại | Giá trị |
|---|---|---|
| Gửi Phản ánh - Góp ý | Mở URL | `https://<domain>/report` |
| Theo dõi phản ánh | Mở URL | `https://<domain>/report?view=history` |

(Người dân nhắn `#phananh` / `#theodoi` cho OA cũng nhận được nút mở 2 trang trên.)

## 9. Sau khi chạy

1. Đăng nhập `https://<domain>/app` bằng `admin`.
2. **Cài đặt nhóm Zalo**: bấm "Đồng bộ người theo dõi OA", rồi gán ID nhóm Zalo tiếp nhận cho từng danh mục (4 danh mục mặc định được tạo sẵn, chưa có nhóm — chưa gán thì thông báo vào nhóm `ZALO_GROUP_ID`).
3. **Tài khoản Admin**: tạo tài khoản lãnh đạo phòng / cán bộ phụ trách, gán danh mục.
4. Điền `CGY1022_*` khi được 1022 cấp tài khoản; kiểm tra kết nối bằng `cd Backend && npm run probe:1022` (chỉ đọc, không ghi lên hệ thống thành phố).
5. Gửi thử 1 phản ánh từ điện thoại qua menu OA → kiểm tra: tin xác nhận + mã, thông báo vào nhóm, ảnh mở được qua `https://<domain>/uploads/...`, phản ánh hiện trong web admin.
