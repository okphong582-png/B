# HƯỚNG DẪN VÀ TÀI LIỆU HỆ THỐNG BOT TÀI XỈU AI & WEB DASHBOARD

Hệ thống bot Telegram kết hợp Web Dashboard soi cầu đa thuật toán kết nối hơn 15 cổng game (Sunwin, Hitclub, 789Club, B52, LC79, Rikvip, Betvip, Son789, Ta28, Luck8, Xocdia88...).

---

## 1. Thông Tin Admin Quản Trị Cấp Cao
- **Admin 1**: ID Telegram `7769479790` (@spamsmstaken)
- **Admin 2**: ID Telegram `8083052279` (@icebearvndev)
- *2 tài khoản này được phân quyền Super Admin vĩnh viễn, không cần nhập mã token.*

---

## 2. Các Lệnh Quản Trị Dành Riêng Cho Admin Trên Telegram
- `/updatecong`: Xem danh sách tất cả các cổng game, bấm chọn cổng và gửi link Cloudflare mới để cập nhật tức thì. Hoặc dùng cú pháp nhanh: `/updatecong <mã_cổng> <link_mới>`.
- `/baotri <nội dung>`: Đặt trạng thái bảo trì toàn hệ thống. Người dùng thông thường sẽ nhận được thông báo này và bị tạm khóa.
- `/tatbaotri`: Tắt bảo trì, mở lại cho người dùng truy cập bình thường.

---

## 3. Bản Quyền & Cơ Chế Auto Kick-Out
- Khi người dùng mới vào bot, bot sẽ yêu cầu nhập Token và hiển thị liên hệ:
  - **Admin 1**: `@spamsmstaken`
  - **Admin 2**: `@icebearvndev`
- **Cơ chế Realtime Auth**: Mỗi lượt người dùng thao tác, bot kiểm tra trực tiếp Firebase:
  - Nếu mã Token bị Admin xóa trên web quản trị.
  - Hoặc mã Token hết hạn (1 ngày, 7 ngày, 30 ngày...).
  - 👉 **Người dùng lập tức bị out ngay (Kick-out)** và không thể tiếp tục soi cầu.

---

## 4. Trang Quản Trị Cấp Token Web
- Địa chỉ: `http://localhost:3000/admin.html`
- Kết nối Firebase Realtime Database: tạo mã token mới, xem mã nào đã kích hoạt (kèm Telegram ID & Tên người dùng), bật/tắt bảo trì hoặc xóa token.
