const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./lib/config');
const collector = require('./lib/collector');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Lấy danh sách tất cả các cổng game và trạng thái
app.get('/api/channels', (req, res) => {
  try {
    const list = collector.getAllChannelsOverview();
    res.json({ success: true, channels: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Lấy chi tiết phiên, dự đoán và lịch sử của một kênh
app.get('/api/channel/:id', (req, res) => {
  try {
    const { id } = req.params;
    const data = collector.getChannelData(id);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Cập nhật URL của một kênh (khi link cloudflare thay đổi)
app.post('/api/channel/:id/update-url', (req, res) => {
  try {
    const { id } = req.params;
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'URL không hợp lệ' });
    }

    const updated = config.updateEndpointUrl(id, url);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy kênh' });
    }

    // Tự động kích hoạt fetch thử kênh vừa cập nhật
    const channels = config.loadEndpoints();
    const target = channels.find(c => c.id === id);
    if (target) {
      collector.fetchChannel(target);
    }

    res.json({ success: true, message: 'Đã cập nhật URL thành công!', url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Test kết nối thử một URL bất kỳ (kiểm tra ping và xem kết quả)
app.post('/api/test-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp URL' });
    }

    const startTime = Date.now();
    const response = await fetch(url.trim(), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000)
    });
    const ping = Date.now() - startTime;

    if (!response.ok) {
      return res.json({
        success: false,
        ping,
        status: response.status,
        error: `Máy chủ trả về mã HTTP ${response.status}`
      });
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 300) };
    }

    res.json({
      success: true,
      ping,
      status: response.status,
      data: json
    });
  } catch (err) {
    res.json({
      success: false,
      ping: 5000,
      error: err.message
    });
  }
});

// API: Bắt buộc làm mới dữ liệu kênh ngay lập tức
app.post('/api/force-refresh/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const channels = config.loadEndpoints();
    const target = channels.find(c => c.id === id);
    if (target) {
      await collector.fetchChannel(target);
    }
    const data = collector.getChannelData(id);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Lấy bảng xếp hạng & tổng quan AI tự chơi của tất cả các cổng
app.get('/api/ai/overview', (req, res) => {
  try {
    const overview = collector.getAiOverview();
    res.json({ success: true, data: overview });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Lấy chi tiết AI phân tích vị và thống kê train của 1 cổng
app.get('/api/ai/:id', (req, res) => {
  try {
    const { id } = req.params;
    const channelData = collector.getChannelData(id);
    res.json({ success: true, ai: channelData.ai, prediction: channelData.prediction, latest: channelData.latest });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bắt đầu quét dữ liệu các cổng game
collector.startPolling(5000);

// Khởi động Telegram Bot song song
try {
  require('./bot');
  console.log('🤖 Telegram Bot đã tích hợp vào hệ thống!');
} catch (err) {
  console.error('Lỗi khởi động Telegram Bot:', err.message);
}

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 [AI TÀI XỈU VIP SERVER] Đang chạy tại http://localhost:${PORT}`);
  console.log(`👑 [ADMIN TOKEN MANAGER] http://localhost:${PORT}/admin.html`);
  console.log(`📡 Đã tải danh sách các cổng game và khởi động bộ soi cầu đa thuật toán`);
  console.log(`====================================================`);
});

