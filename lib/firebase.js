const FIREBASE_BASE_URL = 'https://webe-f3a6e-default-rtdb.firebaseio.com';

const DEFAULT_ADMIN_IDS = ['7769479790', '8083052279'];

class FirebaseService {
  constructor() {
    this.baseUrl = FIREBASE_BASE_URL;
    this.cachedAdmins = new Set();
    this.initAdmins();
  }

  async initAdmins() {
    try {
      // Kiểm tra xem hệ thống đã từng khởi tạo admins chưa
      const initCheckRes = await fetch(`${this.baseUrl}/system/admins_initialized.json`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
      const isInitialized = initCheckRes && initCheckRes.ok ? await initCheckRes.json() : false;

      if (!isInitialized) {
        // Chỉ chạy khởi tạo lần đầu duy nhất nếu DB trống hoàn toàn
        for (const id of DEFAULT_ADMIN_IDS) {
          const username = id === '7769479790' ? 'spamsmstaken' : 'icebearvndev';
          await fetch(`${this.baseUrl}/system/admins/${id}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: String(id),
              username: `@${username}`,
              name: `Super Admin (${username})`,
              role: 'Super Admin',
              is_admin: true,
              created_at: new Date().toISOString()
            })
          }).catch(() => {});
        }
        await fetch(`${this.baseUrl}/system/admins_initialized.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(true)
        }).catch(() => {});
      }

      await this.refreshAdminsCache();
      // Tự động đồng bộ danh sách admin từ Firebase mỗi 5 giây
      setInterval(() => {
        this.refreshAdminsCache();
      }, 5000);
    } catch (e) {}
  }

  async refreshAdminsCache() {
    try {
      const res = await fetch(`${this.baseUrl}/system/admins.json`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const activeAdmins = new Set();
        if (data && typeof data === 'object') {
          for (const [id, item] of Object.entries(data)) {
            if (!item) continue;
            const strId = String(id).trim();
            const roleStr = String(item.role || '').trim().toLowerCase();
            const isDemoted = item.is_admin === false ||
              roleStr === 'user' ||
              roleStr === 'dân thường' ||
              roleStr === 'dan thuong' ||
              roleStr === 'người dùng' ||
              roleStr === 'nguoi dung';

            if (!isDemoted) {
              activeAdmins.add(strId);
            }
          }
        }
        this.cachedAdmins = activeAdmins;
      }
    } catch (e) {}
  }

  isAdmin(userId) {
    if (!userId) return false;
    const strId = String(userId).trim();
    // Quyền admin hoàn toàn dựa vào database thời gian thực, không hardcode cố định
    return this.cachedAdmins.has(strId);
  }

  async getAllAdmins() {
    await this.refreshAdminsCache();
    try {
      const res = await fetch(`${this.baseUrl}/system/admins.json`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        return data || {};
      }
      return {};
    } catch {
      return {};
    }
  }

  // Thăng cấp / khôi phục quyền Admin
  async promoteToAdmin(adminId, role = 'Super Admin', name = '') {
    try {
      const id = String(adminId).trim();
      if (!id) return { success: false, error: 'ID không hợp lệ' };

      const existingRes = await fetch(`${this.baseUrl}/system/admins/${id}.json`, { signal: AbortSignal.timeout(5000) });
      const existing = (existingRes.ok ? await existingRes.json() : {}) || {};

      const defaultName = id === '7769479790' ? 'Super Admin (@spamsmstaken)' : (id === '8083052279' ? 'Super Admin (@icebearvndev)' : `Admin ${id}`);
      const defaultUser = id === '7769479790' ? '@spamsmstaken' : (id === '8083052279' ? '@icebearvndev' : '');

      const data = {
        ...existing,
        id,
        name: name || (existing.name && !existing.name.startsWith('Admin ') ? existing.name : defaultName),
        username: existing.username || defaultUser,
        role: role || 'Super Admin',
        is_admin: true,
        updated_at: new Date().toISOString()
      };

      await fetch(`${this.baseUrl}/system/admins/${id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      this.cachedAdmins.add(id);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async addAdmin(adminId, info = {}) {
    return this.promoteToAdmin(adminId, info.role || 'Admin', info.name || '');
  }

  // Chuyển Admin thành Dân Thường (Người dùng bình thường)
  async demoteAdminToUser(adminId) {
    try {
      const id = String(adminId).trim();
      if (!id) return { success: false, error: 'ID không hợp lệ' };

      const existingRes = await fetch(`${this.baseUrl}/system/admins/${id}.json`, { signal: AbortSignal.timeout(5000) });
      const existing = (existingRes.ok ? await existingRes.json() : {}) || {};

      const data = {
        ...existing,
        id,
        name: existing.name || (id === '7769479790' ? 'User (@spamsmstaken)' : (id === '8083052279' ? 'User (@icebearvndev)' : `Người dùng ${id}`)),
        username: existing.username || (id === '7769479790' ? '@spamsmstaken' : (id === '8083052279' ? '@icebearvndev' : '')),
        role: 'Dân thường',
        is_admin: false,
        demoted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await fetch(`${this.baseUrl}/system/admins/${id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      this.cachedAdmins.delete(id);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async removeAdmin(adminId) {
    return this.demoteAdminToUser(adminId);
  }

  // Xóa vĩnh viễn khỏi danh sách
  async deleteAdminPermanently(adminId) {
    try {
      const id = String(adminId).trim();
      await fetch(`${this.baseUrl}/system/admins/${id}.json`, { method: 'DELETE' });
      this.cachedAdmins.delete(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Chuyển đổi qua lại 2 chiều giữa Admin ⇄ Dân thường
  async toggleAdminRole(adminId) {
    const id = String(adminId).trim();
    if (this.isAdmin(id)) {
      return await this.demoteAdminToUser(id);
    } else {
      return await this.promoteToAdmin(id);
    }
  }

  async updateAdminInfo(adminId, info = {}) {
    try {
      const id = String(adminId).trim();
      if (!id) return { success: false, error: 'ID không hợp lệ' };

      const existingRes = await fetch(`${this.baseUrl}/system/admins/${id}.json`, { signal: AbortSignal.timeout(5000) });
      const existing = (existingRes.ok ? await existingRes.json() : {}) || {};

      const newRole = info.role !== undefined ? info.role : (existing.role || 'Super Admin');
      const roleStr = String(newRole).toLowerCase();
      const isDemoted = roleStr === 'user' || roleStr === 'dân thường' || roleStr === 'dan thuong' || roleStr === 'người dùng' || roleStr === 'nguoi dung';

      const data = {
        ...existing,
        id,
        name: info.name !== undefined ? info.name : (existing.name || `Admin ${id}`),
        role: newRole,
        username: info.username !== undefined ? info.username : (existing.username || ''),
        is_admin: !isDemoted,
        updated_at: new Date().toISOString()
      };

      await fetch(`${this.baseUrl}/system/admins/${id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (isDemoted) {
        this.cachedAdmins.delete(id);
      } else {
        this.cachedAdmins.add(id);
      }
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async saveCardTransaction(requestId, data = {}) {
    try {
      const url = `${this.baseUrl}/transactions/cards/${encodeURIComponent(requestId)}.json`;
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          created_at: data.created_at || new Date().toISOString()
        })
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async updateCardTransaction(requestId, updates = {}) {
    try {
      const url = `${this.baseUrl}/transactions/cards/${encodeURIComponent(requestId)}.json`;
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updates,
          updated_at: new Date().toISOString()
        })
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async getCardTransactions() {
    try {
      const res = await fetch(`${this.baseUrl}/transactions/cards.json`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        return (await res.json()) || {};
      }
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Phân tích chuỗi thời hạn thành mili-giây
   */
  parseDurationMs(durationStr) {
    if (!durationStr || typeof durationStr !== 'string') return null;
    const s = durationStr.toLowerCase().trim();

    if (s.includes('vinh') || s.includes('viễn') || s.includes('vien') || s.includes('forever') || s.includes('tron') || s.includes('trọn') || s.includes('life')) {
      return null; // Vĩnh viễn (không bao giờ hết hạn)
    }

    // 1 Ngày / 24 Giờ
    if ((s.includes('1') || s.startsWith('1')) && (s.includes('ngay') || s.includes('ngày') || s.includes('day') || s.includes('d'))) {
      return 24 * 60 * 60 * 1000;
    }
    // 3 Ngày
    if ((s.includes('3') || s.startsWith('3')) && (s.includes('ngay') || s.includes('ngày') || s.includes('day') || s.includes('d'))) {
      return 3 * 24 * 60 * 60 * 1000;
    }
    // 7 Ngày / 1 Tuần
    if ((s.includes('7') || s.startsWith('7') || s.includes('tuần') || s.includes('tuan') || s.includes('week') || s.includes('w')) && !s.includes('30')) {
      return 7 * 24 * 60 * 60 * 1000;
    }
    // 30 Ngày / 1 Tháng
    if (s.includes('30') || s.includes('tháng') || s.includes('thang') || s.includes('month') || s.includes('30d') || s.includes('1m')) {
      return 30 * 24 * 60 * 60 * 1000;
    }
    // Bất kỳ số ngày nào: ví dụ "5 ngày", "10d"
    const dayMatch = s.match(/(\d+)\s*(ngày|ngay|day|d)/);
    if (dayMatch) {
      return parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
    }
    // Giờ: ví dụ "1h", "2 giờ", "12 hours"
    const hourMatch = s.match(/(\d+)\s*(giờ|gio|hour|h)/);
    if (hourMatch) {
      return parseInt(hourMatch[1]) * 60 * 60 * 1000;
    }
    // Phút (tiện test): ví dụ "5 phút", "10m", "5p"
    const minMatch = s.match(/(\d+)\s*(phút|phut|min|p)/);
    if (minMatch) {
      return parseInt(minMatch[1]) * 60 * 1000;
    }

    // Mặc định nếu không nhận diện được: 30 ngày an toàn
    return 30 * 24 * 60 * 60 * 1000;
  }

  /**
   * Kiểm tra quyền truy cập của người dùng theo thời gian thực:
   * Nếu token bị xóa hoặc hết hạn -> Lập tức out (Xóa luôn user khỏi nhánh /users)
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

      // Kiểm tra trực tiếp token trong bảng /tokens/
      const tokenKey = encodeURIComponent(String(userData.token).trim().toUpperCase());
      const tokenRes = await fetch(`${this.baseUrl}/tokens/${tokenKey}.json`, { signal: AbortSignal.timeout(6000) });
      if (!tokenRes.ok) return { authorized: false, reason: 'TOKEN_NOT_FOUND' };

      const tokenData = await tokenRes.json();
      // 1. Token đã bị xóa khỏi database
      if (!tokenData) {
        await fetch(userUrl, { method: 'DELETE' }).catch(() => {});
        return { authorized: false, reason: 'TOKEN_DELETED', message: 'Mã Token của bạn đã bị xóa khỏi hệ thống!' };
      }

      // 2. Token đã bị gán cho tài khoản khác
      if (tokenData.used_by_id && String(tokenData.used_by_id) !== String(userId)) {
        await fetch(userUrl, { method: 'DELETE' }).catch(() => {});
        return { authorized: false, reason: 'TOKEN_REVOKED', message: 'Mã Token của bạn đã bị thu hồi hoặc đổi sang tài khoản khác!' };
      }

      // 3. Kiểm tra hết hạn chính xác
      let isExpired = false;
      const nowMs = Date.now();

      // Kiểm tra expires_at ở tokenData
      if (tokenData.expires_at) {
        const t = new Date(tokenData.expires_at).getTime();
        if (!isNaN(t) && nowMs > t) isExpired = true;
      }
      // Kiểm tra expires_at ở userData
      if (!isExpired && userData.expires_at) {
        const t = new Date(userData.expires_at).getTime();
        if (!isNaN(t) && nowMs > t) isExpired = true;
      }
      // Kiểm tra dựa trên duration & used_at / activated_at
      if (!isExpired && tokenData.duration) {
        const durMs = this.parseDurationMs(tokenData.duration);
        if (durMs !== null) {
          const startTime = new Date(tokenData.used_at || userData.activated_at || tokenData.created_at).getTime();
          if (!isNaN(startTime) && (nowMs > startTime + durMs)) {
            isExpired = true;
          }
        }
      }

      if (isExpired) {
        // Đã hết hạn -> xóa user khỏi database để chặn vĩnh viễn và đánh dấu expired
        await fetch(userUrl, { method: 'DELETE' }).catch(() => {});
        await fetch(`${this.baseUrl}/tokens/${tokenKey}/expired.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(true)
        }).catch(() => {});

        return { authorized: false, reason: 'TOKEN_EXPIRED', message: 'Mã Token của bạn đã hết hạn sử dụng!' };
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

      const res = await fetch(tokenUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) {
        return { success: false, reason: 'NETWORK_ERROR', message: 'Lỗi kết nối cơ sở dữ liệu' };
      }

      const tokenData = await res.json();
      if (!tokenData) {
        return { success: false, reason: 'NOT_FOUND', message: 'Mã Token không tồn tại trên hệ thống!' };
      }

      // Kiểm tra token đã bị người khác dùng chưa
      if (tokenData.used && String(tokenData.used_by_id) !== String(userId)) {
        return {
          success: false,
          reason: 'ALREADY_USED',
          message: `Mã Token này đã được kích hoạt bởi tài khoản khác (ID: ${tokenData.used_by_id || 'Ẩn'})! Mỗi token chỉ được dùng cho 1 tài khoản duy nhất.`
        };
      }

      const now = new Date();
      let expiresAt = null;
      const durMs = this.parseDurationMs(tokenData.duration);
      if (durMs !== null) {
        expiresAt = new Date(now.getTime() + durMs).toISOString();
      }

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
      return { success: false, reason: 'EXCEPTION', message: `Lỗi: ${err.message}` };
    }
  }

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
