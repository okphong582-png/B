/**
 * 24/7 RUNNER WRAPPER FOR GITHUB ACTIONS
 * Giữ bot hoạt động liên tục 24/24 trên GitHub Actions.
 * Tự động xoay vòng sau 4 giờ 50 phút trước khi GitHub chạm ngưỡng giới hạn 5-6 giờ.
 */

const { spawn } = require('child_process');

console.log('🚀 [24/7 Runner] Khởi động hệ thống chạy liên tục...');

// Khởi chạy server.js (bao gồm Web Server, Collector và Telegram Bot)
const child = spawn('node', ['server.js'], {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (err) => {
  console.error('[24/7 Runner] Lỗi tiến trình:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.log(`[24/7 Runner] Tiến trình con kết thúc với mã: ${code}, signal: ${signal}`);
  process.exit(code || 0);
});

// Giới hạn 4 giờ 50 phút (290 phút) để kích hoạt xoay vòng phiên mới trước khi GitHub timeout
const MAX_RUN_TIME_MS = 4 * 60 * 60 * 1000 + 50 * 60 * 1000;

console.log(`⏱ [24/7 Runner] Đặt lịch tự động hoàn thành sau 4h50m để chuyển giao runner kế tiếp...`);

setTimeout(() => {
  console.log('🔄 [24/7 Runner] Đã đạt 4h50m hoạt động. Đang kết thúc phiên mượt mà để GitHub Action lượt mới tiếp quản...');
  child.kill('SIGTERM');
  setTimeout(() => {
    process.exit(0);
  }, 3000);
}, MAX_RUN_TIME_MS);
