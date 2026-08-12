TAPHOAGAME FINAL BLUE PRO

GIAO DIỆN
- Nền xanh da trời / trắng, mobile responsive.
- Giao diện khách dùng tiếng Việt, không công khai phí nền tảng hay thông tin kỹ thuật database.
- Khi đã đăng nhập, khung đăng nhập bên trái được thay bằng thông tin tài khoản.
- Thông báo lỗi/thành công ở giữa màn hình.
- Thanh cảnh báo lừa đảo chạy ngang.
- Telegram @tungtungsas, Facebook hỗ trợ và SĐT 0876148544 bằng nút nổi.

BÁN HÀNG
- Seller bắt buộc đọc + tick đồng ý quy định trước khi gửi hồ sơ.
- Admin duyệt seller.
- Acc chờ Admin duyệt.
- Seller chọn số ngày bảo hành.
- Tiền seller bị tạm giữ 72 giờ sau khi bán.
- Nếu buyer khiếu nại, tiền tiếp tục giữ đến khi Admin xử lý.
- Seller có held_balance (đang giữ) và seller_balance (có thể rút).

KHIẾU NẠI / BẢO HÀNH
- Buyer mở khiếu nại từ lịch sử đơn hàng.
- Admin có thể trả tiền seller hoặc hoàn tiền buyer.
- Lưu audit log.

ĐẤU GIÁ
- Seller tạo phiên đấu giá -> Admin duyệt.
- Giá khởi điểm, bước giá, thời gian kết thúc.
- Thành viên đăng nhập mới được bid.
- Lưu lịch sử bid.

CHAT
- Buyer <-> Seller theo acc.
- Member/Seller <-> Admin qua /support.html.
- Lịch sử chat lưu PostgreSQL.

NẠP TIỀN
- Mặc định hiển thị MB Bank 11042004102005.
- Tạo mã nội dung riêng TG...
- KHÔNG tự cộng tiền chỉ vì người dùng bấm tạo yêu cầu.
- Tự cộng chỉ khi nhận webhook hợp lệ có PAYMENT_WEBHOOK_SECRET và provider_ref duy nhất.
- Nếu chưa có webhook, Admin xác nhận sau khi kiểm tra tiền thật.

ADMIN
- Đăng nhập Admin tự vào /admin.html.
- Khóa/mở tài khoản.
- Đặt lại mật khẩu người khác (không xem mật khẩu cũ).
- Xóa tài khoản chỉ khi chưa có dữ liệu giao dịch.
- Xem IP đăng ký / IP đăng nhập gần nhất.
- Cấm IP.
- Duyệt seller, acc, đấu giá.
- Khiếu nại/bảo hành.
- Nạp/rút.
- Audit log.

ANTI-FRAUD
- PostgreSQL transaction + row lock.
- Wallet ledger.
- Webhook idempotency/provider_ref chống cộng tiền 2 lần.
- IP ban + auth rate limit.
- Không khóa vĩnh viễn chỉ dựa vào IP tự động; Admin là người ra quyết định khóa/cấm IP.

RENDER ENV
DATABASE_URL=
JWT_SECRET= (>=32 ký tự)
ADMIN_EMAIL=
ADMIN_PASSWORD= (>=12 ký tự)
SHOP_FEE_PERCENT=5
BANK_NAME=MB Bank
BANK_ACCOUNT=11042004102005
BANK_ACCOUNT_NAME=
PAYMENT_WEBHOOK_SECRET=
SMTP_* optional

LƯU Ý QUAN TRỌNG
- Muốn tự cộng tiền khi chuyển MB Bank: cần một API/cổng thanh toán/webhook chính thức cung cấp xác nhận giao dịch.
- Không có webhook chính thức thì để giao dịch pending và Admin kiểm tra thủ công.
- Production nên chuyển CCCD sang private object storage, thêm 2FA Admin, WAF/Cloudflare và backup PostgreSQL.


NEON MARKETPLACE v50
- Giao diện navy/xanh/tím neon theo mẫu marketplace game.
- Banner Liên Quân phong cách trưng bày.
- Toàn bộ chữ ACC trên giao diện chính đổi thành TÀI KHOẢN.
- Tim yêu thích + giỏ hàng bằng localStorage.
- Có /favorites.html và /cart.html.
- Trang con có nút Trở về.
- Admin giao diện gọn: tổng nạp, lần nạp gần nhất, hoạt động gần nhất, online/offline, IP, quản lý người bán/gian hàng.
