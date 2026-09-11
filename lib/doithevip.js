const crypto = require('crypto');

const PARTNER_ID = process.env.DOITHEVIP_PARTNER_ID || '60448208703';
const PARTNER_KEY = process.env.DOITHEVIP_PARTNER_KEY || '028e31af6e924f6dcea682d29e8779ef';
const WALLET_NUMBER = process.env.DOITHEVIP_WALLET || '0051717476';
const BASE_URL = 'https://doithevip.com';

class DoiTheVipService {
  constructor() {
    this.partnerId = PARTNER_ID;
    this.partnerKey = PARTNER_KEY;
    this.walletNumber = WALLET_NUMBER;
    this.baseUrl = BASE_URL;
  }

  /**
   * Tạo chữ ký MD5 chuẩn Doithevip
   * md5(partner_key + code + command + partner_id + request_id + serial + telco)
   */
  generateSign(command, code, serial, telco, requestId) {
    const raw = `${this.partnerKey}${code}${command}${this.partnerId}${requestId}${serial}${telco}`;
    return crypto.createHash('md5').update(raw).digest('hex');
  }

  /**
   * Gửi thẻ cào lên hệ thống Doithevip
   * @param {Object} param0 
   * @param {string} param0.telco - VIETTEL, MOBIFONE, VINAPHONE, ZING, GATE, VIETNAMOBILE
   * @param {string} param0.code - Mã thẻ cào
   * @param {string} param0.serial - Số Seri
   * @param {number|string} param0.amount - Mệnh giá khai báo (10000, 50000, 100000, 200000, 500000, 1000000)
   * @param {string} param0.requestId - Mã đơn duy nhất
   */
  async sendCard({ telco, code, serial, amount, requestId }) {
    const command = 'charging';
    const cleanTelco = String(telco).trim().toUpperCase();
    const cleanCode = String(code).trim().replace(/\s+/g, '');
    const cleanSerial = String(serial).trim().replace(/\s+/g, '');
    const cleanAmount = String(amount).trim();
    const reqId = requestId || `REQ-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const sign = this.generateSign(command, cleanCode, cleanSerial, cleanTelco, reqId);

    const bodyData = new URLSearchParams({
      telco: cleanTelco,
      code: cleanCode,
      serial: cleanSerial,
      amount: cleanAmount,
      request_id: reqId,
      partner_id: this.partnerId,
      sign: sign,
      command: command
    });

    try {
      const res = await fetch(`${this.baseUrl}/chargingws/v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TelegramBot-AutoToken/2.0'
        },
        body: bodyData.toString(),
        signal: AbortSignal.timeout(15000)
      });

      const data = await res.json();
      return {
        ok: true,
        request_id: reqId,
        ...data
      };
    } catch (err) {
      return {
        ok: false,
        status: 100,
        message: `Lỗi kết nối máy chủ gạch thẻ: ${err.message}`,
        request_id: reqId
      };
    }
  }

  /**
   * Kiểm tra trạng thái thẻ cào
   */
  async checkCard({ telco, code, serial, amount, requestId }) {
    const command = 'check';
    const cleanTelco = String(telco).trim().toUpperCase();
    const cleanCode = String(code).trim().replace(/\s+/g, '');
    const cleanSerial = String(serial).trim().replace(/\s+/g, '');
    const cleanAmount = String(amount).trim();

    const sign = this.generateSign(command, cleanCode, cleanSerial, cleanTelco, requestId);

    const bodyData = new URLSearchParams({
      command: command,
      telco: cleanTelco,
      code: cleanCode,
      serial: cleanSerial,
      amount: cleanAmount,
      request_id: requestId,
      partner_id: this.partnerId,
      sign: sign
    });

    try {
      const res = await fetch(`${this.baseUrl}/chargingws/v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TelegramBot-AutoToken/2.0'
        },
        body: bodyData.toString(),
        signal: AbortSignal.timeout(15000)
      });

      return await res.json();
    } catch (err) {
      return {
        status: 99,
        message: `Đang chờ xử lý (${err.message})`
      };
    }
  }

  /**
   * Lấy bảng phí đổi thẻ cào
   */
  async getCardFees() {
    try {
      const res = await fetch(`${this.baseUrl}/chargingws/v2/getfee?partner_id=${this.partnerId}`, {
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        return await res.json();
      }
      return [];
    } catch {
      return [];
    }
  }
}

module.exports = new DoiTheVipService();
