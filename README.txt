TAPHOAGAME_FINAL_FULLSTACK

MỘT BỘ DUY NHẤT - KHÔNG V7/V9/V10 CHỒNG CHÉO.

LUỒNG ĐĂNG NHẬP:
- member -> /account.html
- seller -> /seller.html
- admin -> /admin.html
Role được kiểm tra server-side.

BACKEND:
- PostgreSQL
- bcrypt password
- HttpOnly/Secure cookie JWT
- auth rate limiting
- Helmet
- parameterized SQL
- transaction + SELECT ... FOR UPDATE khi mua acc/nạp/rút
- audit log cho giao dịch/duyệt quan trọng
- admin không thể bị khóa từ API quản lý thông thường
- sản phẩm sold không thể xóa

MARKETPLACE:
- seller KYC thủ công bởi Admin
- sản phẩm phải Admin duyệt
- Liên Quân / Free Fire / PUBG / Khác
- mua acc -> trừ member balance, seller nhận 95% nếu fee=5
- lịch sử buyer mới thấy credential acc
- chat lưu database
- nạp tiền pending, không tự cộng khi tạo
- webhook có secret hoặc Admin xác nhận sau kiểm tra tiền thật
- rút tiền giữ số dư, reject hoàn seller_balance

ADMIN:
- dashboard
- tài khoản khóa/mở
- duyệt/từ chối seller
- duyệt/từ chối/xóa sản phẩm
- xem đơn
- nạp/rút
- audit log
- admin.html không có trong menu khách

RENDER:
- Root Directory: để trống nếu upload toàn bộ file vào root repo
- Build: npm install
- Start: npm start
- DATABASE_URL bắt buộc
- JWT_SECRET tối thiểu 32 ký tự
- ADMIN_PASSWORD nên >= 12 ký tự
- NODE_ENV=production
- SHOP_FEE_PERCENT=5

PRODUCTION HARDENING CÒN CẦN NGOÀI CODE:
- Cloudflare/WAF
- private object storage cho CCCD và ảnh nhạy cảm
- 2FA Admin
- backup/restore PostgreSQL
- email SMTP
- payment provider webhook thật
- malware scanning upload
- chính sách pháp lý/KYC/điều khoản nhà phát hành game
