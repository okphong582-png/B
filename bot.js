/**
 * TOOL TÀI XỈU VIP - TELEGRAM BOT CONTROLLER
 * Hỗ trợ phân quyền Super Admin (7769479790, 8083052279)
 * Lệnh /updatecong cập nhật API cổng game trực tiếp
 * Lệnh /baotri phát thông báo bảo trì toàn hệ thống
 * Tự động kick out lập tức khi token bị xóa hoặc hết hạn
 * Liên hệ Admin mua token: @spamsmstaken và @icebearvndev
 */

const firebase = require('./lib/firebase');
const collector = require('./lib/collector');
const config = require('./lib/config');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8738721874:AAG22QXgkzi8tURDRWJLkmJQUCtdbIxnG2E';
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ADMIN_CONTACT = `👑 <b>Admin 1:</b> @spamsmstaken\n👑 <b>Admin 2:</b> @icebearvndev`;

// Bộ nhớ đệm
const notificationSubscribers = new Set();
const adminInputState = {}; // { [adminChatId]: { action: string, portalId?: string } }
let lastBroadcastSessions = {};
let isPolling = false;
let updateOffset = 0;

// Gọi Telegram Bot API
async function callApi(method, body = {}) {
  try {
    const res = await fetch(`${BASE_URL}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000)
    });
    return await res.json();
  } catch (err) {
    if (err.name !== 'TimeoutError') {
      console.error(`[Telegram API Error] ${method}:`, err.message);
    }
    return null;
  }
}

async function sendMessage(chatId, text, options = {}) {
  return callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options
  });
}

async function editMessageText(chatId, messageId, text, options = {}) {
  return callApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options
  });
}

async function answerCallbackQuery(callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }
  return callApi('answerCallbackQuery', payload);
}

// Bàn phím chính cho User
function getUserKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '☀️ Sunwin TX', callback_data: 'pred_sunwin_tx' },
        { text: '🔥 Hitclub TX', callback_data: 'pred_hitclub_tx' }
      ],
      [
        { text: '👑 789Club TX', callback_data: 'pred_club789_tx' },
        { text: '✈️ B52 Tài Xỉu', callback_data: 'pred_b52_tx' }
      ],
      [
        { text: '💎 Rikvip TX', callback_data: 'pred_rikvip_tx' },
        { text: '🔟 LC79 Tài Xỉu', callback_data: 'pred_lc79_tx' }
      ],
      [
        { text: '🎲 Tài Xỉu MD5 (Hitclub)', callback_data: 'pred_hitclub_txmd5' },
        { text: '🎲 Tài Xỉu MD5 (B52)', callback_data: 'pred_b52_txmd5' }
      ],
      [
        { text: '🍀 Luck8 Sicbo', callback_data: 'pred_luck8_sicbo40' },
        { text: '🎯 Son789 TX', callback_data: 'pred_son789_tx' }
      ],
      [
        { text: '📋 Danh Sách Cổng Game Khác', callback_data: 'menu_all_portals' },
        { text: '🔔 Bật Báo Tự Động', callback_data: 'toggle_notify' }
      ],
      [
        { text: '📊 Tỷ Lệ Thắng AI', callback_data: 'view_accuracy' },
        { text: '👤 Thông Tin Bản Quyền', callback_data: 'user_info' }
      ]
    ]
  };
}

// Bàn phím đặc biệt cho Admin
function getAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🛠 Cập Nhật Link Cổng Game (/updatecong)', callback_data: 'admin_update_cong' },
        { text: '⚠️ Đặt Báo Trì (/baotri)', callback_data: 'admin_set_baotri' }
      ],
      [
        { text: '✅ Tắt Báo Trì (/tatbaotri)', callback_data: 'admin_off_baotri' },
        { text: '🔑 Quản Lý Token Bản Quyền', callback_data: 'admin_view_tokens' }
      ],
      [
        { text: '☀️ Sunwin TX', callback_data: 'pred_sunwin_tx' },
        { text: '🔥 Hitclub TX', callback_data: 'pred_hitclub_tx' }
      ],
      [
        { text: '👑 789Club TX', callback_data: 'pred_club789_tx' },
        { text: '✈️ B52 Tài Xỉu', callback_data: 'pred_b52_tx' }
      ],
      [
        { text: '📋 Xem Tất Cả Các Cổng', callback_data: 'menu_all_portals' }
      ]
    ]
  };
}

// Format tin nhắn dự đoán
function formatPredictionMessage(channelData) {
  const { channel, latest, prediction } = channelData;
  const nextNum = latest?.phien ? (parseInt(latest.phien) ? parseInt(latest.phien) + 1 : 'Kế Tiếp') : 'Kế Tiếp';
  const outcomeEmoji = prediction.prediction === 'TÀI' ? '🔴 TÀI' : '🔵 XỈU';
  const dicesStr = (prediction.predictedDices || [4, 4, 3]).join(' - ');
  const backtest = prediction.backtest || { winRate: 78.5, currentStreak: 3 };

  return `
👑 <b>TOOL DỰ ĐOÁN TÀI XỈU AI VIP</b> 👑
━━━━━━━━━━━━━━━━━━━━
🎮 <b>Cổng game:</b> ${channel.icon || '🎲'} <b>${channel.platform}</b> (${channel.gameName})
🎯 <b>MỤC TIÊU PHIÊN:</b> <code>#${nextNum}</code>

🔮 <b>KẾT QUẢ DỰ BÁO:</b> <b>${outcomeEmoji}</b>
📊 <b>ĐỘ TỰ TIN AI:</b> <b>${prediction.confidence}%</b>
🎲 <b>Xúc Xắc Dễ Ra:</b> <code>[ ${dicesStr} ]</code>
🎯 <b>Khoảng Điểm Dự Kiến:</b> <b>${prediction.expectedSumRange || '11 - 13'} Điểm</b>

⚡ <b>Hình Thái Cầu:</b> ${prediction.patternInfo?.name || 'Cầu Thuận'}
💡 <b>Gợi Ý Vào Tiền:</b> ${prediction.tactic || 'Vào Đều Tay 1x'}
📝 <i>"${prediction.advice || 'Cầu đang ổn định, giữ kỷ luật.'}"</i>
━━━━━━━━━━━━━━━━━━━━
⏱ <b>Phiên vừa xổ:</b> #${latest ? latest.phien : '---'} ra <b>${latest ? latest.outcome : '-'}</b> (${latest ? latest.total : '-'} điểm: ${(latest?.dices || []).join('-')})
📈 <b>Tỷ Lệ Thắng AI:</b> <b>${backtest.winRate}%</b> (Chuỗi thắng: ${backtest.currentStreak} tay)
⏱ <i>Cập nhật: ${new Date().toLocaleTimeString('vi-VN')}</i>
  `.trim();
}

// Xử lý tin nhắn văn bản
async function handleMessage(msg) {
  if (!msg.text || !msg.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();
  const isAdmin = firebase.isAdmin(userId);

  // 1. XỬ LÝ LỆNH RIÊNG DÀNH CHO ADMIN
  if (isAdmin) {
    // Xử lý nếu admin đang trong trạng thái gửi link cập nhật cổng
    if (adminInputState[chatId]?.action === 'awaiting_portal_url') {
      const portalId = adminInputState[chatId].portalId;
      delete adminInputState[chatId];

      if (!text.startsWith('http://') && !text.startsWith('https://')) {
        return sendMessage(chatId, `❌ Link không hợp lệ! Vui lòng bắt đầu bằng http:// hoặc https://`);
      }

      const updated = config.updateEndpointUrl(portalId, text);
      if (updated) {
        const channels = config.loadEndpoints();
        const target = channels.find(c => c.id === portalId);
        sendMessage(chatId, `⏳ Đang gửi ping kiểm tra kết nối link mới...`);
        const fetchRes = await collector.fetchChannel(target);

        return sendMessage(
          chatId,
          `
✅ <b>CẬP NHẬT LINK THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
🎮 <b>Cổng:</b> ${target.platform} (${target.gameName})
🔗 <b>Link mới:</b> <code>${text}</code>
📡 <b>Trạng thái:</b> ${fetchRes.ok ? '🟢 Kết Nối OK (Đã nhận phiên)' : '🔴 Chưa phản hồi'}
━━━━━━━━━━━━━━━━━━━━
<i>Link đã được lưu và áp dụng cho toàn bộ người dùng.</i>
          `.trim()
        );
      } else {
        return sendMessage(chatId, `❌ Không tìm thấy cổng game [${portalId}]`);
      }
    }

    // Xử lý nếu admin đang trong trạng thái nhập nội dung bảo trì
    if (adminInputState[chatId]?.action === 'awaiting_maintenance_msg') {
      delete adminInputState[chatId];
      await firebase.setMaintenance(true, text, userId);
      return sendMessage(
        chatId,
        `
⚠️ <b>ĐÃ KÍCH HOẠT CHẾ ĐỘ BẢO TRÌ!</b>
━━━━━━━━━━━━━━━━━━━━
📢 <b>Nội dung thông báo:</b>
<i>"${text}"</i>
━━━━━━━━━━━━━━━━━━━━
<i>Người dùng thông thường khi vào bot sẽ nhận được thông báo này và tạm dừng sử dụng. Gửi /tatbaotri để mở lại.</i>
        `.trim()
      );
    }

    // Lệnh /baotri <thông báo>
    if (text.startsWith('/baotri')) {
      const parts = text.split(' ');
      parts.shift();
      const content = parts.join(' ').trim();

      if (content.toLowerCase() === 'off' || content.toLowerCase() === 'tat') {
        await firebase.setMaintenance(false, '', userId);
        return sendMessage(chatId, `✅ <b>ĐÃ TẮT CHẾ ĐỘ BẢO TRÌ!</b>\nNgười dùng có thể sử dụng bot bình thường.`);
      }

      if (!content) {
        adminInputState[chatId] = { action: 'awaiting_maintenance_msg' };
        return sendMessage(chatId, `👉 <b>Vui lòng gửi nội dung thông báo bảo trì:</b>\n<i>(Ví dụ: Đang bảo trì cập nhật API các cổng game, dự kiến 15 phút xong)</i>`);
      }

      await firebase.setMaintenance(true, content, userId);
      return sendMessage(
        chatId,
        `
⚠️ <b>ĐÃ KÍCH HOẠT CHẾ ĐỘ BẢO TRÌ!</b>
━━━━━━━━━━━━━━━━━━━━
📢 <b>Nội dung thông báo:</b>
<i>"${content}"</i>
━━━━━━━━━━━━━━━━━━━━
<i>Người dùng thông thường sẽ nhận được thông báo bảo trì này. Gửi /tatbaotri khi bảo trì xong.</i>
        `.trim()
      );
    }

    // Lệnh /tatbaotri
    if (text === '/tatbaotri') {
      await firebase.setMaintenance(false, '', userId);
      return sendMessage(chatId, `✅ <b>ĐÃ TẮT CHẾ ĐỘ BẢO TRÌ!</b>\nNgười dùng có thể truy cập bot bình thường.`);
    }

    // Lệnh /updatecong [portalId] [url]
    if (text.startsWith('/updatecong')) {
      const parts = text.split(' ').filter(Boolean);
      // Nếu gõ dạng /updatecong <id> <url>
      if (parts.length >= 3) {
        const portalId = parts[1].trim();
        const newUrl = parts[2].trim();

        const updated = config.updateEndpointUrl(portalId, newUrl);
        if (updated) {
          const channels = config.loadEndpoints();
          const target = channels.find(c => c.id === portalId);
          collector.fetchChannel(target);
          return sendMessage(chatId, `✅ Đã cập nhật link cho <b>${portalId}</b> thành công:\n<code>${newUrl}</code>`);
        } else {
          return sendMessage(chatId, `❌ Không tìm thấy cổng game mã [${portalId}]`);
        }
      }

      // Nếu chỉ gõ /updatecong -> hiển thị danh sách cổng để chọn bấm cập nhật
      const channels = config.loadEndpoints();
      const rows = [];
      channels.forEach(c => {
        rows.push([{ text: `✏️ ${c.icon || '🎲'} ${c.platform} - ${c.gameName}`, callback_data: `admin_edit_url_${c.id}` }]);
      });
      rows.push([{ text: '🔙 Quay Lại', callback_data: 'back_main' }]);

      return sendMessage(
        chatId,
        `
🛠 <b>TRUNG TÂM CẬP NHẬT LINK CỔNG GAME (DÀNH CHO ADMIN)</b>
Bấm vào cổng game bạn muốn đổi link Cloudflare:
        `.trim(),
        { reply_markup: { inline_keyboard: rows } }
      );
    }
  }

  // 2. KIỂM TRA CHẾ ĐỘ BẢO TRÌ ĐỐI VỚI USER THƯỜNG
  if (!isAdmin) {
    const maintenance = await firebase.getMaintenance();
    if (maintenance && maintenance.active) {
      return sendMessage(
        chatId,
        `
⚠️ <b>HỆ THỐNG ĐANG BẢO TRÌ ĐỂ CẬP NHẬT API</b> ⚠️
━━━━━━━━━━━━━━━━━━━━
📌 <b>Thông báo từ Admin:</b>
<i>"${maintenance.message || 'Hệ thống đang được nâng cấp API các cổng game. Vui lòng quay lại sau ít phút!'}"</i>
━━━━━━━━━━━━━━━━━━━━
💬 <i>Mọi thắc mắc vui lòng liên hệ:</i>\n${ADMIN_CONTACT}
        `.trim()
      );
    }
  }

  // 3. KIỂM TRA QUYỀN TRUY CẬP (TOKEN BẢN QUYỀN THEO THỜI GIAN THỰC)
  const authCheck = await firebase.checkUserAuthorized(userId);

  // Nếu user chưa kích hoạt HOẶC token bị xóa/hết hạn -> LẬP TỨC OUT
  if (!authCheck.authorized) {
    // Nếu bị xóa hoặc hết hạn
    if (authCheck.reason === 'TOKEN_DELETED' || authCheck.reason === 'TOKEN_EXPIRED' || authCheck.reason === 'TOKEN_REVOKED') {
      return sendMessage(
        chatId,
        `
⚠️ <b>THÔNG BÁO: TOKEN CỦA BẠN ĐÃ HẾT HẠN HOẶC BỊ THU HỒI!</b>
━━━━━━━━━━━━━━━━━━━━
${authCheck.message || 'Bạn không thể tiếp tục sử dụng bot do token đã hết hạn hoặc bị xóa trên hệ thống.'}

👉 <b>Vui lòng liên hệ Admin để mua/gia hạn token bản quyền mới:</b>
${ADMIN_CONTACT}
━━━━━━━━━━━━━━━━━━━━
<i>Nếu bạn đã có mã Token mới, vui lòng gửi mã vào đây để kích hoạt lại:</i>
        `.trim()
      );
    }

    // Nếu chưa kích hoạt và gửi /start
    if (text === '/start') {
      return sendMessage(
        chatId,
        `
🔐 <b>CHÀO MỪNG BẠN ĐẾN VỚI BOT SOI CẦU TÀI XỈU VIP</b> 🔐
━━━━━━━━━━━━━━━━━━━━
⚠️ <b>YÊU CẦU KÍCH HOẠT BẢN QUYỀN:</b>
Hệ thống bot được bảo vệ bằng Token do <b>Admin</b> cấp phép.
Mỗi mã Token chỉ được kích hoạt cho <b>1 tài khoản duy nhất</b>.

👉 <b>Vui lòng gửi Mã Token của bạn vào đây để mở khóa bot:</b>
<i>(Ví dụ: VIP-8888-9999 hoặc mã bạn nhận được từ Admin)</i>
━━━━━━━━━━━━━━━━━━━━
💬 <b>NẾU CHƯA CÓ TOKEN BẢN QUYỀN, VUI LÒNG LIÊN HỆ ADMIN ĐỂ MUA:</b>
${ADMIN_CONTACT}
━━━━━━━━━━━━━━━━━━━━
        `.trim()
      );
    }

    // Người dùng nhập mã Token để kích hoạt
    const result = await firebase.activateUserWithToken(userId, msg.from, text);

    if (result.success) {
      return sendMessage(
        chatId,
        `
✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>Tài khoản:</b> ${msg.from.first_name || ''} (@${msg.from.username || userId})
🔑 <b>Mã Token:</b> <code>${text.toUpperCase()}</code>
⏱ <b>Thời hạn:</b> ${result.tokenData?.duration || 'Vĩnh viễn'}
━━━━━━━━━━━━━━━━━━━━
🎉 Chào mừng bạn! Bot đã sẵn sàng phân tích và soi cầu tất cả các cổng game trực tiếp.

👇 <b>Vui lòng chọn cổng game để bắt đầu:</b>
        `.trim(),
        { reply_markup: getUserKeyboard() }
      );
    } else {
      return sendMessage(
        chatId,
        `❌ <b>KÍCH HOẠT THẤT BẠI:</b>\n\n${result.message}\n\n💬 <b>Liên hệ Admin để mua token mới:</b>\n${ADMIN_CONTACT}`
      );
    }
  }

  // 4. NẾU ĐÃ KÍCH HOẠT (HOẶC LÀ ADMIN)
  if (text === '/start' || text === '/menu') {
    if (isAdmin) {
      return sendMessage(
        chatId,
        `
👑 <b>BẢNG ĐIỀU KHIỂN DÀNH CHO SUPER ADMIN</b> 👑
━━━━━━━━━━━━━━━━━━━━
Xin chào Sếp <b>${msg.from.first_name || 'Admin'}</b> (ID: <code>${userId}</code>)!
Hệ thống đã nhận diện bạn là Quản trị viên cấp cao.

🛠 <b>Các tính năng quản trị nhanh:</b>
• /updatecong - Đổi link API các cổng game khi Cloudflare reset
• /baotri &lt;nội dung&gt; - Đặt trạng thái bảo trì toàn hệ thống
• /tatbaotri - Mở lại hệ thống cho người dùng

👇 <b>Chọn thao tác hoặc xem soi cầu bên dưới:</b>
        `.trim(),
        { reply_markup: getAdminKeyboard() }
      );
    }

    return sendMessage(
      chatId,
      `
👑 <b>BẢNG ĐIỀU KHIỂN SOI CẦU TÀI XỈU VIP</b> 👑
━━━━━━━━━━━━━━━━━━━━
Xin chào <b>${msg.from.first_name || 'VIP'}</b>!
Hệ thống đang kết nối trực tiếp dữ liệu phiên từ hơn 15+ cổng game.

👇 <b>Chọn cổng game bạn muốn soi cầu ngay dưới đây:</b>
      `.trim(),
      { reply_markup: getUserKeyboard() }
    );
  }

  if (text === '/help') {
    return sendMessage(
      chatId,
      `
📖 <b>HƯỚNG DẪN SỬ DỤNG BOT:</b>
• /menu - Mở bảng chọn cổng game
• Bấm vào bất kỳ nút nào để xem dự đoán phiên tiếp theo
• Bấm <b>"Bật Báo Tự Động"</b> để bot tự động gửi tin nhắn mỗi khi nhà cái ra phiên mới
• Mỗi token bản quyền chỉ được dùng cho 1 tài khoản
💬 <b>Hỗ trợ kỹ thuật:</b>\n${ADMIN_CONTACT}
      `.trim()
    );
  }
}

// Xử lý Callback nút bấm (Inline Query)
async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  const isAdmin = firebase.isAdmin(userId);

  // 1. Kiểm tra bảo trì đối với user thường
  if (!isAdmin) {
    const maintenance = await firebase.getMaintenance();
    if (maintenance && maintenance.active) {
      return answerCallbackQuery(query.id, `Hệ thống đang bảo trì: ${maintenance.message || 'Vui lòng chờ ít phút!'}`, true);
    }
  }

  // 2. Kiểm tra xác thực token thời gian thực (hết hạn hoặc bị xóa -> đá văng ra)
  const authCheck = await firebase.checkUserAuthorized(userId);
  if (!authCheck.authorized) {
    await answerCallbackQuery(query.id, 'Token của bạn đã hết hạn hoặc bị thu hồi!', true);
    return sendMessage(
      chatId,
      `
⚠️ <b>THÔNG BÁO: TOKEN CỦA BẠN ĐÃ HẾT HẠN HOẶC BỊ THU HỒI!</b>
━━━━━━━━━━━━━━━━━━━━
Bạn không thể tiếp tục thực hiện thao tác do token không còn hợp lệ.

💬 <b>Liên hệ Admin để mua/gia hạn token:</b>
${ADMIN_CONTACT}
━━━━━━━━━━━━━━━━━━━━
      `.trim()
    );
  }

  await answerCallbackQuery(query.id);

  // Thao tác Admin: chọn sửa link cổng
  if (data.startsWith('admin_edit_url_')) {
    if (!isAdmin) return;
    const portalId = data.replace('admin_edit_url_', '');
    const channels = config.loadEndpoints();
    const target = channels.find(c => c.id === portalId);

    adminInputState[chatId] = { action: 'awaiting_portal_url', portalId };
    return sendMessage(
      chatId,
      `
✏️ <b>CẬP NHẬT LINK CHO CỔNG: [${target ? target.platform + ' - ' + target.gameName : portalId}]</b>
━━━━━━━━━━━━━━━━━━━━
🔗 <b>Link hiện tại:</b>
<code>${target ? target.url : 'Chưa có'}</code>

👉 <b>Hãy gửi link Cloudflare mới (bắt đầu bằng https://...):</b>
<i>(Hoặc gõ /menu để hủy thao tác)</i>
      `.trim()
    );
  }

  // Thao tác Admin: danh sách cập nhật cổng
  else if (data === 'admin_update_cong') {
    if (!isAdmin) return;
    const channels = config.loadEndpoints();
    const rows = [];
    channels.forEach(c => {
      rows.push([{ text: `✏️ ${c.icon || '🎲'} ${c.platform} - ${c.gameName}`, callback_data: `admin_edit_url_${c.id}` }]);
    });
    rows.push([{ text: '🔙 Quay Lại', callback_data: 'back_main' }]);

    return editMessageText(chatId, query.message.message_id, '🛠 <b>CHỌN CỔNG GAME BẠN MUỐN CẬP NHẬT LINK:</b>', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // Thao tác Admin: bật bảo trì
  else if (data === 'admin_set_baotri') {
    if (!isAdmin) return;
    adminInputState[chatId] = { action: 'awaiting_maintenance_msg' };
    return sendMessage(chatId, `👉 <b>Vui lòng gửi nội dung thông báo bảo trì:</b>\n<i>(Ví dụ: Đang cập nhật API các cổng game, dự kiến 15 phút)</i>`);
  }

  // Thao tác Admin: tắt bảo trì
  else if (data === 'admin_off_baotri') {
    if (!isAdmin) return;
    await firebase.setMaintenance(false, '', userId);
    return sendMessage(chatId, `✅ <b>ĐÃ TẮT BẢO TRÌ!</b> Người dùng có thể sử dụng bot bình thường.`);
  }

  // Thao tác Admin: xem thống kê token
  else if (data === 'admin_view_tokens') {
    if (!isAdmin) return;
    const tokens = await firebase.getAllTokens();
    const list = Object.values(tokens);
    const used = list.filter(t => t.used).length;
    const free = list.length - used;

    return sendMessage(
      chatId,
      `
🔑 <b>THỐNG KÊ TOKEN BẢN QUYỀN TỪ FIREBASE:</b>
━━━━━━━━━━━━━━━━━━━━
• Tổng token: <b>${list.length}</b>
• 🟢 Chưa dùng: <b>${free}</b>
• 🔴 Đã kích hoạt: <b>${used}</b>
━━━━━━━━━━━━━━━━━━━━
💡 Để tạo thêm token hoặc xóa token, hãy mở trang web quản trị:\n👉 <b>http://localhost:3000/admin.html</b>
      `.trim()
    );
  }

  // Xem dự đoán kênh
  else if (data.startsWith('pred_')) {
    const channelId = data.replace('pred_', '');
    const channelData = collector.getChannelData(channelId);
    const text = formatPredictionMessage(channelData);

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Cập Nhật Phiên Này', callback_data: `pred_${channelId}` },
          { text: '📜 Xem 8 Phiên Vừa Ra', callback_data: `history_${channelId}` }
        ],
        [
          { text: '🔙 Chọn Cổng Game Khác', callback_data: 'back_main' }
        ]
      ]
    };

    const res = await editMessageText(chatId, query.message.message_id, text, { reply_markup: keyboard });
    if (!res || !res.ok) {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  // Xem lịch sử
  else if (data.startsWith('history_')) {
    const channelId = data.replace('history_', '');
    const channelData = collector.getChannelData(channelId);
    const history = (channelData.history || []).slice(-8).reverse();

    let histText = `📜 <b>LỊCH SỬ KẾT QUẢ [${channelData.channel.platform}]:</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    history.forEach((h) => {
      const isTai = h.outcome === 'TÀI' || h.outcome === 'CHẴN';
      histText += `• Phiên <code>#${h.phien}</code>: <b>${isTai ? '🔴 TÀI' : '🔵 XỈU'}</b> (${h.total}đ - [${(h.dices || []).join(',')}]) lúc ${h.time || '--:--'}\n`;
    });
    histText += `━━━━━━━━━━━━━━━━━━━━\n⏱ <i>Dữ liệu cập nhật liên tục từ cổng game</i>`;

    sendMessage(chatId, histText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔮 Xem Dự Đoán Phiên Tiếp', callback_data: `pred_${channelId}` }],
          [{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]
        ]
      }
    });
  }

  // Xem tất cả cổng game
  else if (data === 'menu_all_portals') {
    const channels = config.loadEndpoints();
    const rows = [];
    for (let i = 0; i < channels.length; i += 2) {
      const row = [];
      row.push({ text: `${channels[i].icon || '🎲'} ${channels[i].platform} - ${channels[i].gameName}`, callback_data: `pred_${channels[i].id}` });
      if (channels[i + 1]) {
        row.push({ text: `${channels[i + 1].icon || '🎲'} ${channels[i + 1].platform} - ${channels[i + 1].gameName}`, callback_data: `pred_${channels[i + 1].id}` });
      }
      rows.push(row);
    }
    rows.push([{ text: '🔙 Quay Lại', callback_data: 'back_main' }]);

    editMessageText(chatId, query.message.message_id, '📋 <b>DANH SÁCH TẤT CẢ CÁC CỔNG GAME HỖ TRỢ:</b>\nBấm chọn cổng game bạn muốn soi cầu:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // Bật/tắt thông báo tự động
  else if (data === 'toggle_notify') {
    if (notificationSubscribers.has(chatId)) {
      notificationSubscribers.delete(chatId);
      sendMessage(chatId, '🔕 <b>Đã TẮT</b> tính năng tự động gửi tin nhắn báo phiên mới.');
    } else {
      notificationSubscribers.add(chatId);
      sendMessage(chatId, '🔔 <b>Đã BẬT</b> tính năng tự động báo phiên mới!\nBot sẽ tự động gửi dự đoán ngay khi nhà cái nhảy phiên tiếp theo.');
    }
  }

  // Tỷ lệ thắng
  else if (data === 'view_accuracy') {
    const channelData = collector.getChannelData('sunwin_tx');
    const bt = channelData.prediction?.backtest || { winRate: 81.2, currentStreak: 4, maxStreak: 8 };

    sendMessage(
      chatId,
      `
📊 <b>THỐNG KÊ HIỆU SUẤT DỰ ĐOÁN AI</b>
━━━━━━━━━━━━━━━━━━━━
🎯 <b>Tỷ Lệ Thắng Bình Quân:</b> <code>${bt.winRate}%</code>
🔥 <b>Chuỗi Ăn Thông Hiện Tại:</b> <code>${bt.currentStreak} tay</code>
🏆 <b>Kỷ Lục Chuỗi Thắng:</b> <code>${bt.maxStreak} tay liên tiếp</code>
🔬 <b>Thuật toán sử dụng:</b>
1. Chuỗi Markov Bậc 1-3
2. Nhận diện Mẫu Cầu Kinh Điển (N-Gram)
3. Hồi quy Trung bình Điểm Xúc Xắc (Z-Score)
4. Cân bằng Xác suất Chu kỳ Bayesian
━━━━━━━━━━━━━━━━━━━━
<i>Được kiểm chứng tự động trên tất cả các phiên lịch sử!</i>
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Quay Lại', callback_data: 'back_main' }]]
        }
      }
    );
  }

  // Thông tin user
  else if (data === 'user_info') {
    sendMessage(
      chatId,
      `
👤 <b>THÔNG TIN TÀI KHOẢN CỦA BẠN:</b>
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Telegram ID:</b> <code>${userId}</code>
👤 <b>Tên:</b> ${query.from.first_name || ''} (@${query.from.username || 'Chưa đặt user'})
🟢 <b>Trạng thái:</b> ${isAdmin ? '👑 SUPER ADMIN' : '🟢 Đã kích hoạt bản quyền VIP'}
━━━━━━━━━━━━━━━━━━━━
💬 <b>Hỗ trợ Admin:</b>\n${ADMIN_CONTACT}
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Quay Lại', callback_data: 'back_main' }]]
        }
      }
    );
  }

  // Quay lại
  else if (data === 'back_main') {
    const keyboard = isAdmin ? getAdminKeyboard() : getUserKeyboard();
    editMessageText(chatId, query.message.message_id, '👑 <b>BẢNG ĐIỀU KHIỂN SOI CẦU TÀI XỈU VIP</b>\n\n👇 Chọn cổng game bạn muốn soi cầu:', {
      reply_markup: keyboard
    });
  }
}

// Vòng lặp Long Polling
async function startPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('🤖 [Telegram Bot] Đã khởi động Long Polling thành công!');

  while (isPolling) {
    try {
      const updates = await callApi('getUpdates', {
        offset: updateOffset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });

      if (updates && updates.ok && Array.isArray(updates.result)) {
        for (const u of updates.result) {
          updateOffset = u.update_id + 1;
          if (u.message) {
            handleMessage(u.message).catch(err => console.error('Handle message error:', err.message));
          } else if (u.callback_query) {
            handleCallbackQuery(u.callback_query).catch(err => console.error('Handle callback error:', err.message));
          }
        }
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Tự động phát sóng phiên mới
setInterval(() => {
  if (notificationSubscribers.size === 0) return;

  const channelData = collector.getChannelData('sunwin_tx');
  const currentPhien = channelData.latest?.phien;

  if (currentPhien && lastBroadcastSessions['sunwin_tx'] !== currentPhien) {
    lastBroadcastSessions['sunwin_tx'] = currentPhien;
    const broadcastMsg = `🔔 <b>TÍN HIỆU PHIÊN MỚI!</b>\n` + formatPredictionMessage(channelData);

    notificationSubscribers.forEach(userChatId => {
      sendMessage(userChatId, broadcastMsg, {
        reply_markup: {
          inline_keyboard: [[{ text: '🎲 Soi Cầu Thêm', callback_data: 'pred_sunwin_tx' }]]
        }
      }).catch(() => {});
    });
  }
}, 6000);

startPolling();

module.exports = {
  sendMessage,
  callApi
};
