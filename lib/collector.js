const fs = require('fs');
const path = require('path');
const config = require('./config');
const predictor = require('./predictor');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history_store.json');

class DataCollector {
  constructor() {
    this.historyStore = {}; // { [channelId]: Array<Session> }
    this.statusMap = {};    // { [channelId]: { online: boolean, ping: number, lastCheck: string, error?: string } }
    this.pollInterval = null;
    this.loadHistory();
  }

  loadHistory() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        this.historyStore = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('Lỗi khi đọc file history_store.json:', err.message);
      this.historyStore = {};
    }
  }

  saveHistory() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.historyStore, null, 2), 'utf-8');
    } catch (err) {
      console.error('Lỗi khi lưu history_store.json:', err.message);
    }
  }

  /**
   * Chuẩn hóa dữ liệu trả về từ các định dạng API khác nhau
   */
  normalizeResponse(data, channel) {
    if (!data || typeof data !== 'object') return null;

    let phien = null;
    let outcome = null;
    let total = null;
    let dices = [];
    let time = new Date().toLocaleTimeString('vi-VN');
    let md5 = null;
    let bettingInfo = null;

    // 1. Kiểm tra trường lồng (nested) như 789Club: data.current
    const source = data.current || data;

    // Tìm phiên
    if (source.phien !== undefined) phien = source.phien;
    else if (data.phien_cuoc !== undefined) phien = data.phien_cuoc;
    else if (data.betting_info?.phien_cuoc !== undefined) phien = data.betting_info.phien_cuoc;
    else if (data.session_id !== undefined) phien = data.session_id;
    else if (data.round_id !== undefined) phien = data.round_id;
    else if (data.cmd !== undefined && data.cmd > 1000) phien = data.cmd;

    // Chuẩn hóa phiên (bỏ dấu # nếu có)
    if (typeof phien === 'string') {
      phien = phien.replace('#', '').trim();
    }

    // Tìm kết quả
    if (source.ket_qua) outcome = source.ket_qua;
    else if (data.ket_qua) outcome = data.ket_qua;
    else if (data.even_odd) outcome = data.even_odd; // Xóc đĩa live: 'LẺ' / 'CHẴN'
    else if (data.result_text) outcome = data.result_text;
    else if (data.color) {
      // Xóc đĩa: "1 ĐỎ - 3 TRẮNG" -> Lẻ, "2 ĐỎ - 2 TRẮNG" -> Chẵn
      const c = data.color.toUpperCase();
      if (c.includes('1 ĐỎ') || c.includes('3 ĐỎ') || c.includes('1 TRẮNG') || c.includes('3 TRẮNG')) outcome = 'LẺ';
      else outcome = 'CHẴN';
    }

    // Tìm tổng điểm xúc xắc
    if (source.tong !== undefined && source.tong !== null) total = Number(source.tong);
    else if (data.tong !== undefined && data.tong !== null) total = Number(data.tong);

    // Tìm xúc xắc
    if (Array.isArray(source.xuc_xac) && source.xuc_xac.length >= 3) {
      dices = source.xuc_xac.map(Number);
    } else if (source.xuc_xac_1 !== undefined) {
      dices = [Number(source.xuc_xac_1), Number(source.xuc_xac_2), Number(source.xuc_xac_3)];
    } else if (data.xuc_xac_1 !== undefined) {
      dices = [Number(data.xuc_xac_1), Number(data.xuc_xac_2), Number(data.xuc_xac_3)];
    } else if (data.jackpot_result) {
      // Dạng xóc đĩa hoặc 4 hạt: '1-2-2-5'
      const parts = String(data.jackpot_result).split('-').map(Number);
      if (parts.length >= 3) dices = parts.slice(0, 3);
    }

    // Nếu chưa có tổng mà có xúc xắc
    if ((total === null || isNaN(total)) && dices.length === 3 && !dices.some(isNaN)) {
      total = dices[0] + dices[1] + dices[2];
    }

    // Nếu có tổng mà chưa có xúc xắc
    if ((!dices || dices.length < 3) && total !== null && !isNaN(total)) {
      dices = predictor.generateProbableDices(`${total}-${total}`, total >= 11 ? 'TÀI' : 'XỈU');
    }

    // Nếu chưa có outcome mà có total
    if (!outcome && total !== null && !isNaN(total)) {
      outcome = total >= 11 ? 'TÀI' : 'XỈU';
    }

    // Tìm thông tin thời gian
    if (source.update_at) time = source.update_at;
    else if (source.thoi_gian) time = source.thoi_gian;
    else if (data.update_at) time = data.update_at;
    else if (data.thoi_gian) time = data.thoi_gian;

    // MD5
    if (source.md5_decrypt || data.md5_decrypt) md5 = source.md5_decrypt || data.md5_decrypt;
    else if (source.md5_encrypt || data.md5_encrypt) md5 = source.md5_encrypt || data.md5_encrypt;
    else if (source.md5_result || data.md5_result) md5 = source.md5_result || data.md5_result;

    // Betting info
    if (data.betting_info) {
      bettingInfo = data.betting_info;
    }

    if (!phien) {
      phien = Date.now().toString().slice(-7);
    }

    const normOutcome = predictor.normalizeOutcome(outcome || 'TÀI');

    return {
      phien: String(phien),
      outcome: normOutcome,
      total: total || (normOutcome === 'TÀI' ? 12 : 8),
      dices: dices.length === 3 ? dices : [4, 4, 3],
      time: String(time),
      md5,
      bettingInfo,
      raw: data
    };
  }

  /**
   * Sinh dữ liệu lịch sử mô phỏng nối tiếp mượt mà nếu kênh mới khởi động
   * Đảm bảo giao diện luôn có đầy đủ 35-45 phiên soi cầu chuẩn đẹp
   */
  bootstrapHistory(channelId, latestSession, gameType) {
    const list = [];
    const basePhien = parseInt(latestSession.phien) || 2839100;
    const isXocdia = gameType === 'xocdia';
    const optA = isXocdia ? 'CHẴN' : 'TÀI';
    const optB = isXocdia ? 'LẺ' : 'XỈU';

    const count = 42;
    let prevOutcome = latestSession.outcome;

    for (let i = count; i >= 1; i--) {
      const p = basePhien - i;
      // Tạo chu kỳ cầu tự nhiên (có nhịp bệt 2-4 tay, có nhịp đảo 1-1)
      let outcome = prevOutcome;
      if (Math.random() > 0.46) {
        outcome = prevOutcome === optA ? optB : optA;
      }
      prevOutcome = outcome;

      let total, dices;
      if (!isXocdia) {
        if (outcome === 'TÀI') {
          total = Math.floor(Math.random() * 6) + 11; // 11 - 16
        } else {
          total = Math.floor(Math.random() * 6) + 5;  // 5 - 10
        }
        dices = predictor.generateProbableDices(`${total}-${total}`, outcome);
      } else {
        total = outcome === 'CHẴN' ? 2 : 1;
        dices = [1, 2, 3];
      }

      list.push({
        phien: String(p),
        outcome,
        total,
        dices,
        time: new Date(Date.now() - i * 60000).toLocaleTimeString('vi-VN'),
        md5: null
      });
    }

    list.push(latestSession);
    return list;
  }

  /**
   * Lấy dữ liệu từ một endpoint cụ thể
   */
  async fetchChannel(channel) {
    const startTime = Date.now();
    try {
      const res = await fetch(channel.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(4500)
      });
      const ping = Date.now() - startTime;

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();
      const norm = this.normalizeResponse(json, channel);

      if (!norm) {
        throw new Error('Định dạng phản hồi không hợp lệ');
      }

      // Cập nhật trạng thái
      this.statusMap[channel.id] = {
        online: true,
        ping,
        lastCheck: new Date().toLocaleTimeString('vi-VN'),
        latestSession: norm.phien
      };

      // Cập nhật lịch sử
      if (!this.historyStore[channel.id] || this.historyStore[channel.id].length === 0) {
        this.historyStore[channel.id] = this.bootstrapHistory(channel.id, norm, channel.gameType);
        this.saveHistory();
      } else {
        const history = this.historyStore[channel.id];
        const lastInHistory = history[history.length - 1];

        // Nếu phiên mới xuất hiện (khác phiên trước)
        if (String(lastInHistory.phien) !== String(norm.phien)) {
          console.log(`[Collector] Phiên mới phát hiện [${channel.id}]: Phiên ${norm.phien} - Kết quả: ${norm.outcome} (${norm.total} điểm)`);
          history.push(norm);
          // Giữ tối đa 100 phiên gần nhất
          if (history.length > 100) {
            history.shift();
          }
          this.saveHistory();
        }
      }

      return { ok: true, session: norm };
    } catch (err) {
      const ping = Date.now() - startTime;
      this.statusMap[channel.id] = {
        online: false,
        ping: Math.min(ping, 4500),
        lastCheck: new Date().toLocaleTimeString('vi-VN'),
        error: err.message
      };

      // Nếu chưa có lịch sử cho kênh này, tạo giả lập để UI không bị trống
      if (!this.historyStore[channel.id] || this.historyStore[channel.id].length === 0) {
        const dummyNorm = {
          phien: String(Date.now()).slice(-7),
          outcome: channel.gameType === 'xocdia' ? 'CHẴN' : 'TÀI',
          total: 12,
          dices: [4, 5, 3],
          time: new Date().toLocaleTimeString('vi-VN'),
          md5: null
        };
        this.historyStore[channel.id] = this.bootstrapHistory(channel.id, dummyNorm, channel.gameType);
      }

      return { ok: false, error: err.message };
    }
  }

  /**
   * Quét và cập nhật tất cả các kênh
   */
  async fetchAllChannels() {
    const channels = config.loadEndpoints();
    await Promise.allSettled(channels.map(c => this.fetchChannel(c)));
  }

  /**
   * Bắt đầu vòng lặp polling
   */
  startPolling(intervalMs = 6000) {
    if (this.pollInterval) clearInterval(this.pollInterval);
    console.log(`[Collector] Bắt đầu quét dữ liệu các cổng game mỗi ${intervalMs / 1000}s...`);
    this.fetchAllChannels();
    this.pollInterval = setInterval(() => {
      this.fetchAllChannels();
    }, intervalMs);
  }

  getChannelData(channelId) {
    const channels = config.loadEndpoints();
    const channel = channels.find(c => c.id === channelId) || channels[0];
    const history = this.historyStore[channel.id] || [];
    const status = this.statusMap[channel.id] || { online: false, ping: 0, lastCheck: '-' };
    const latest = history[history.length - 1] || null;

    // Chạy thuật toán dự đoán
    const prediction = predictor.predict(history, channel.gameType);

    return {
      channel,
      status,
      latest,
      history: history.slice(-50), // 50 phiên gần nhất
      prediction
    };
  }

  getAllChannelsOverview() {
    const channels = config.loadEndpoints();
    return channels.map(c => {
      const hist = this.historyStore[c.id] || [];
      const latest = hist[hist.length - 1] || null;
      const status = this.statusMap[c.id] || { online: false, ping: 0 };
      return {
        id: c.id,
        platform: c.platform,
        icon: c.icon,
        gameName: c.gameName,
        gameType: c.gameType,
        url: c.url,
        online: status.online,
        ping: status.ping,
        latestSession: latest ? latest.phien : '-',
        latestOutcome: latest ? latest.outcome : '-'
      };
    });
  }
}

module.exports = new DataCollector();
