const FIREBASE_BASE_URL = 'https://webe-f3a6e-default-rtdb.firebaseio.com';

class FirebaseService {
  constructor() {
    this.baseUrl = FIREBASE_BASE_URL;
  }

  async checkUserAuthorized(userId) {
    try {
      const url = `${this.baseUrl}/users/${userId}.json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return false;
      const data = await res.json();
      return !!data && !!data.token;
    } catch (err) {
      console.error('[Firebase] Lỗi kiểm tra user:', err.message);
      return false;
    }
  }

  async activateUserWithToken(userId, userDetails, rawToken) {
    try {
      const tokenKey = String(rawToken).trim().toUpperCase();
      const tokenUrl = `${this.baseUrl}/tokens/${encodeURIComponent(tokenKey)}.json`;

      // 1. Kiểm tra token có tồn tại không
      const res = await fetch(tokenUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) {
        return { success: false, reason: 'NETWORK_ERROR', message: 'Lỗi kết nối cơ sở dữ liệu' };
      }

      const tokenData = await res.json();
      if (!tokenData) {
        return { success: false, reason: 'NOT_FOUND', message: 'Mã Token không tồn tại trên hệ thống!' };
      }

      // 2. Kiểm tra token đã bị ai sử dụng chưa (mỗi token chỉ dùng 1 acc)
      if (tokenData.used) {
        // Nếu chính tài khoản này đã kích hoạt trước đó thì vẫn cho phép vào
        if (String(tokenData.used_by_id) === String(userId)) {
          return { success: true, tokenData, message: 'Tài khoản của bạn đã kích hoạt token này từ trước.' };
        }
        return {
          success: false,
          reason: 'ALREADY_USED',
          message: `Mã Token này đã được kích hoạt bởi tài khoản khác (ID: ${tokenData.used_by_id || 'Ẩn'}). Mỗi token chỉ được cấp cho 1 tài khoản duy nhất!`
        };
      }

      // 3. Đánh dấu token đã dùng
      const now = new Date().toISOString();
      const updatedToken = {
        ...tokenData,
        used: true,
        used_by_id: String(userId),
        used_by_name: userDetails.username ? `@${userDetails.username}` : (userDetails.first_name || 'Người dùng'),
        used_at: now
      };

      await fetch(tokenUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedToken)
      });

      // 4. Lưu user vào nhánh /users/{userId}
      const userUrl = `${this.baseUrl}/users/${userId}.json`;
      const userData = {
        token: tokenKey,
        activated_at: now,
        username: userDetails.username || '',
        first_name: userDetails.first_name || '',
        last_active: now
      };

      await fetch(userUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData)
      });

      return { success: true, tokenData: updatedToken, message: 'Kích hoạt tài khoản thành công!' };
    } catch (err) {
      console.error('[Firebase] Lỗi kích hoạt token:', err.message);
      return { success: false, reason: 'EXCEPTION', message: `Lỗi: ${err.message}` };
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
        used_at: null
      };

      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      return { success: true, data };
    } catch (err) {
      console.error('[Firebase] Lỗi tạo token:', err.message);
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
    } catch (err) {
      console.error('[Firebase] Lỗi đọc tokens:', err.message);
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
