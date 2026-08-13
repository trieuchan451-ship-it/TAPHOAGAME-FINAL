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

V60 PRO: avatar, community chat, category warehouse, animated hero, auction dialogs/close, admin unlock-all.

V61 SELLER PRO
- Xóa hiệu ứng hình bầu dục CSS trên banner.
- Banner trang chủ dùng video MP4 lặp 10 giây, có ảnh fallback.
- Trung tâm người bán chia tab: Tổng quan, Đang bán, Đã bán, Chờ duyệt, Đấu giá, Đơn hàng, Khiếu nại, Đăng tài khoản, Tạo đấu giá, Rút tiền.
- Người bán xem người mua, tiền nhận, trạng thái giữ 72 giờ.
- Người bán có thể chốt phiên đấu giá bằng popup của website.

V62 PROFILE FIX
- Tắt hoàn toàn video/chuyển động banner; dùng ảnh tĩnh.
- Bấm avatar/tên sau đăng nhập luôn mở Trang cá nhân.
- Trang cá nhân không tự chuyển seller/admin sang trang khác.
- 20 avatar hoạt động cho mọi tài khoản và lưu vào PostgreSQL.
- Người bán vẫn vào Trung tâm người bán bằng menu BÁN HÀNG.

V63 MOBILE CHAT FIX
- Menu mobile chuyển từ thanh cố định dưới đáy lên ngay phía trên nội dung.
- Chat hỗ trợ thu gọn kiểu Messenger.
- Bong bóng tin nhắn nền sáng, chữ đen, tin của mình màu xanh nhạt.
- Khung chat thấp hơn, dễ dùng trên điện thoại.

V64 MOBILE FLOAT FIX
- Trên điện thoại, Chat cộng đồng chuyển sang nút riêng ở góc trái dưới.
- Telegram/Facebook/Điện thoại giữ riêng ở góc phải dưới.
- Khi mở chat, khung chat nằm cao hơn cụm hỗ trợ và không còn chồng lên nhau.

V65 ADMIN + SELLER + HOME
- Fix Admin undefined bằng API /api/admin/stats thật.
- Font Admin sắc nét hơn, giảm chữ bầy/nhòe.
- Người bán có bảng điều khiển đơn hàng dễ đọc và bộ lọc trạng thái.
- 4 kho nổi bật Liên Quân / Free Fire / PUBG / Liên Minh luôn hiện kể cả 0 tài khoản.
- Hỗ trợ game Liên Minh bằng mã lol.
- Banner trang chủ có video nền Liên Quân loop nhẹ, không dùng khối CSS giả.

V68 FULL UPGRADE
- Sửa và bổ sung duyệt hồ sơ người bán; cho gửi lại hồ sơ bị từ chối.
- Thành viên/Admin có thể hủy yêu cầu nạp còn pending.
- Video banner có fallback ảnh khi lỗi/autoplay bị chặn.
- Bỏ CHAT ADMIN khỏi menu riêng; chuyển chat nội bộ vào Tiện ích hỗ trợ cùng Telegram/Facebook/điện thoại.
- Thêm thông báo tài khoản, lịch sử đăng nhập, đăng xuất mọi thiết bị.
- Thêm đánh giá/uy tín người bán và hiển thị rating/số đơn.
- Thêm cảnh báo hệ thống cho Admin.
- Yêu thích đồng bộ database, tài khoản đã xem gần đây, lịch sử biến động ví.
- Webhook thanh toán generic có thể nhận fixed memo và kiểm tra số tiền; muốn tự động thực tế vẫn cần cấu hình nhà cung cấp webhook/API.

V69 ITEM CODE + CCCD
- Mỗi mặt hàng đăng bán được cấp mã giao dịch riêng (listing_code), ví dụ GD-...
- Các mặt hàng cũ tự nhận mã GD-OLD-<id>.
- Khi phát sinh đơn mua, đơn hàng có mã riêng DH-...
- Mã giao dịch hiển thị trên card sản phẩm, Trung tâm người bán, lịch sử đơn và Admin.
- Ảnh CCCD người đăng ký người bán không còn mở công khai qua /uploads.
- Admin có nút XEM CCCD TRƯỚC / SAU và xem trong popup bảo vệ bằng phiên đăng nhập Admin.

V70 MOBILE + SELLER + GAME VIDEO FIX
- Mobile tăng kích thước nút và vùng chạm, hiển thị đầy đủ các mục như desktop bằng thanh menu cuộn ngang.
- Admin mobile có nút Về website và đầy đủ menu quản trị.
- Khách chưa đăng nhập bấm khu cần tài khoản sẽ mở popup Đăng nhập/Đăng ký thay vì bị đẩy trang.
- Bỏ thông báo/cổng cảnh báo tự bật khi mới vào website.
- Sửa luồng đăng ký/duyệt người bán và gửi lại hồ sơ bị từ chối.
- 4 video Liên Quân / Free Fire / PUBG / LMHT được gắn đúng card game.
- Thêm card GAME KHÁC; trên mobile 5 card game hiển thị dọc.
