const FIREBASE_BASE_URL = 'https://webe-f3a6e-default-rtdb.firebaseio.com';

const ADMIN_IDS = ['7769479790', '8083052279'];

class FirebaseService {
  constructor() {
    this.baseUrl = FIREBASE_BASE_URL;
    this.adminIds = ADMIN_IDS;
  }

  isAdmin(userId) {
    return this.adminIds.includes(String(userId));
  }

  /**
   * Kiểm tra quyền truy cập của người dùng theo thời gian thực:
   * 1. Admin luôn có quyền tối cao
   * 2. Nếu token bị xóa trong Firebase -> Lập tức out
   * 3. Nếu token hết hạn -> Lập tức out
   * 4. Nếu token bị thu hồi/gán cho người khác -> Lập tức out
   */
  async checkUserAuthorized(userId) {
    if (this.isAdmin(userId)) {
      return { authorized: true, isAdmin: true };
    }

    try {
      const userUrl = `${this.baseUrl}/users/${userId}.json`;
      const res = await fetch(userUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return { authorized: false, reason: 'NETWORK_ERROR' };

      const userData = await res.json();
      if (!userData || !userData.token) {
        return { authorized: false, reason: 'NO_TOKEN' };
      }

      // Kiểm tra trực tiếp token trong bảng /tokens/ để phát hiện token bị xóa hoặc thu hồi
      const tokenKey = encodeURIComponent(String(userData.token).trim().toUpperCase());
      const tokenRes = await fetch(`${this.baseUrl}/tokens/${tokenKey}.json`, { signal: AbortSignal.timeout(6000) });
      if (!tokenRes.ok) return { authorized: false, reason: 'TOKEN_NOT_FOUND' };

      const tokenData = await tokenRes.json();
      // Token bị xóa khỏi database
      if (!tokenData) {
        // Tự động dọn dẹp user đã mất token
        await fetch(userUrl, { method: 'DELETE' }).catch(() => {});
        return { authorized: false, reason: 'TOKEN_DELETED', message: 'Mã Token của bạn đã bị xóa khỏi hệ thống!' };
      }

      // Token đã bị thu hồi hoặc đổi sang user khác
      if (String(tokenData.used_by_id) !== String(userId)) {
        await fetch(userUrl, { method: 'DELETE' }).catch(() => {});
        return { authorized: false, reason: 'TOKEN_REVOKED', message: 'Mã Token của bạn đã bị thu hồi hoặc chuyển giao!' };
      }

      // Kiểm tra thời hạn nếu có expires_at
      if (tokenData.expires_at) {
        const expireTime = new Date(tokenData.expires_at).getTime();
        if (Date.now() > expireTime) {
          return { authorized: false, reason: 'TOKEN_EXPIRED', message: 'Mã Token của bạn đã hết hạn sử dụng!' };
        }
      }

      return { authorized: true, isAdmin: false, tokenData, userData };
    } catch (err) {
      console.error('[Firebase] Lỗi checkUserAuthorized:', err.message);
      return { authorized: false, reason: 'EXCEPTION' };
    }
  }

  async activateUserWithToken(userId, userDetails, rawToken) {
    try {
      const tokenKey = String(rawToken).trim().toUpperCase();
      const tokenUrl = `${this.baseUrl}/tokens/${encodeURIComponent(tokenKey)}.json`;

      // Kiểm tra token có tồn tại
      const res = await fetch(tokenUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) {
        return { success: false, reason: 'NETWORK_ERROR', message: 'Lỗi kết nối cơ sở dữ liệu' };
      }

      const tokenData = await res.json();
      if (!tokenData) {
        return { success: false, reason: 'NOT_FOUND', message: 'Mã Token không tồn tại trên hệ thống!' };
      }

      // Kiểm tra token đã bị tài khoản khác sử dụng chưa
      if (tokenData.used && String(tokenData.used_by_id) !== String(userId)) {
        return {
          success: false,
          reason: 'ALREADY_USED',
          message: `Mã Token này đã được kích hoạt bởi tài khoản khác (ID: ${tokenData.used_by_id || 'Ẩn'})! Mỗi token chỉ được dùng cho 1 tài khoản duy nhất.`
        };
      }

      // Tính ngày hết hạn theo thời hạn đăng ký
      const now = new Date();
      let expiresAt = null;
      if (tokenData.duration === '1 Ngày') {
        expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      } else if (tokenData.duration === '3 Ngày') {
        expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
      } else if (tokenData.duration === '7 Ngày') {
        expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (tokenData.duration === '30 Ngày') {
        expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      }

      // Đánh dấu token đã dùng
      const updatedToken = {
        ...tokenData,
        used: true,
        used_by_id: String(userId),
        used_by_name: userDetails.username ? `@${userDetails.username}` : (userDetails.first_name || 'Người dùng'),
        used_at: now.toISOString(),
        expires_at: expiresAt
      };

      await fetch(tokenUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedToken)
      });

      // Lưu thông tin user
      const userUrl = `${this.baseUrl}/users/${userId}.json`;
      const userData = {
        token: tokenKey,
        activated_at: now.toISOString(),
        expires_at: expiresAt,
        username: userDetails.username || '',
        first_name: userDetails.first_name || '',
        last_active: now.toISOString()
      };

      await fetch(userUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData)
      });

      return { success: true, tokenData: updatedToken, message: 'Kích hoạt tài khoản thành công!' };
    } catch (err) {
      console.error('[Firebase] Lỗi activateUserWithToken:', err.message);
      return { success: false, reason: 'EXCEPTION', message: `Lỗi: ${err.message}` };
    }
  }

  // Quản lý chế độ bảo trì
  async setMaintenance(active, message = '', adminId = '') {
    try {
      const url = `${this.baseUrl}/system/maintenance.json`;
      const data = {
        active: !!active,
        message: message || 'Hệ thống đang bảo trì để cập nhật API các cổng game. Vui lòng quay lại sau ít phút!',
        updated_by: String(adminId),
        updated_at: new Date().toISOString()
      };
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return { success: true, data };
    } catch (err) {
      console.error('[Firebase] Lỗi setMaintenance:', err.message);
      return { success: false, error: err.message };
    }
  }

  async getMaintenance() {
    try {
      const url = `${this.baseUrl}/system/maintenance.json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { active: false };
      const data = await res.json();
      return data || { active: false };
    } catch {
      return { active: false };
    }
  }

  async createToken(tokenKey, options = {}) {
    try {
      const key = String(tokenKey).trim().toUpperCase();
      const url = `${this.baseUrl}/tokens/${encodeURIComponent(key)}.json`;
      const now = new Date().toISOString();

      const data = {
        token: key,
        created_at: now,
        duration: options.duration || 'Vĩnh viễn',
        note: options.note || 'Tạo bởi Admin',
        used: false,
        used_by_id: null,
        used_by_name: null,
        used_at: null,
        expires_at: null
      };

      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async getAllTokens() {
    try {
      const url = `${this.baseUrl}/tokens.json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return {};
      const data = await res.json();
      return data || {};
    } catch {
      return {};
    }
  }

  async deleteToken(tokenKey) {
    try {
      const key = String(tokenKey).trim().toUpperCase();
      const url = `${this.baseUrl}/tokens/${encodeURIComponent(key)}.json`;
      await fetch(url, { method: 'DELETE' });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new FirebaseService();
