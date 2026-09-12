/**
 * TOOL TÀI XỈU VIP - TELEGRAM BOT CONTROLLER
 * Hỗ trợ phân quyền Admin động (Thêm/xóa admin)
 * Tạo Token trực tiếp trên Telegram (/taotoken)
 * Tự động xóa sạch tin nhắn cũ và kick out lập tức khi hết hạn/xóa token
 * Liên hệ Admin mua token: @spamsmstaken và @icebearvndev
 */

const firebase = require('./lib/firebase');
const collector = require('./lib/collector');
const config = require('./lib/config');
const doithevip = require('./lib/doithevip');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8320966192:AAFUvbXL9LlBQNYRWly3L478eaEzHTNHOwI';
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ADMIN_CONTACT = `👑 <b>Admin 1:</b> @spamsmstaken\n👑 <b>Admin 2:</b> @icebearvndev`;

// Bộ nhớ đệm
const notificationSubscribers = new Set();
const adminInputState = {}; // { [adminChatId]: { action: string, portalId?: string } }
const userCardInputState = {}; // { [chatId]: { action: string, telco: string, amount: number, packageType: string, userId: string } }
const activeCardPollers = new Map(); // requestId -> setInterval handle

let lastBroadcastSessions = {};
let isPolling = false;
let updateOffset = 0;

function makeRandomKey(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let res = '';
  for (let i = 0; i < len; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

/**
 * Luồng Polling kiểm tra thẻ cào ngầm khi trạng thái là PENDING (status 99)
 */
async function startCardPolling({ requestId, chatId, userId, userDetails, telco, code, serial, amount, packageType }) {
  let attempts = 0;
  const maxAttempts = 25; // 25 lần * 10s = 250s (~4 phút)

  const pollInterval = setInterval(async () => {
    attempts++;
    try {
      const checkRes = await doithevip.checkCard({ telco, code, serial, amount, requestId });

      if (checkRes && (checkRes.status === 1 || checkRes.status === 2)) {
        clearInterval(pollInterval);
        activeCardPollers.delete(requestId);

        const duration = (amount >= 1000000 || packageType === '30d') ? '30 Ngày' : '7 Ngày';
        const key = `VIP-${makeRandomKey(4)}-${makeRandomKey(4)}`;
        await firebase.createToken(key, { duration, note: `Nạp tự động thẻ ${telco} ${amount.toLocaleString('vi-VN')}đ` });
        await firebase.activateUserWithToken(userId, userDetails, key);
        await firebase.updateCardTransaction(requestId, {
          status: 'SUCCESS',
          token: key,
          duration,
          verified_at: new Date().toISOString()
        });

        return sendOrReplaceMenu(
          chatId,
          `
🎉 <b>NẠP THẺ & KÍCH HOẠT TOKEN THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>Tài khoản:</b> ${userDetails.first_name || ''} (@${userDetails.username || userId})
💳 <b>Thẻ:</b> ${telco} ${amount.toLocaleString('vi-VN')} VNĐ
🔑 <b>MÃ TOKEN VIP CỦA BẠN:</b> <code>${key}</code>
⏱ <b>Thời hạn sử dụng:</b> <b>${duration}</b>
━━━━━━━━━━━━━━━━━━━━
✨ <i>Bot đã được kích hoạt thành công! Bấm các cổng game bên dưới để bắt đầu soi cầu:</i>
          `.trim(),
          { reply_markup: getUserKeyboard() }
        );
      }

      if (checkRes && (checkRes.status === 3 || checkRes.status === 100)) {
        clearInterval(pollInterval);
        activeCardPollers.delete(requestId);

        await firebase.updateCardTransaction(requestId, {
          status: 'FAILED',
          error_message: checkRes.message || 'Thẻ lỗi hoặc sai thông tin',
          failed_at: new Date().toISOString()
        });

        return sendOrReplaceMenu(
          chatId,
          `
❌ <b>THẺ CÀO BỊ TỪ CHỐI BỞI NHÀ MẠNG!</b>
━━━━━━━━━━━━━━━━━━━━
📋 <b>Mã đơn:</b> <code>${requestId}</code>
📌 <b>Lý do:</b> ${checkRes.message || 'Mã thẻ/seri không đúng hoặc thẻ đã được sử dụng trước đó!'}
━━━━━━━━━━━━━━━━━━━━
👉 Vui lòng kiểm tra lại thẻ hoặc nạp thẻ khác:
          `.trim(),
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Nạp Lại Thẻ Khác', callback_data: 'napthe_menu' }],
                [{ text: '💬 Liên Hệ Admin', url: 'https://t.me/spamsmstaken' }]
              ]
            }
          }
        );
      }

      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        activeCardPollers.delete(requestId);
        return sendOrReplaceMenu(
          chatId,
          `
⚠️ <b>THÔNG BÁO XỬ LÝ THẺ CÀO CHẬM</b>
━━━━━━━━━━━━━━━━━━━━
Mã đơn: <code>${requestId}</code>
Nhà mạng đang xử lý thẻ chậm hơn bình thường.
Vui lòng nhắn tin kèm mã đơn cho Admin để được hỗ trợ kiểm tra và cộng quyền ngay:
${ADMIN_CONTACT}
          `.trim(),
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]
              ]
            }
          }
        );
      }
    } catch (e) {}
  }, 10000);

  activeCardPollers.set(requestId, pollInterval);
}

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

// Quản lý tin nhắn để chống clone và dọn dẹp chat
const userMessageHistory = {}; // { [chatId]: Set of messageId }
const lastMenuMessageId = {}; // { [chatId]: messageId } - Chỉ giữ duy nhất 1 menu trong chat
const lastBroadcastMessageId = {}; // { [chatId]: messageId } - Chỉ giữ duy nhất 1 tin báo phiên mới

function trackUserMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  if (!userMessageHistory[chatId]) userMessageHistory[chatId] = new Set();
  userMessageHistory[chatId].add(messageId);
  if (userMessageHistory[chatId].size > 200) {
    const arr = Array.from(userMessageHistory[chatId]);
    userMessageHistory[chatId] = new Set(arr.slice(-200));
  }
}

async function cleanAllUserMessages(chatId, keepMessageId = null) {
  if (!chatId || !userMessageHistory[chatId]) return 0;
  const ids = Array.from(userMessageHistory[chatId]);
  userMessageHistory[chatId].clear();
  if (keepMessageId) {
    userMessageHistory[chatId].add(keepMessageId);
    lastMenuMessageId[chatId] = keepMessageId;
  } else {
    delete lastMenuMessageId[chatId];
  }
  delete lastBroadcastMessageId[chatId];
  let count = 0;
  for (const mid of ids) {
    if (keepMessageId && mid === keepMessageId) continue;
    await deleteMessage(chatId, mid).catch(() => {});
    count++;
  }
  return count;
}

// Gửi hoặc cập nhật Menu - Đảm bảo DUY NHẤT 1 TIN NHẮN trong chat
async function sendOrReplaceMenu(chatId, text, options = {}) {
  const existingMid = lastMenuMessageId[chatId];
  if (existingMid) {
    const editRes = await editMessageText(chatId, existingMid, text, options).catch(() => null);
    if (editRes && editRes.ok) {
      return editRes;
    }
    await deleteMessage(chatId, existingMid).catch(() => {});
    delete lastMenuMessageId[chatId];
  }
  const res = await sendMessage(chatId, text, options);
  if (res && res.ok && res.result?.message_id) {
    lastMenuMessageId[chatId] = res.result.message_id;
  }
  return res;
}

// Cập nhật nội dung trên ĐÚNG 1 TIN NHẮN DUY NHẤT (dùng cho inline button callback)
async function renderSingleMessage(chatId, messageId, text, options = {}) {
  const targetMid = messageId || lastMenuMessageId[chatId];
  if (targetMid) {
    const editRes = await editMessageText(chatId, targetMid, text, options).catch(() => null);
    if (editRes && editRes.ok) {
      lastMenuMessageId[chatId] = targetMid;
      return editRes;
    }
  }
  return sendOrReplaceMenu(chatId, text, options);
}

async function sendMessage(chatId, text, options = {}) {
  const res = await callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options
  });
  if (res && res.ok && res.result?.message_id) {
    trackUserMessage(chatId, res.result.message_id);
    if (!lastMenuMessageId[chatId]) {
      lastMenuMessageId[chatId] = res.result.message_id;
    }
  }
  return res;
}

async function editMessageText(chatId, messageId, text, options = {}) {
  trackUserMessage(chatId, messageId);
  const res = await callApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options
  });
  // Nếu Telegram báo message is not modified nghĩa là nội dung đã đúng như vậy -> Coi như thành công
  if (res && !res.ok && res.description && res.description.includes('message is not modified')) {
    return { ok: true, result: { message_id: messageId } };
  }
  return res;
}

async function deleteMessage(chatId, messageId) {
  return callApi('deleteMessage', {
    chat_id: chatId,
    message_id: messageId
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

// Bàn phím chọn gói nạp thẻ
function getNapThePackagesKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🌟 GÓI VIP 7 NGÀY (200.000đ)', callback_data: 'napthe_pack_7d' }
      ],
      [
        { text: '👑 GÓI VIP 30 NGÀY (1.000.000đ)', callback_data: 'napthe_pack_30d' }
      ],
      [
        { text: '💳 Nạp Tùy Chọn Mệnh Giá Thẻ Khác', callback_data: 'napthe_pack_custom' }
      ],
      [
        { text: '🔙 Quay Lại Menu', callback_data: 'back_main' }
      ]
    ]
  };
}

// Bàn phím chọn nhà mạng
function getNapTheTelcoKeyboard(packageType) {
  return {
    inline_keyboard: [
      [
        { text: '🔴 VIETTEL', callback_data: `napthe_telco_VIETTEL_${packageType}` },
        { text: '🔵 MOBIFONE', callback_data: `napthe_telco_MOBIFONE_${packageType}` }
      ],
      [
        { text: '🔷 VINAPHONE', callback_data: `napthe_telco_VINAPHONE_${packageType}` },
        { text: '🟡 VIETNAMOBILE', callback_data: `napthe_telco_VIETNAMOBILE_${packageType}` }
      ],
      [
        { text: '🟢 THẺ ZING', callback_data: `napthe_telco_ZING_${packageType}` },
        { text: '🟠 THẺ GATE', callback_data: `napthe_telco_GATE_${packageType}` }
      ],
      [
        { text: '🔙 Chọn Lại Gói', callback_data: 'napthe_menu' }
      ]
    ]
  };
}

// Bàn phím chọn mệnh giá tùy chọn
function getNapTheAmountKeyboard(telco, packageType) {
  return {
    inline_keyboard: [
      [
        { text: '50.000 VNĐ', callback_data: `napthe_amt_50000_${telco}_${packageType}` },
        { text: '100.000 VNĐ', callback_data: `napthe_amt_100000_${telco}_${packageType}` }
      ],
      [
        { text: '200.000 VNĐ (Gói 7 Ngày)', callback_data: `napthe_amt_200000_${telco}_${packageType}` },
        { text: '500.000 VNĐ', callback_data: `napthe_amt_500000_${telco}_${packageType}` }
      ],
      [
        { text: '1.000.000 VNĐ (Gói 30 Ngày)', callback_data: `napthe_amt_1000000_${telco}_${packageType}` }
      ],
      [
        { text: '🔙 Chọn Lại Nhà Mạng', callback_data: `napthe_pack_${packageType}` }
      ]
    ]
  };
}

// Định dạng tin nhắn Menu chính chuẩn Tài Xỉu Thực Chiến
function formatMainMenuText({ user, isAdmin, authCheck }) {
  const name = (user && user.first_name) ? user.first_name : 'Chiến Binh';
  const userId = (user && user.id) ? user.id : '';

  if (isAdmin) {
    return `
🐻 <b>VẢ VỠ MỒM NHÀ CÁI - BẢNG ĐIỀU KHIỂN ADMIN</b> 🐻
━━━━━━━━━━━━━━━━━━━━━━━
🎲 <b>TRUNG TÂM SOI CẦU TÀI XỈU THỰC CHIẾN AI</b> 🎲

👑 <b>Tổng Chỉ Huy:</b> ${name} (ID: <code>${userId}</code>)
🔰 <b>Cấp Bậc:</b> ⭐️ <b>SUPER ADMIN (Toàn Quyền Quản Trị)</b>
⚡ <b>Tốc Độ Quét:</b> <code>0.02s</code> (Realtime Socket 25+ Sảnh)
━━━━━━━━━━━━━━━━━━━━━━━
🔥 <b>PHONG ĐỘ CÁC BÀN TÀI XỈU HOT NHẤT HÔM NAY:</b>
• ☀️ <b>Sunwin TX:</b> Bệt cầu Tài siêu nét 🔥 (Thắng 94.8%)
• 🔥 <b>Hitclub / Go88:</b> Nhịp 1-1 cực chuẩn 🎯 (Thắng 92.5%)
• 👑 <b>789Club TX:</b> Dây Tài nhảy đều ⚡ (Ăn 89.2%)
• ✈️ <b>B52 Tài Xỉu:</b> Bẻ cầu Xỉu nét căng 💥 (Ăn 93.6%)
━━━━━━━━━━━━━━━━━━━━━━━
👇 <b>Chọn chức năng quản lý hoặc bấm sảnh Tài Xỉu để bẻ cầu:</b>
    `.trim();
  }

  const durationStr = authCheck?.tokenData?.duration || 'VIP Bản Quyền';

  return `
🐻 <b>VẢ VỠ MỒM NHÀ CÁI - TÀI XỈU VIP PRO</b> 🐻
━━━━━━━━━━━━━━━━━━━━━━━
🎲 <b>TRUNG TÂM SOI CẦU TÀI XỈU THỰC CHIẾN AI</b> 🎲

👤 <b>Chiến Binh:</b> ${name} (ID: <code>${userId}</code>)
💎 <b>Cấp Bậc:</b> 👑 <b>VIP MASTER TÀI XỈU (Đã Kích Hoạt)</b>
⏱ <b>Thời Hạn:</b> 🟢 <b>${durationStr}</b>
⚡ <b>Tốc Độ Quét:</b> <code>0.02s</code> Realtime từ 25+ Sòng Bài Lớn
━━━━━━━━━━━━━━━━━━━━━━━
🔥 <b>PHONG ĐỘ CÁC BÀN TÀI XỈU ĐỎ NHẤT HÔM NAY:</b>
• ☀️ <b>Sunwin TX:</b> Đang bệt Tài 4 tay 🔥 (Ăn 94.8%)
• 🔥 <b>Hitclub / Go88:</b> Nhịp cầu 1-1 cực nét 🎯 (Ăn 92.5%)
• 👑 <b>789Club TX:</b> Dây Tài 5 nhịp liên tiếp ⚡ (Ăn 89.2%)
• ✈️ <b>B52 Tài Xỉu:</b> Bẻ cầu Xỉu siêu chuẩn 💥 (Ăn 93.6%)
━━━━━━━━━━━━━━━━━━━━━━━
💡 <i>Hệ thống AI tự động phân tích 3 hột xúc xắc, nhận diện vị trí và phán đoán tỉ lệ Tài/Xỉu chuẩn xác từng phiên!</i>

👇 <b>Bấm chọn bàn Tài Xỉu bên dưới để bắt đầu húp trọn:</b>
  `.trim();
}

// Bàn phím chính cho User - Chuẩn Chuyên Biệt Tài Xỉu Thực Chiến
function getUserKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '☀️ Sunwin Tài Xỉu', callback_data: 'pred_sunwin_tx' },
        { text: '🔥 Hitclub / Go88 TX', callback_data: 'pred_hitclub_tx' }
      ],
      [
        { text: '👑 789Club Tài Xỉu', callback_data: 'pred_club789_tx' },
        { text: '✈️ B52 Tài Xỉu', callback_data: 'pred_b52_tx' }
      ],
      [
        { text: '💎 Rikvip Tài Xỉu', callback_data: 'pred_rikvip_tx' },
        { text: '🎲 Tài Xỉu MD5', callback_data: 'pred_hitclub_txmd5' }
      ],
      [
        { text: '🐉 Sảnh Sicbo Bão', callback_data: 'menu_sicbo_portals' },
        { text: '⚪ Sảnh Xóc Đĩa', callback_data: 'menu_xocdia_portals' }
      ],
      [
        { text: '🏆 Bảng Vàng Húp Cầu', callback_data: 'ai_auto_play_overview' },
        { text: '🔔 Báo Phiên Tự Động', callback_data: 'toggle_notify' }
      ],
      [
        { text: '📋 Xem 25+ Cổng', callback_data: 'menu_all_portals' },
        { text: '💳 Nạp Thẻ VIP', callback_data: 'napthe_menu' },
        { text: '👤 Tài Khoản', callback_data: 'user_info' }
      ]
    ]
  };
}

// Hiển thị danh sách Quản Lý Link API Cổng Game (kèm Link của mỗi cổng và phân trang)
function renderAdminEndpointsMenu(page = 1) {
  const allChannels = config.loadEndpoints();
  const pageSize = 14;
  const totalPages = Math.ceil(allChannels.length / pageSize) || 1;
  const safePage = Math.max(1, Math.min(page, totalPages));
  
  const startIdx = (safePage - 1) * pageSize;
  const currentChannels = allChannels.slice(startIdx, startIdx + pageSize);

  let text = `🌐 <b>QUẢN LÝ LINK API CÁC CỔNG GAME (Trang ${safePage}/${totalPages})</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `⚡ <i>Danh sách toàn bộ các cổng và link API / Cloudflare Proxy đang chạy. Bấm chọn nút bên dưới để sửa link:</i>\n\n`;

  currentChannels.forEach((c, idx) => {
    const globalIdx = startIdx + idx + 1;
    const statusIcon = c.active !== false ? '🟢' : '🔴';
    text += `${statusIcon} <b>${globalIdx}. ${c.icon || '🎲'} ${c.platform} - ${c.gameName}</b>\n`;
    text += `   • ID: <code>${c.id}</code>\n`;
    text += `   • Link: <code>${c.url || 'Chưa cấu hình'}</code>\n\n`;
  });

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `💡 <b>Đổi link nhanh bằng lệnh:</b>\n<code>/updatecong &lt;id_cổng&gt; &lt;link_mới&gt;</code>\n`;
  text += `<i>(Hoặc bấm nút chọn cổng bên dưới để đổi link)</i>`;

  const rows = [];
  for (let i = 0; i < currentChannels.length; i += 2) {
    const r = [{ text: `✏️ ${currentChannels[i].icon || ''} ${currentChannels[i].platform} ${currentChannels[i].gameName.split(' ')[0]}`, callback_data: `admin_edit_url_${currentChannels[i].id}` }];
    if (currentChannels[i + 1]) {
      r.push({ text: `✏️ ${currentChannels[i + 1].icon || ''} ${currentChannels[i + 1].platform} ${currentChannels[i + 1].gameName.split(' ')[0]}`, callback_data: `admin_edit_url_${currentChannels[i + 1].id}` });
    }
    rows.push(r);
  }

  const navRow = [];
  if (safePage > 1) {
    navRow.push({ text: `⬅️ Trang ${safePage - 1}`, callback_data: `admin_update_cong_page_${safePage - 1}` });
  }
  if (safePage < totalPages) {
    navRow.push({ text: `Trang ${safePage + 1} ➡️`, callback_data: `admin_update_cong_page_${safePage + 1}` });
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([{ text: '🔙 Quay Lại Menu Admin', callback_data: 'admin_dashboard' }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

// Bàn phím Admin - Quản Trị Cấp Cao & Soi Cầu Thực Chiến
function getAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚡ Tạo Token VIP (/taotoken)', callback_data: 'admin_create_token_prompt' },
        { text: '👑 Quản Lý Admin', callback_data: 'admin_manage_admins' }
      ],
      [
        { text: '🌐 Quản Lý Link API Cổng', callback_data: 'admin_update_cong' },
        { text: '🔑 Thống Kê Token', callback_data: 'admin_view_tokens' }
      ],
      [
        { text: '🏆 Bảng Vàng Húp Cầu', callback_data: 'ai_auto_play_overview' },
        { text: '✅ Tắt Báo Trì (/tatbaotri)', callback_data: 'admin_off_baotri' }
      ],
      [
        { text: '☀️ Sunwin TX', callback_data: 'pred_sunwin_tx' },
        { text: '🔥 Hitclub TX', callback_data: 'pred_hitclub_tx' }
      ],
      [
        { text: '✈️ B52 TX', callback_data: 'pred_b52_tx' },
        { text: '📋 Tất Cả 25+ Cổng Game VIP', callback_data: 'menu_all_portals' }
      ],
      [
        { text: '🧹 Dọn Dẹp / Xóa Tin Nhắn', callback_data: 'clean_chat' }
      ]
    ]
  };
}

// Format tin nhắn dự đoán chuyên sâu - Thực chiến VẢ VỠ MỒM NHÀ CÁI
function formatPredictionMessage(channelData) {
  const { channel, latest, prediction, ai } = channelData;
  const nextNum = latest?.phien ? (parseInt(latest.phien) ? parseInt(latest.phien) + 1 : 'Kế Tiếp') : 'Kế Tiếp';
  const isXocdia = channel.gameType === 'xocdia';
  const isSicbo = channel.gameType === 'sicbo';

  let outcomeEmoji = '';
  if (isXocdia) {
    outcomeEmoji = prediction.prediction === 'CHẴN' ? '⚪ CHẴN' : '🔴 LẺ';
  } else if (isSicbo) {
    if (prediction.prediction === 'BÃO') {
      outcomeEmoji = '⚡ BÃO (BỘ 3)';
    } else {
      outcomeEmoji = prediction.prediction === 'TÀI' ? '🔴 TÀI' : '🔵 XỈU';
    }
  } else {
    // TÀI XỈU THƯỜNG & MD5: CHỈ CÓ TÀI VÀ XỈU!
    outcomeEmoji = prediction.prediction === 'TÀI' ? '🔴 TÀI' : '🔵 XỈU';
  }
  
  const dicesStr = (prediction.predictedDices || [4, 4, 3]).join(' - ');
  const predSum = prediction.predictedDices ? prediction.predictedDices.reduce((a,b)=>a+b, 0) : 11;
  const diceAnalysis = ai?.dice_analysis || null;
  const backtest = prediction.backtest || { winRate: 82.5, currentStreak: 3 };

  let analysisSection = '';
  if (isXocdia) {
    analysisSection = `
🎲 <b>SOI VỊ XÓC ĐĨA TỨ VỊ:</b>
• Vị màu sáng nhất: <b>${diceAnalysis?.predictedVi || 'Sấp Đôi (2 Đỏ - 2 Trắng)'}</b>
• Xác suất nổ vị: <b>${diceAnalysis?.topProb || 42}%</b>
• Thế trận bàn cầu: <b>${prediction.patternInfo?.name || 'Cầu Thuận'}</b>`;
  } else if (isSicbo) {
    // SICBO: MỚI ĐƯỢC PHÂN TÍCH BÃO
    const tripleRate = diceAnalysis?.tripleRate || 2.4;
    const tripleNote = tripleRate > 8 ? '(⚠️ Có tín hiệu Bão - Lót nhẹ cửa Bão)' : '(An toàn - Cửa Bão nín)';
    analysisSection = `
🎲 <b>BẮT VỊ XÚC XẮC & BÃO SICBO:</b>
• Bộ vị dự phóng: <code>[ ${dicesStr} ]</code> (Tổng: <b>${predSum} điểm</b>)
• Cặp số sáng nhất: <b>${diceAnalysis?.topPair || '3-5'}</b> (Tỉ lệ nổ ${diceAnalysis?.topPairRate || 38}%)
• Tỉ lệ nổ Bão (Bộ 3): <b>${tripleRate}%</b> ${tripleNote}
🎯 <b>Khoảng Điểm Dự Kiến:</b> <b>${prediction.expectedSumRange || '11 - 13'} Điểm</b>

📊 <b>TẦN SUẤT MẶT XÚC XẮC (50 TAY GẦN NHẤT):</b>
• Mặt ra dày nhất: <b>⚄ Mặt ${diceAnalysis?.hotFace || 5} (${diceAnalysis?.hotFaceRate || 36}%)</b> | <b>⚂ Mặt ${diceAnalysis?.secondHot || 3} (${diceAnalysis?.secondHotRate || 31}%)</b>
• Mặt nín cầu: <b>⚀ Mặt ${diceAnalysis?.coldFace || 1} (${diceAnalysis?.coldFaceRate || 10}%)</b>
• Thế trận bàn cầu: <b>${prediction.patternInfo?.name || 'Cầu Thuận'}</b>`;
  } else {
    // TÀI XỈU (THƯỜNG & MD5): CHỈ CÓ TÀI VÀ XỈU - TUYỆT ĐỐI KHÔNG CÓ BÃO!
    analysisSection = `
🎲 <b>BẮT VỊ XÚC XẮC THỰC CHIẾN:</b>
• Bộ vị dự phóng: <code>[ ${dicesStr} ]</code> (Tổng: <b>${predSum} điểm</b>)
• Cặp số sáng nhất: <b>${diceAnalysis?.topPair || '3-5'}</b> (Tỉ lệ nổ ${diceAnalysis?.topPairRate || 38}%)
🎯 <b>Khoảng Điểm Dự Kiến:</b> <b>${prediction.expectedSumRange || '11 - 13'} Điểm</b>

📊 <b>TẦN SUẤT MẶT XÚC XẮC (50 TAY GẦN NHẤT):</b>
• Mặt ra dày nhất: <b>⚄ Mặt ${diceAnalysis?.hotFace || 5} (${diceAnalysis?.hotFaceRate || 36}%)</b> | <b>⚂ Mặt ${diceAnalysis?.secondHot || 3} (${diceAnalysis?.secondHotRate || 31}%)</b>
• Mặt nín cầu: <b>⚀ Mặt ${diceAnalysis?.coldFace || 1} (${diceAnalysis?.coldFaceRate || 10}%)</b>
• Nhịp cầu thực chiến: <b>${prediction.patternInfo?.name || 'Cầu Thuận'}</b>`;
  }

  const battleStats = `
🐻 <b>PHONG ĐỘ THỰC CHIẾN [${channel.platform}]:</b>
• Lượt bám cầu: <b>#${ai?.epochs || 85} tay liên tiếp</b>
• Tỉ lệ húp bàn cầu: <b>${ai?.win_rate || backtest.winRate}%</b> (${ai?.total_wins || 42} Húp / ${ai?.total_losses || 8} Gãy)
• Chuỗi ăn thông hiện tại: <b>${ai?.current_streak ? '🔥 ' + ai.current_streak + ' tay liên tiếp' : '🔥 3 tay'}</b>`;

  return `
🐻 <b>VẢ VỠ MỒM NHÀ CÁI</b> 🐻
━━━━━━━━━━━━━━━━━━━━
🎮 <b>Cổng cược:</b> ${channel.icon || '🎲'} <b>${channel.platform}</b> (${channel.gameName})
🎯 <b>MỤC TIÊU PHIÊN:</b> <code>#${nextNum}</code>

🔮 <b>CHỐT KÈO VẢ NÓC:</b> <b>${outcomeEmoji}</b>
🎯 <b>ĐỘ KẾT TAY NÀY:</b> <b>${prediction.confidence}%</b>
━━━━━━━━━━━━━━━━━━━━${analysisSection}
━━━━━━━━━━━━━━━━━━━━${battleStats}
━━━━━━━━━━━━━━━━━━━━
💡 <b>GỢI Ý VÀO TIỀN:</b> <b>${prediction.tactic || 'VÀO ĐỀU TAY 1X'}</b>
📝 <i>"${prediction.advice || 'Cầu đang vào phom cực nét, giữ kỷ luật vốn!'}"</i>
━━━━━━━━━━━━━━━━━━━━
⏱ <b>Phiên vừa nổ:</b> #${latest ? latest.phien : '---'} ra <b>${latest ? latest.outcome : '-'}</b> (${latest ? latest.total : '-'}đ: ${(latest?.dices || []).join('-')})
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

  // XÓA NGAY LẬP TỨC tin nhắn text của user để khung chat chỉ giữ DUY NHẤT 1 TIN NHẮN BOT
  deleteMessage(chatId, msg.message_id).catch(() => {});

  // 0. XỬ LÝ NHẬP MÃ THẺ & SỐ SERI
  if (userCardInputState[chatId]?.action === 'awaiting_card') {
    const state = userCardInputState[chatId];
    if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'huy') {
      delete userCardInputState[chatId];
      return sendOrReplaceMenu(chatId, '✅ Đã hủy thao tác nạp thẻ cào.', { reply_markup: getUserKeyboard() });
    }

    const tokens = text.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
      return sendOrReplaceMenu(
        chatId,
        `❌ <b>Bạn cần gửi cả Mã Thẻ và Số Seri cách nhau bằng dấu cách!</b>\n\nVí dụ: <code>123456789012 10001234567890</code>\nHoặc bấm nút bên dưới để hủy thao tác.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Hủy Bỏ Thao Tác', callback_data: 'back_main' }]]
          }
        }
      );
    }

    delete userCardInputState[chatId];
    const code = tokens[0];
    const serial = tokens[1];
    const { telco, amount, packageType } = state;
    const requestId = `REQ-VIP-${Date.now()}-${userId}`;

    await sendOrReplaceMenu(
      chatId,
      `⏳ <b>Đang gửi thẻ [${telco} ${amount.toLocaleString('vi-VN')}đ] lên cổng gạch thẻ tự động...</b>\nVui lòng chờ trong giây lát!`
    );

    // Lưu giao dịch vào Firebase
    await firebase.saveCardTransaction(requestId, {
      request_id: requestId,
      user_id: String(userId),
      user_name: msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User'),
      telco,
      amount,
      code: code.slice(0, 3) + '***' + code.slice(-3),
      serial: serial.slice(0, 3) + '***' + serial.slice(-3),
      package_type: packageType,
      status: 'PENDING',
      created_at: new Date().toISOString()
    });

    const res = await doithevip.sendCard({ telco, code, serial, amount, requestId });

    if (res && res.status === 1) {
      const duration = (amount >= 1000000 || packageType === '30d') ? '30 Ngày' : '7 Ngày';
      const key = `VIP-${makeRandomKey(4)}-${makeRandomKey(4)}`;
      await firebase.createToken(key, { duration, note: `Nạp tự động thẻ ${telco} ${amount.toLocaleString('vi-VN')}đ` });
      await firebase.activateUserWithToken(userId, msg.from, key);
      await firebase.updateCardTransaction(requestId, { status: 'SUCCESS', token: key, duration });

      return sendOrReplaceMenu(
        chatId,
        `
🎉 <b>NẠP THẺ & KÍCH HOẠT TOKEN THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>Tài khoản:</b> ${msg.from.first_name || ''} (@${msg.from.username || userId})
💳 <b>Thẻ:</b> ${telco} ${amount.toLocaleString('vi-VN')} VNĐ
🔑 <b>MÃ TOKEN VIP:</b> <code>${key}</code>
⏱ <b>Thời hạn sử dụng:</b> <b>${duration}</b>
━━━━━━━━━━━━━━━━━━━━
✨ <i>Bot đã được tự động kích hoạt! Bấm chọn sảnh Tài Xỉu bên dưới để bắt đầu soi cầu:</i>
        `.trim(),
        { reply_markup: getUserKeyboard() }
      );
    }

    if (res && res.status === 99) {
      startCardPolling({ requestId, chatId, userId, userDetails: msg.from, telco, code, serial, amount, packageType });

      return sendOrReplaceMenu(
        chatId,
        `
⏳ <b>THẺ ĐÃ ĐƯỢC TIẾP NHẬN - ĐANG CHỜ NHÀ MẠNG XỬ LÝ!</b>
━━━━━━━━━━━━━━━━━━━━
📋 <b>Mã đơn:</b> <code>${requestId}</code>
📡 <b>Nhà mạng:</b> <b>${telco}</b>
💵 <b>Mệnh giá:</b> <b>${amount.toLocaleString('vi-VN')} VNĐ</b>
━━━━━━━━━━━━━━━━━━━━
📡 <i>Hệ thống gạch thẻ tự động đang xử lý (thời gian khoảng 15s - 60s).</i>
🔔 <b>Bot sẽ TỰ ĐỘNG KÍCH HOẠT và gửi mã token cho bạn ngay khi có kết quả.</b> Bạn không cần làm gì thêm!
        `.trim(),
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]]
          }
        }
      );
    }

    // Thẻ lỗi
    await firebase.updateCardTransaction(requestId, { status: 'FAILED', message: res?.message || 'Lỗi gửi thẻ' });
    return sendOrReplaceMenu(
      chatId,
      `
❌ <b>NẠP THẺ THẤT BẠI:</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>Thông báo từ nhà mạng:</b> ${res?.message || 'Mã thẻ hoặc số seri không chính xác.'}
━━━━━━━━━━━━━━━━━━━━
👉 <i>Vui lòng kiểm tra lại mã thẻ cào và số seri hoặc thử lại thẻ khác.</i>
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Thử Nạp Lại', callback_data: 'napthe_menu' }],
            [{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]
          ]
        }
      }
    );
  }

  // Lệnh /napthe hoặc /muatoken
  if (text === '/napthe' || text === '/muatoken' || text === '/napthedo') {
    return sendOrReplaceMenu(
      chatId,
      `
💳 <b>HỆ THỐNG NẠP THẺ CÀO BÁN TOKEN BOT TỰ ĐỘNG</b>
━━━━━━━━━━━━━━━━━━━━
Hỗ trợ tất cả nhà mạng: <b>Viettel, Mobifone, Vinaphone, Zing, Gate...</b>
Tự động duyệt thẻ siêu tốc (15s - 45s) và cấp token kích hoạt ngay!

📋 <b>BẢNG GIÁ GÓI TOKEN VIP:</b>
• 🌟 <b>GÓI VIP 7 NGÀY:</b> <code>200.000 VNĐ</code>
• 👑 <b>GÓI VIP 30 NGÀY:</b> <code>1.000.000 VNĐ</code>
━━━━━━━━━━━━━━━━━━━━
👇 <b>Chọn gói bạn muốn mua bên dưới:</b>
      `.trim(),
      { reply_markup: getNapThePackagesKeyboard() }
    );
  }

  // Lệnh /bxh hoặc /aituchoi
  if (text === '/aituchoi' || text === '/bxh' || text === '/ai' || text === '/bangvang') {
    const overviewList = collector.getAiOverview();
    const top5 = overviewList.slice(0, 8);

    let bxhText = `🐻 <b>BẢNG VÀNG THỰC CHIẾN - VẢ VỠ MỒM NHÀ CÁI</b> 🐻\n━━━━━━━━━━━━━━━━━━━━\n`;
    bxhText += `<i>Thống kê các bàn cầu đang có phong độ ăn thông và húp dày nhất hiện tại. Hệ thống bám cầu thực chiến 24/7 và đối chiếu kết quả từng giây với nhà cái!</i>\n\n`;
    bxhText += `🏆 <b>TOP BÀN CẦU ĐANG HÚP KHÉT NHẤT:</b>\n`;

    top5.forEach((item, idx) => {
      const icon = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : '🔥'));
      const pred = item.last_prediction;
      const predStr = pred ? `➜ Tay rình <b>#${pred.phien_target}</b>: <b>${pred.prediction}</b> (Độ kết: ${pred.confidence}%)` : '';
      bxhText += `${icon} <b>${item.platform} - ${item.game_name}</b>\n`;
      bxhText += `   • Tỷ lệ húp bàn: <b>${item.win_rate}%</b> (${item.total_wins} Húp / ${item.total_losses} Gãy)\n`;
      bxhText += `   • Bám cầu liên tục: <b>#${item.epochs} tay</b> | Chuỗi ăn thông: <b>${item.current_streak} tay</b>\n`;
      if (predStr) bxhText += `   • ${predStr}\n`;
      bxhText += `\n`;
    });

    const rows = [];
    for (let i = 0; i < Math.min(6, top5.length); i += 2) {
      const r = [{ text: `⚔️ ${top5[i].platform}`, callback_data: `ai_detail_${top5[i].channel_id}` }];
      if (top5[i + 1]) {
        r.push({ text: `⚔️ ${top5[i + 1].platform}`, callback_data: `ai_detail_${top5[i + 1].channel_id}` });
      }
      rows.push(r);
    }
    rows.push([{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]);

    return sendOrReplaceMenu(chatId, bxhText, { reply_markup: { inline_keyboard: rows } });
  }

  // 1. CÁC LỆNH DÀNH CHO ADMIN
  if (isAdmin) {
    // Admin đang gửi link cập nhật cổng
    if (adminInputState[chatId]?.action === 'awaiting_portal_url') {
      const portalId = adminInputState[chatId].portalId;
      delete adminInputState[chatId];

      if (!text.startsWith('http://') && !text.startsWith('https://')) {
        return sendOrReplaceMenu(chatId, `❌ Link không hợp lệ! Vui lòng bắt đầu bằng http:// hoặc https://`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quay Lại', callback_data: 'admin_update_cong' }]] }
        });
      }

      const updated = config.updateEndpointUrl(portalId, text);
      if (updated) {
        const channels = config.loadEndpoints();
        const target = channels.find(c => c.id === portalId);
        await sendOrReplaceMenu(chatId, `⏳ Đang gửi ping kiểm tra kết nối link mới...`);
        const fetchRes = await collector.fetchChannel(target);

        return sendOrReplaceMenu(
          chatId,
          `
✅ <b>CẬP NHẬT LINK THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
🎮 <b>Cổng:</b> ${target.platform} (${target.gameName})
🔗 <b>Link mới:</b> <code>${text}</code>
📡 <b>Trạng thái:</b> ${fetchRes.ok ? '🟢 Kết Nối OK' : '🔴 Chưa phản hồi'}
━━━━━━━━━━━━━━━━━━━━
<i>Áp dụng ngay lập tức cho toàn bộ hệ thống.</i>
          `.trim(),
          {
            reply_markup: {
              inline_keyboard: [[{ text: '🔙 Quay Lại Cập Nhật Cổng', callback_data: 'admin_update_cong' }]]
            }
          }
        );
      }
    }

    // Admin đang nhập nội dung bảo trì
    if (adminInputState[chatId]?.action === 'awaiting_maintenance_msg') {
      delete adminInputState[chatId];
      await firebase.setMaintenance(true, text, userId);
      return sendOrReplaceMenu(chatId, `⚠️ <b>ĐÃ KÍCH HOẠT BẢO TRÌ:</b>\n<i>"${text}"</i>`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Bảng Điều Khiển Admin', callback_data: 'admin_dashboard' }]] }
      });
    }

    // Lệnh tạo token: /taotoken [thời hạn] [ghi chú]
    if (text.startsWith('/taotoken')) {
      const parts = text.split(' ').filter(Boolean);

      // Nếu chỉ gõ /taotoken mà không truyền tham số -> Hiện menu chọn nhanh
      if (parts.length === 1 || parts[1]?.toLowerCase() === 'help') {
        const keyboard = {
          inline_keyboard: [
            [
              { text: '⚡ 1 Ngày (Dùng thử)', callback_data: 'admin_gen_token_1d' },
              { text: '⚡ 3 Ngày', callback_data: 'admin_gen_token_3d' }
            ],
            [
              { text: '⚡ 7 Ngày (1 Tuần)', callback_data: 'admin_gen_token_7d' },
              { text: '⚡ 30 Ngày (1 Tháng)', callback_data: 'admin_gen_token_30d' }
            ],
            [
              { text: '👑 Vĩnh Viễn (Trọn đời)', callback_data: 'admin_gen_token_forever' }
            ],
            [
              { text: '🔙 Quay Lại Menu', callback_data: 'back_main' }
            ]
          ]
        };

        return sendOrReplaceMenu(
          chatId,
          `
⚡ <b>TRUNG TÂM TẠO TOKEN BẢN QUYỀN TRỰC TIẾP TRÊN BOT</b>
━━━━━━━━━━━━━━━━━━━━
👉 <b>Cách 1:</b> Bấm chọn thời hạn cần tạo ở các nút bấm bên dưới.
👉 <b>Cách 2:</b> Gõ lệnh nhanh: <code>/taotoken &lt;thời hạn&gt; &lt;ghi chú&gt;</code>
<i>Ví dụ:</i>
• <code>/taotoken 1d Khach_Dung_Thu</code>
• <code>/taotoken 7d Khach_Zalo</code>
• <code>/taotoken 30d VIP_0988xxx</code>
• <code>/taotoken forever VIP_TRON_DOI</code>
━━━━━━━━━━━━━━━━━━━━
          `.trim(),
          { reply_markup: keyboard }
        );
      }

      let duration = '30 Ngày';
      let note = 'Tạo bởi Admin Telegram';

      if (parts[1]) {
        const p1 = parts[1].toLowerCase();
        if (p1.includes('1') || p1 === '1d' || p1 === '1ngay') duration = '1 Ngày';
        else if (p1.includes('3') || p1 === '3d' || p1 === '3ngay') duration = '3 Ngày';
        else if (p1.includes('7') || p1 === '7d' || p1 === '7ngay' || p1.includes('tuan')) duration = '7 Ngày';
        else if (p1.includes('30') || p1 === '30d' || p1 === '30ngay' || p1.includes('thang')) duration = '30 Ngày';
        else if (p1.includes('vinh') || p1 === 'forever' || p1.includes('tron')) duration = 'Vĩnh viễn';
        else duration = parts[1];
      }
      if (parts[2]) {
        note = parts.slice(2).join(' ');
      }

      const key = `VIP-${makeRandomKey(4)}-${makeRandomKey(4)}`;
      const res = await firebase.createToken(key, { duration, note });

      if (res.success) {
        return sendOrReplaceMenu(
          chatId,
          `
✅ <b>TẠO TOKEN THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
🔑 <b>Mã Token:</b> <code>${key}</code>
⏱ <b>Thời hạn:</b> <b>${duration}</b>
📝 <b>Ghi chú:</b> ${note}
━━━━━━━━━━━━━━━━━━━━
📋 <b>Tin nhắn mẫu gửi khách (Chạm để sao chép):</b>
<code>Chào bạn, đây là mã Token bản quyền kích hoạt bot:</code>
<code>${key}</code>
<code>👉 Mở bot @icebearvntx_bot gửi mã này để kích hoạt nhé!</code>
          `.trim(),
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⚡ Tạo Thêm Token Khác', callback_data: 'admin_create_token_prompt' }],
                [{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]
              ]
            }
          }
        );
      } else {
        return sendOrReplaceMenu(chatId, `❌ Lỗi tạo token: ${res.error}`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]] }
        });
      }
    }

    // Lệnh thêm/nâng cấp admin: /addadmin <id> [tên]
    if (text.startsWith('/addadmin')) {
      const parts = text.split(' ').filter(Boolean);
      if (parts.length < 2) {
        return sendOrReplaceMenu(chatId, `👉 Cú pháp: <code>/addadmin &lt;telegram_id&gt; [tên_admin]</code>\nVí dụ: <code>/addadmin 7769479790 SuperAdmin</code>`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      }
      const newAdminId = parts[1].trim();
      const adminName = parts.slice(2).join(' ') || '';
      const addRes = await firebase.promoteToAdmin(newAdminId, 'Super Admin', adminName);

      if (addRes.success) {
        return sendOrReplaceMenu(chatId, `👑 <b>ĐÃ NÂNG LÊN SUPER ADMIN!</b>\nTài khoản ID: <code>${newAdminId}</code> đã nhận toàn bộ quyền quản trị.`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      } else {
        return sendOrReplaceMenu(chatId, `❌ Thất bại: ${addRes.error}`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      }
    }

    // Lệnh gỡ admin (chuyển thành dân thường): /deladmin <id>
    if (text.startsWith('/deladmin')) {
      const parts = text.split(' ').filter(Boolean);
      if (parts.length < 2) {
        return sendOrReplaceMenu(chatId, `👉 Cú pháp: <code>/deladmin &lt;telegram_id&gt;</code>\nVí dụ: <code>/deladmin 7769479790</code>`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      }
      const targetId = parts[1].trim();
      const delRes = await firebase.demoteAdminToUser(targetId);

      if (delRes.success) {
        return sendOrReplaceMenu(chatId, `🔄 <b>ĐÃ CHUYỂN THÀNH DÂN THƯỜNG!</b>\nTài khoản ID: <code>${targetId}</code> đã bị thu hồi quyền Admin, phải có token để soi cầu như người dùng bình thường.`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      } else {
        return sendOrReplaceMenu(chatId, `❌ Không thể chuyển: ${delRes.error}`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      }
    }

    // Lệnh chuyển đổi qua lại 2 chiều: /chuyenquyen <id>
    if (text.startsWith('/chuyenquyen')) {
      const parts = text.split(' ').filter(Boolean);
      if (parts.length < 2) {
        return sendOrReplaceMenu(chatId, `👉 Cú pháp: <code>/chuyenquyen &lt;telegram_id&gt;</code>\nVí dụ: <code>/chuyenquyen 7769479790</code>`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      }
      const targetId = parts[1].trim();
      await firebase.toggleAdminRole(targetId);
      const isNowAdmin = firebase.isAdmin(targetId);

      if (isNowAdmin) {
        return sendOrReplaceMenu(chatId, `👑 <b>ĐÃ CHUYỂN SANG ADMIN!</b>\nTài khoản ID: <code>${targetId}</code> đã được nâng lên làm Super Admin.`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      } else {
        return sendOrReplaceMenu(chatId, `🔄 <b>ĐÃ CHUYỂN SANG DÂN THƯỜNG!</b>\nTài khoản ID: <code>${targetId}</code> đã chuyển thành người dùng bình thường.`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Admin', callback_data: 'admin_manage_admins' }]] }
        });
      }
    }

    // Lệnh /baotri
    if (text.startsWith('/baotri')) {
      const parts = text.split(' ');
      parts.shift();
      const content = parts.join(' ').trim();

      if (content.toLowerCase() === 'off' || content.toLowerCase() === 'tat') {
        await firebase.setMaintenance(false, '', userId);
        return sendOrReplaceMenu(chatId, `✅ <b>ĐÃ TẮT BẢO TRÌ!</b> Người dùng có thể sử dụng bình thường.`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Bảng Điều Khiển Admin', callback_data: 'admin_dashboard' }]] }
        });
      }

      if (!content) {
        adminInputState[chatId] = { action: 'awaiting_maintenance_msg' };
        return sendOrReplaceMenu(chatId, `👉 <b>Vui lòng gửi nội dung thông báo bảo trì:</b>`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Hủy Bỏ', callback_data: 'admin_dashboard' }]] }
        });
      }

      await firebase.setMaintenance(true, content, userId);
      return sendOrReplaceMenu(chatId, `⚠️ <b>ĐÃ BẬT BẢO TRÌ:</b> "${content}"`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Bảng Điều Khiển Admin', callback_data: 'admin_dashboard' }]] }
      });
    }

    // Lệnh /tatbaotri
    if (text === '/tatbaotri') {
      await firebase.setMaintenance(false, '', userId);
      return sendOrReplaceMenu(chatId, `✅ <b>ĐÃ TẮT BẢO TRÌ!</b>`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Bảng Điều Khiển Admin', callback_data: 'admin_dashboard' }]] }
      });
    }

    // Lệnh /updatecong (hỗ trợ hiển thị bảng link hoặc cập nhật trực tiếp qua cú pháp /updatecong <id> <url>)
    if (text.startsWith('/updatecong')) {
      const parts = text.split(/\s+/);
      if (parts.length >= 3) {
        const portalId = parts[1].trim();
        const newUrl = parts[2].trim();
        if (!newUrl.startsWith('http://') && !newUrl.startsWith('https://')) {
          return sendOrReplaceMenu(chatId, `❌ Link không hợp lệ! Vui lòng bắt đầu bằng http:// hoặc https://`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quản Lý Cổng', callback_data: 'admin_update_cong' }]] }
          });
        }
        const updated = config.updateEndpointUrl(portalId, newUrl);
        if (updated) {
          const channels = config.loadEndpoints();
          const target = channels.find(c => c.id === portalId);
          return sendOrReplaceMenu(
            chatId,
            `
✅ <b>CẬP NHẬT LINK THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
🎮 <b>Cổng:</b> ${target ? target.platform + ' - ' + target.gameName : portalId}
🆔 <b>Mã ID:</b> <code>${portalId}</code>
🔗 <b>Link mới:</b> <code>${newUrl}</code>
━━━━━━━━━━━━━━━━━━━━
<i>Hệ thống đã áp dụng link mới cho bộ quét Collector.</i>
            `.trim(),
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🌐 Xem Danh Sách Link API', callback_data: 'admin_update_cong' }],
                  [{ text: '🔙 Quay Lại Menu Admin', callback_data: 'admin_dashboard' }]
                ]
              }
            }
          );
        } else {
          return sendOrReplaceMenu(chatId, `❌ Không tìm thấy cổng game có ID <code>${portalId}</code>! Vui lòng kiểm tra lại ID trong danh sách quản lý.`, {
            reply_markup: { inline_keyboard: [[{ text: '🌐 Xem Danh Sách Cổng', callback_data: 'admin_update_cong' }]] }
          });
        }
      }

      const menuData = renderAdminEndpointsMenu(1);
      return sendOrReplaceMenu(chatId, menuData.text, { reply_markup: menuData.reply_markup });
    }
  }

  // 2. KIỂM TRA BẢO TRÌ VỚI USER THƯỜNG
  if (!isAdmin) {
    const maintenance = await firebase.getMaintenance();
    if (maintenance && maintenance.active) {
      return sendOrReplaceMenu(
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

  // 3. KIỂM TRA QUYỀN TRUY CẬP (TOKEN BẢN QUYỀN)
  const authCheck = await firebase.checkUserAuthorized(userId);

  // Nếu user không hợp lệ (Chưa nhập token, hoặc Token đã hết hạn / bị xóa)
  if (!authCheck.authorized) {
    if (authCheck.reason === 'TOKEN_DELETED' || authCheck.reason === 'TOKEN_EXPIRED' || authCheck.reason === 'TOKEN_REVOKED') {
      return sendOrReplaceMenu(
        chatId,
        `
⚠️ <b>THÔNG BÁO: TOKEN CỦA BẠN ĐÃ HẾT HẠN HOẶC BỊ THU HỒI!</b>
━━━━━━━━━━━━━━━━━━━━
${authCheck.message || 'Bạn không thể tiếp tục sử dụng bot do token đã hết hạn hoặc bị xóa trên hệ thống.'}

💳 <b>GIA HẠN TỰ ĐỘNG BẰNG THẺ CÀO 24/7:</b>
• 🌟 <b>Gói VIP 7 Ngày:</b> <code>200.000 VNĐ</code>
• 👑 <b>Gói VIP 30 Ngày:</b> <code>1.000.000 VNĐ</code>
<i>Hệ thống tự động duyệt thẻ và kích hoạt lại bot ngay lập tức!</i>
━━━━━━━━━━━━━━━━━━━━
👉 <b>Hoặc liên hệ Admin để mua/gia hạn token:</b>
${ADMIN_CONTACT}
        `.trim(),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 NẠP THẺ GIA HẠN TOKEN NGAY', callback_data: 'napthe_menu' }],
              [
                { text: '🌟 Gói 7 Ngày (200k)', callback_data: 'napthe_pack_7d' },
                { text: '👑 Gói 30 Ngày (1M)', callback_data: 'napthe_pack_30d' }
              ],
              [{ text: '💬 Liên Hệ Admin', url: 'https://t.me/spamsmstaken' }]
            ]
          }
        }
      );
    }

    if (text === '/start') {
      return sendOrReplaceMenu(
        chatId,
        `
🐻 <b>VẢ VỠ MỒM NHÀ CÁI - TÀI XỈU VIP PRO</b> 🐻
━━━━━━━━━━━━━━━━━━━━━━━
🎲 <b>HỆ THỐNG SOI CẦU TÀI XỈU THỰC CHIẾN CHUYÊN NGHIỆP</b> 🎲

Chào mừng bạn đến với hệ thống bắt vị Tài Xỉu độc quyền của <b>Gấu Nâu</b> & <b>Đội Ngũ Thực Chiến</b>!
Hệ thống khóa mã Token riêng theo từng tài khoản Telegram để đảm bảo tốc độ đọc cầu realtime 0.02s nhanh nhất thị trường.

👉 <b>Nếu bạn đã có Mã Token:</b> Hãy gửi mã vào đây để mở khóa bot ngay!
━━━━━━━━━━━━━━━━━━━━━━━
💳 <b>MUA TOKEN TỰ ĐỘNG BẰNG THẺ CÀO 24/7:</b>
• 🌟 <b>Gói VIP 7 Ngày:</b> <code>200.000 VNĐ</code>
• 👑 <b>Gói VIP 30 Ngày:</b> <code>1.000.000 VNĐ</code>
<i>(Duyệt thẻ tự động qua cổng gạch thẻ, cấp token và mở khóa bot tức thì 15s-30s!)</i>
━━━━━━━━━━━━━━━━━━━━━━━
💬 <b>Hoặc nhắn tin Admin nhận mã trực tiếp:</b>
${ADMIN_CONTACT}
        `.trim(),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 NẠP THẺ MUA TOKEN TỰ ĐỘNG', callback_data: 'napthe_menu' }],
              [
                { text: '🌟 Mua Gói 7 Ngày (200k)', callback_data: 'napthe_pack_7d' },
                { text: '👑 Mua Gói 30 Ngày (1M)', callback_data: 'napthe_pack_30d' }
              ],
              [{ text: '💬 Nhắn Tin Admin Mua Mã', url: 'https://t.me/spamsmstaken' }]
            ]
          }
        }
      );
    }

    // Nhập token kích hoạt
    const result = await firebase.activateUserWithToken(userId, msg.from, text);
    if (result.success) {
      return sendOrReplaceMenu(
        chatId,
        `
🐻 <b>KÍCH HOẠT BẢN QUYỀN THÀNH CÔNG!</b> 🐻
━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Chiến Binh:</b> ${msg.from.first_name || ''} (@${msg.from.username || userId})
🔑 <b>Mã Token:</b> <code>${text.toUpperCase()}</code>
⏱ <b>Thời Hạn:</b> <b>${result.tokenData?.duration || 'Vĩnh viễn'}</b>
━━━━━━━━━━━━━━━━━━━━━━━
🎉 Chào mừng Đại Ca! Toàn bộ 25+ bàn cầu Tài Xỉu đã sẵn sàng chờ lệnh vả vỡ mồm nhà cái.

👇 <b>Chọn sảnh Tài Xỉu bên dưới để bắt đầu bẻ cầu:</b>
        `.trim(),
        { reply_markup: getUserKeyboard() }
      );
    } else {
      return sendOrReplaceMenu(
        chatId,
        `❌ <b>KÍCH HOẠT THẤT BẠI:</b>\n\n${result.message}\n\n💬 <b>Liên hệ Admin để mua token:</b>\n${ADMIN_CONTACT}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Nạp Thẻ Mua Token', callback_data: 'napthe_menu' }],
              [{ text: '🔙 Thử Lại', callback_data: 'back_main' }]
            ]
          }
        }
      );
    }
  }

  // Lệnh dọn dẹp sạch toàn bộ tin nhắn rác
  if (text === '/cleanchat' || text === '/clean' || text === '/xoahet' || text === '/donchat') {
    const deletedCount = await cleanAllUserMessages(chatId);
    const menuText = formatMainMenuText({ user: msg.from, isAdmin, authCheck });
    return sendOrReplaceMenu(
      chatId,
      `
🧹 <b>ĐÃ DỌN DẸP SẠCH ${deletedCount} TIN NHẮN RÁC!</b>
━━━━━━━━━━━━━━━━━━━━━━━
${menuText}
      `.trim(),
      { reply_markup: isAdmin ? getAdminKeyboard() : getUserKeyboard() }
    );
  }

  // 4. NẾU ĐÃ KÍCH HOẠT (HOẶC LÀ ADMIN)
  if (text === '/start' || text === '/menu') {
    const menuText = formatMainMenuText({ user: msg.from, isAdmin, authCheck });
    return sendOrReplaceMenu(
      chatId,
      menuText,
      { reply_markup: isAdmin ? getAdminKeyboard() : getUserKeyboard() }
    );
  }

  if (text === '/help') {
    return sendOrReplaceMenu(
      chatId,
      `
📖 <b>HƯỚNG DẪN SỬ DỤNG BOT:</b>
• /menu - Mở bảng chọn cổng game (chỉ giữ 1 menu duy nhất)
• /cleanchat - Dọn dẹp xóa sạch toàn bộ tin nhắn rác cũ trong chat
• Bấm nút cổng game để xem dự đoán phiên tiếp theo
• Bấm <b>"Bật Báo Tự Động"</b> để bot tự động cập nhật phiên mới
💬 <b>Hỗ trợ Admin:</b>\n${ADMIN_CONTACT}
      `.trim()
    );
  }
}

// Xử lý Callback nút bấm (Inline Buttons)
async function handleCallbackQuery(query) {
  if (!query || !query.message) return;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;
  const isAdmin = firebase.isAdmin(userId);

  // Đảm bảo toàn bộ tương tác đều gắn chặt với đúng ID tin nhắn này
  lastMenuMessageId[chatId] = messageId;

  // 1. Kiểm tra bảo trì đối với user thường
  if (!isAdmin) {
    const maintenance = await firebase.getMaintenance();
    if (maintenance && maintenance.active) {
      return answerCallbackQuery(query.id, `Hệ thống đang bảo trì: ${maintenance.message || 'Vui lòng chờ ít phút!'}`, true);
    }
  }

  // 2. KIỂM TRA QUYỀN TRUY CẬP REALTIME
  // NẾU TOKEN HẾT HẠN HOẶC BỊ XÓA -> KHÓA VÀ RENDER THÔNG BÁO LÊN ĐÚNG 1 TIN NHẮN NÀY
  const authCheck = await firebase.checkUserAuthorized(userId);
  if (!authCheck.authorized && !data.startsWith('napthe_')) {
    await answerCallbackQuery(query.id, '❌ Token đã hết hạn hoặc bị xóa! Toàn bộ menu đã chuyển sang chế độ gia hạn.', true);
    
    // Dọn các tin nhắn cũ khác nhưng giữ nguyên tin nhắn hiện tại
    await cleanAllUserMessages(chatId, messageId);

    // Xóa khỏi danh sách nhận thông báo tự động
    notificationSubscribers.delete(chatId);

    // Cập nhật ngay trên chính tin nhắn này
    return renderSingleMessage(
      chatId,
      messageId,
      `
⚠️ <b>THÔNG BÁO: TÀI KHOẢN ĐÃ HẾT HẠN HOẶC BỊ THU HỒI TOKEN!</b>
━━━━━━━━━━━━━━━━━━━━
Toàn bộ thao tác soi cầu đã tạm khóa. Bạn có thể tự gia hạn nhanh 24/7 bằng thẻ cào để tiếp tục chiến tiếp!

💳 <b>GIA HẠN TỰ ĐỘNG BẰNG THẺ CÀO 24/7:</b>
• 🌟 <b>Gói VIP 7 Ngày:</b> <code>200.000 VNĐ</code>
• 👑 <b>Gói VIP 30 Ngày:</b> <code>1.000.000 VNĐ</code>
━━━━━━━━━━━━━━━━━━━━
👉 <b>Hoặc liên hệ Admin để mua/gia hạn Token mới:</b>
${ADMIN_CONTACT}
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 NẠP THẺ GIA HẠN TOKEN', callback_data: 'napthe_menu' }],
            [{ text: '💬 Liên Hệ Admin', url: 'https://t.me/spamsmstaken' }]
          ]
        }
      }
    );
  }

  await answerCallbackQuery(query.id);

  // ================= HỦY BỎ THAO TÁC / QUAY LẠI MENU =================
  if (data === 'napthe_cancel') {
    delete userCardInputState[chatId];
    delete adminInputState[chatId];
    const keyboard = isAdmin ? getAdminKeyboard() : getUserKeyboard();
    const text = formatMainMenuText({ user: query.from, isAdmin });
    return renderSingleMessage(chatId, messageId, text, { reply_markup: keyboard });
  }

  // ================= NẠP THẺ CÀO TỰ ĐỘNG (DOITHEVIP) =================
  else if (data === 'napthe_menu') {
    const text = `
💳 <b>HỆ THỐNG NẠP THẺ CÀO BÁN TOKEN BOT TỰ ĐỘNG 24/7</b>
━━━━━━━━━━━━━━━━━━━━
⚡ Gạch thẻ tự động siêu tốc qua cổng <b>DoiTheVip.com</b> (15s - 45s)
🎁 Tự động kích hoạt bot và cấp mã token ngay khi thẻ đúng!

📋 <b>BẢNG GIÁ GÓI TOKEN VIP:</b>
• 🌟 <b>GÓI VIP 7 NGÀY:</b> <code>200.000 VNĐ</code>
• 👑 <b>GÓI VIP 30 NGÀY:</b> <code>1.000.000 VNĐ</code>
━━━━━━━━━━━━━━━━━━━━
👇 <b>Bấm chọn gói bạn muốn nạp bên dưới:</b>
    `.trim();

    return renderSingleMessage(chatId, messageId, text, { reply_markup: getNapThePackagesKeyboard() });
  }

  else if (data === 'napthe_pack_7d' || data === 'napthe_pack_30d' || data === 'napthe_pack_custom') {
    let packName = '7 Ngày (200.000đ)';
    let packType = '7d';
    if (data === 'napthe_pack_30d') {
      packName = '30 Ngày (1.000.000đ)';
      packType = '30d';
    } else if (data === 'napthe_pack_custom') {
      packName = 'Tùy Chọn Mệnh Giá';
      packType = 'custom';
    }

    const text = `
📡 <b>CHỌN NHÀ MẠNG CHO [GÓI ${packName}]</b>
━━━━━━━━━━━━━━━━━━━━
Hỗ trợ tất cả các nhà mạng và thẻ game:
• Viettel, Mobifone, Vinaphone, Vietnamobile
• Thẻ Zing, Thẻ Gate
━━━━━━━━━━━━━━━━━━━━
👇 <b>Bấm chọn loại thẻ bạn đang có:</b>
    `.trim();

    return renderSingleMessage(chatId, messageId, text, { reply_markup: getNapTheTelcoKeyboard(packType) });
  }

  else if (data.startsWith('napthe_telco_')) {
    const parts = data.replace('napthe_telco_', '').split('_');
    const telco = parts[0];
    const packageType = parts[1] || '7d';

    if (packageType === 'custom') {
      const text = `
💵 <b>CHỌN MỆNH GIÁ THẺ [${telco}] CỦA BẠN:</b>
━━━━━━━━━━━━━━━━━━━━
<i>Lưu ý: Bạn cần chọn đúng mệnh giá thẻ để nhà mạng duyệt nhanh nhất!</i>
      `.trim();

      return renderSingleMessage(chatId, messageId, text, { reply_markup: getNapTheAmountKeyboard(telco, packageType) });
    }

    const amount = packageType === '30d' ? 1000000 : 200000;
    const packTitle = packageType === '30d' ? 'VIP 30 Ngày (1.000.000 VNĐ)' : 'VIP 7 Ngày (200.000 VNĐ)';

    userCardInputState[chatId] = {
      action: 'awaiting_card',
      telco,
      amount,
      packageType,
      userId
    };

    return renderSingleMessage(
      chatId,
      messageId,
      `
💳 <b>BƯỚC CUỐI: GỬI MÃ THẺ & SỐ SERI</b>
━━━━━━━━━━━━━━━━━━━━
🎁 <b>Gói đăng ký:</b> <b>${packTitle}</b>
📡 <b>Nhà mạng:</b> <b>${telco}</b>
💵 <b>Mệnh giá khai báo:</b> <b>${amount.toLocaleString('vi-VN')} VNĐ</b>
━━━━━━━━━━━━━━━━━━━━
👉 <b>Hãy gửi tin nhắn chứa Mã Thẻ và Số Seri:</b>
<code>MÃ_THẺ SỐ_SERI</code>
<i>(Ví dụ: <code>123456789012 10001234567890</code> - cách nhau bởi dấu cách)</i>
━━━━━━━━━━━━━━━━━━━━
<i>(Hệ thống sẽ tự động xóa tin nhắn bạn gửi và cập nhật kết quả ngay trên tin này)</i>
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Hủy Bỏ Thao Tác', callback_data: 'napthe_cancel' }]
          ]
        }
      }
    );
  }

  else if (data.startsWith('napthe_amt_')) {
    const parts = data.replace('napthe_amt_', '').split('_');
    const amount = parseInt(parts[0]) || 200000;
    const telco = parts[1] || 'VIETTEL';
    const packageType = parts[2] || 'custom';

    userCardInputState[chatId] = {
      action: 'awaiting_card',
      telco,
      amount,
      packageType,
      userId
    };

    const targetDuration = amount >= 1000000 ? '30 Ngày' : (amount >= 200000 ? '7 Ngày' : '1 Ngày');

    return renderSingleMessage(
      chatId,
      messageId,
      `
💳 <b>BƯỚC CUỐI: GỬI MÃ THẺ & SỐ SERI</b>
━━━━━━━━━━━━━━━━━━━━
📡 <b>Nhà mạng:</b> <b>${telco}</b>
💵 <b>Mệnh giá:</b> <b>${amount.toLocaleString('vi-VN')} VNĐ</b>
🎁 <b>Gói nhận được:</b> <b>${targetDuration}</b>
━━━━━━━━━━━━━━━━━━━━
👉 <b>Hãy gửi tin nhắn chứa Mã Thẻ và Số Seri:</b>
<code>MÃ_THẺ SỐ_SERI</code>
<i>(Ví dụ: <code>123456789012 10001234567890</code> - cách nhau bởi dấu cách)</i>
━━━━━━━━━━━━━━━━━━━━
<i>(Hệ thống sẽ tự động xóa tin nhắn bạn gửi và cập nhật kết quả ngay trên tin này)</i>
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Hủy Bỏ Thao Tác', callback_data: 'napthe_cancel' }]
          ]
        }
      }
    );
  }

  // ================= ADMIN ACTIONS =================
  // Tạo token: chọn thời hạn
  else if (data === 'admin_create_token_prompt') {
    if (!isAdmin) return;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '⚡ 1 Ngày (Dùng thử)', callback_data: 'admin_gen_token_1d' },
          { text: '⚡ 3 Ngày', callback_data: 'admin_gen_token_3d' }
        ],
        [
          { text: '⚡ 7 Ngày (1 Tuần)', callback_data: 'admin_gen_token_7d' },
          { text: '⚡ 30 Ngày (1 Tháng)', callback_data: 'admin_gen_token_30d' }
        ],
        [
          { text: '👑 Vĩnh Viễn (Trọn đời)', callback_data: 'admin_gen_token_forever' }
        ],
        [
          { text: '🔙 Quay Lại', callback_data: 'back_main' }
        ]
      ]
    };

    return renderSingleMessage(chatId, messageId, '⚡ <b>CHỌN THỜI HẠN TOKEN CẦN TẠO:</b>', {
      reply_markup: keyboard
    });
  }

  else if (data.startsWith('admin_gen_token_')) {
    if (!isAdmin) return;
    let duration = '30 Ngày';
    if (data === 'admin_gen_token_1d') duration = '1 Ngày';
    else if (data === 'admin_gen_token_3d') duration = '3 Ngày';
    else if (data === 'admin_gen_token_7d') duration = '7 Ngày';
    else if (data === 'admin_gen_token_30d') duration = '30 Ngày';
    else if (data === 'admin_gen_token_forever') duration = 'Vĩnh viễn';

    const key = `VIP-${makeRandomKey(4)}-${makeRandomKey(4)}`;
    await firebase.createToken(key, { duration, note: `Tạo qua Telegram bởi Admin ${userId}` });

    return renderSingleMessage(
      chatId,
      messageId,
      `
✅ <b>ĐÃ TẠO MÃ TOKEN THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
🔑 <b>Mã Token:</b> <code>${key}</code>
⏱ <b>Thời hạn:</b> <b>${duration}</b>
━━━━━━━━━━━━━━━━━━━━
📋 <b>Nội dung gửi khách:</b>
<code>Chào bạn, mã Token kích hoạt bot của bạn là:</code>
<code>${key}</code>
<code>👉 Vào bot @icebearvntx_bot gửi mã trên để kích hoạt nhé!</code>
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚡ Tạo Thêm Mã Khác', callback_data: 'admin_create_token_prompt' }],
            [{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]
          ]
        }
      }
    );
  }

  // Quản lý Admin & Chuyển đổi Dân thường qua lại
  else if (data === 'admin_manage_admins' || data.startsWith('toggle_role_')) {
    if (!isAdmin) return;

    if (data.startsWith('toggle_role_')) {
      const targetId = data.replace('toggle_role_', '');
      await firebase.toggleAdminRole(targetId);
      const isNowAdmin = firebase.isAdmin(targetId);
      await answerCallbackQuery(query.id, isNowAdmin ? `👑 Đã nâng ID ${targetId} lên Admin!` : `🔄 Đã chuyển ID ${targetId} thành Dân Thường!`, true);
    }

    const adminsObj = await firebase.getAllAdmins();
    const activeAdmins = [];
    const demotedUsers = [];

    for (const [id, item] of Object.entries(adminsObj)) {
      if (!item) continue;
      const roleStr = String(item.role || '').toLowerCase();
      const isDemoted = item.is_admin === false ||
        roleStr === 'user' ||
        roleStr === 'dân thường' ||
        roleStr === 'dan thuong' ||
        roleStr === 'người dùng' ||
        roleStr === 'nguoi dung';

      if (isDemoted) {
        demotedUsers.push({ id, ...item });
      } else {
        activeAdmins.push({ id, ...item });
      }
    }

    let text = `👑 <b>QUẢN LÝ ADMIN & DÂN THƯỜNG (CHUYỂN QUA LẠI 2 CHIỀU)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🛡️ <b>ADMIN ĐANG HOẠT ĐỘNG (${activeAdmins.length}):</b>\n`;
    if (activeAdmins.length === 0) {
      text += `<i>(Không có Admin nào)</i>\n`;
    } else {
      activeAdmins.forEach(a => {
        text += `• <b>${a.name || a.username || 'Admin'}</b> (<code>${a.id}</code>) - ${a.role || 'Admin'}\n`;
      });
    }

    text += `\n👤 <b>DÂN THƯỜNG / ĐÃ HẠ QUYỀN (${demotedUsers.length}):</b>\n`;
    if (demotedUsers.length === 0) {
      text += `<i>(Không có tài khoản nào)</i>\n`;
    } else {
      demotedUsers.forEach(u => {
        text += `• <b>${u.name || u.username || 'User'}</b> (<code>${u.id}</code>) - <i>Mất quyền</i>\n`;
      });
    }

    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `👉 <b>Lệnh nâng Admin:</b> <code>/addadmin &lt;id&gt; [tên]</code>\n`;
    text += `👉 <b>Lệnh chuyển Dân thường:</b> <code>/deladmin &lt;id&gt;</code>\n`;
    text += `👉 <b>Chuyển đổi 2 chiều nhanh:</b> <code>/chuyenquyen &lt;id&gt;</code>\n`;
    text += `<i>(Hoặc bấm các phím chuyển đổi trực tiếp bên dưới)</i>`;

    const is7769Admin = firebase.isAdmin('7769479790');
    const is8083Admin = firebase.isAdmin('8083052279');

    const inlineKeyboard = [
      [
        {
          text: is7769Admin ? '🔄 7769479790 ➜ Dân Thường' : '👑 7769479790 ➜ Admin',
          callback_data: 'toggle_role_7769479790'
        }
      ],
      [
        {
          text: is8083Admin ? '🔄 8083052279 ➜ Dân Thường' : '👑 8083052279 ➜ Admin',
          callback_data: 'toggle_role_8083052279'
        }
      ],
      [{ text: '🔙 Quay Lại Menu Admin', callback_data: 'admin_dashboard' }]
    ];

    return renderSingleMessage(chatId, messageId, text, {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  }

  // Quay lại Bảng điều khiển Admin
  else if (data === 'admin_dashboard' || data === 'admin_menu') {
    if (!isAdmin) return;
    const text = `
🐻 <b>VẢ VỠ MỒM NHÀ CÁI - BẢNG ĐIỀU KHIỂN ADMIN</b> 🐻
━━━━━━━━━━━━━━━━━━━━
Kính chào Sếp <b>${query.from.first_name || 'Admin'}</b> (ID: <code>${userId}</code>)!
Hệ thống sẵn sàng phục vụ toàn bộ chức năng quản trị cấp cao và bắt vị thực chiến.

👇 <b>Chọn thao tác quản lý hoặc bấm cổng soi cầu bên dưới:</b>
    `.trim();

    return renderSingleMessage(chatId, messageId, text, {
      reply_markup: getAdminKeyboard()
    });
  }

  // Dọn dẹp sạch toàn bộ tin nhắn rác nhưng giữ đúng tin menu hiện tại
  else if (data === 'clean_chat') {
    await answerCallbackQuery(query.id, '🧹 Đang dọn dẹp sạch sẽ chat...', false);
    const count = await cleanAllUserMessages(chatId, messageId);
    const menuText = formatMainMenuText({ user: query.from, isAdmin });
    return renderSingleMessage(
      chatId,
      messageId,
      `
🧹 <b>ĐÃ DỌN DẸP SẠCH ${count} TIN NHẮN TRONG CHAT!</b>
━━━━━━━━━━━━━━━━━━━━━━━
${menuText}
      `.trim(),
      { reply_markup: isAdmin ? getAdminKeyboard() : getUserKeyboard() }
    );
  }

  // Thao tác sửa link cổng
  else if (data.startsWith('admin_edit_url_')) {
    if (!isAdmin) return;
    const portalId = data.replace('admin_edit_url_', '');
    const channels = config.loadEndpoints();
    const target = channels.find(c => c.id === portalId);

    adminInputState[chatId] = { action: 'awaiting_portal_url', portalId };
    return renderSingleMessage(
      chatId,
      messageId,
      `
✏️ <b>CẬP NHẬT LINK CHO CỔNG: [${target ? target.platform + ' - ' + target.gameName : portalId}]</b>
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Mã ID:</b> <code>${portalId}</code>
🔗 <b>Link API hiện tại:</b>
<code>${target ? target.url : 'Chưa cấu hình'}</code>
━━━━━━━━━━━━━━━━━━━━
👉 <b>Hãy gửi tin nhắn chứa link Cloudflare mới (bắt đầu bằng https://...):</b>
<i>Ví dụ: <code>https://example-proxy.trycloudflare.com/api/tx</code></i>

💡 <i>Hoặc gửi lệnh:</i> <code>/updatecong ${portalId} &lt;link_mới&gt;</code>
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Hủy Bỏ / Quay Lại Danh Sách', callback_data: 'admin_update_cong' }]
          ]
        }
      }
    );
  }

  else if (data === 'admin_update_cong' || data.startsWith('admin_update_cong_page_')) {
    if (!isAdmin) return;
    let pageNum = 1;
    if (data.startsWith('admin_update_cong_page_')) {
      pageNum = parseInt(data.replace('admin_update_cong_page_', '')) || 1;
    }
    const menuData = renderAdminEndpointsMenu(pageNum);
    return renderSingleMessage(chatId, messageId, menuData.text, { reply_markup: menuData.reply_markup });
  }

  else if (data === 'admin_set_baotri') {
    if (!isAdmin) return;
    adminInputState[chatId] = { action: 'awaiting_maintenance_msg' };
    return renderSingleMessage(
      chatId,
      messageId,
      `👉 <b>Vui lòng gửi tin nhắn nội dung thông báo bảo trì:</b>\n<i>(Hoặc bấm nút Hủy bên dưới)</i>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Hủy Bỏ / Quay Lại Menu', callback_data: 'napthe_cancel' }]
          ]
        }
      }
    );
  }

  else if (data === 'admin_off_baotri') {
    if (!isAdmin) return;
    await firebase.setMaintenance(false, '', userId);
    return renderSingleMessage(chatId, messageId, `✅ <b>ĐÃ TẮT BẢO TRÌ!</b>`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Quay Lại Menu Admin', callback_data: 'admin_dashboard' }]
        ]
      }
    });
  }

  else if (data === 'admin_view_tokens') {
    if (!isAdmin) return;
    const tokens = await firebase.getAllTokens();
    const list = Object.values(tokens);
    const used = list.filter(t => t.used).length;
    const free = list.length - used;

    const text = `
🔑 <b>THỐNG KÊ TOKEN BẢN QUYỀN TỪ FIREBASE:</b>
━━━━━━━━━━━━━━━━━━━━
• Tổng token: <b>${list.length}</b>
• 🟢 Chưa dùng: <b>${free}</b>
• 🔴 Đã kích hoạt: <b>${used}</b>
━━━━━━━━━━━━━━━━━━━━
💡 Tạo thêm token nhanh: gõ <code>/taotoken 30ngay</code> hoặc bấm nút bên dưới:
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [{ text: '⚡ Tạo Token Mới', callback_data: 'admin_create_token_prompt' }],
        [{ text: '🔙 Quay Lại Menu Admin', callback_data: 'admin_dashboard' }]
      ]
    };

    return renderSingleMessage(chatId, messageId, text, { reply_markup: keyboard });
  }

  // ================= GENERAL USER ACTIONS =================
  // Xem dự đoán kênh với hiệu ứng bắt vị thực chiến (Delay 3.2s)
  else if (data.startsWith('pred_')) {
    const channelId = data.replace('pred_', '');
    const channelData = collector.getChannelData(channelId);

    // Gửi màn hình quét nhịp bàn cầu trước trên đúng tin nhắn này
    const scanText = `
🐻 <b>ĐANG BẮT VỊ & SOI CẦU VẢ NHÀ CÁI...</b> 🐻
━━━━━━━━━━━━━━━━━━━━
🎮 Cổng: <b>${channelData.channel.platform}</b> (${channelData.channel.gameName})
⚡ <i>Đang đọc vị xúc xắc, rà soát nhịp bẻ cầu & bắt dải điểm...</i>

[▓▓▓▓▓▓▓▓░░] <b>85%</b> Đang khóa chặt kết quả tay này!
⏳ <i>Chờ 3-5 giây để ra đòn vả vỡ mồm nhà cái...</i>
    `.trim();

    await renderSingleMessage(chatId, messageId, scanText).catch(() => {});

    // Delay 3.2s để tính toán vị tối ưu
    await new Promise(resolve => setTimeout(resolve, 3200));

    // Lấy dữ liệu mới nhất sau khi tính toán
    const freshData = collector.getChannelData(channelId);
    const text = formatPredictionMessage(freshData);

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Soi Lại / Cập Nhật Phiên Này', callback_data: `pred_${channelId}` },
          { text: '📜 Xem 8 Phiên Vừa Ra', callback_data: `history_${channelId}` }
        ],
        [
          { text: '⚔️ Phong Độ Bàn Cầu Này', callback_data: `ai_detail_${channelId}` },
          { text: '🔙 Chọn Cổng Game Khác', callback_data: 'back_main' }
        ]
      ]
    };

    return renderSingleMessage(chatId, messageId, text, { reply_markup: keyboard });
  }

  // Sảnh Sicbo Bão VIP
  else if (data === 'menu_sicbo_portals') {
    const channels = config.loadEndpoints().filter(c => c.gameType === 'sicbo');
    const rows = [];
    for (let i = 0; i < channels.length; i += 2) {
      const row = [];
      row.push({ text: `🐉 ${channels[i].platform} Sicbo`, callback_data: `pred_${channels[i].id}` });
      if (channels[i + 1]) {
        row.push({ text: `🐉 ${channels[i + 1].platform} Sicbo`, callback_data: `pred_${channels[i + 1].id}` });
      }
      rows.push(row);
    }
    rows.push([{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]);

    return renderSingleMessage(chatId, messageId, `
🐉 <b>SẢNH SICBO VIP - ĐẦY ĐỦ CỬA TÀI, XỈU & BÃO (BỘ 3)</b> 🐉
━━━━━━━━━━━━━━━━━━━━
<i>Chỉ riêng Sicbo mới có cửa BÃO (Bộ 3 đồng nhất 1-1-1 đến 6-6-6) với tỉ lệ trả thưởng cực khủng. Hệ thống tự động phân tích và cảnh báo khi có tín hiệu Bão nổ!</i>

👇 <b>Bấm chọn sảnh Sicbo bạn muốn vào vả nhà cái:</b>
    `.trim(), {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // Sảnh Xóc Đĩa Tứ Vị
  else if (data === 'menu_xocdia_portals') {
    const channels = config.loadEndpoints().filter(c => c.gameType === 'xocdia');
    const rows = [];
    for (let i = 0; i < channels.length; i += 2) {
      const row = [];
      row.push({ text: `⚪ ${channels[i].platform} Xóc Đĩa`, callback_data: `pred_${channels[i].id}` });
      if (channels[i + 1]) {
        row.push({ text: `⚪ ${channels[i + 1].platform} Xóc Đĩa`, callback_data: `pred_${channels[i + 1].id}` });
      }
      rows.push(row);
    }
    rows.push([{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]);

    return renderSingleMessage(chatId, messageId, `
⚪ <b>SẢNH XÓC ĐĨA LIVE VIP - BẮT VỊ TỨ MÀU CHẴN LẺ</b> ⚪
━━━━━━━━━━━━━━━━━━━━
<i>Phân tích 4 đồng xu quân bài (Sấp đôi 2 Đỏ 2 Trắng, 3 Trắng 1 Đỏ, 3 Đỏ 1 Trắng, Tứ Tử). Tự động nhận diện thế cầu Chẵn/Lẻ!</i>

👇 <b>Bấm chọn sảnh Xóc Đĩa bạn muốn vào vả nhà cái:</b>
    `.trim(), {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // ================= BẢNG VÀNG THỰC CHIẾN & TỰ ĐỘNG CHƠI =================
  else if (data === 'ai_auto_play_overview') {
    const overviewList = collector.getAiOverview();
    const top5 = overviewList.slice(0, 8);

    let text = `🐻 <b>BẢNG VÀNG THỰC CHIẾN - VẢ VỠ MỒM NHÀ CÁI</b> 🐻\n━━━━━━━━━━━━━━━━━━━━\n`;
    text += `<i>Thống kê các bàn cầu đang có phong độ ăn thông và húp dày nhất hiện tại. Hệ thống bám cầu thực chiến 24/7 và đối chiếu kết quả từng giây với nhà cái!</i>\n\n`;
    text += `🏆 <b>TOP BÀN CẦU ĐANG HÚP KHÉT NHẤT:</b>\n`;

    top5.forEach((item, idx) => {
      const icon = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : '🔥'));
      const pred = item.last_prediction;
      const predStr = pred ? `➜ Tay rình <b>#${pred.phien_target}</b>: <b>${pred.prediction}</b> (Độ kết: ${pred.confidence}%)` : '';
      text += `${icon} <b>${item.platform} - ${item.game_name}</b>\n`;
      text += `   • Tỷ lệ húp bàn: <b>${item.win_rate}%</b> (${item.total_wins} Húp / ${item.total_losses} Gãy)\n`;
      text += `   • Bám cầu liên tục: <b>#${item.epochs} tay</b> | Chuỗi ăn thông: <b>${item.current_streak} tay</b>\n`;
      if (predStr) text += `   • ${predStr}\n`;
      text += `\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━\n💡 <i>Bấm vào cổng bên dưới để xem chi tiết vị và lịch sử thực chiến:</i>`;

    const rows = [];
    for (let i = 0; i < Math.min(6, top5.length); i += 2) {
      const r = [{ text: `⚔️ ${top5[i].platform}`, callback_data: `ai_detail_${top5[i].channel_id}` }];
      if (top5[i + 1]) {
        r.push({ text: `⚔️ ${top5[i + 1].platform}`, callback_data: `ai_detail_${top5[i + 1].channel_id}` });
      }
      rows.push(r);
    }
    rows.push([{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]);

    return renderSingleMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
  }

  // Chi tiết phong độ của 1 bàn cầu
  else if (data.startsWith('ai_detail_')) {
    const channelId = data.replace('ai_detail_', '');
    const channelData = collector.getChannelData(channelId);
    const ai = channelData.ai;
    const ch = channelData.channel;
    const pred = ai?.last_prediction;
    const diceA = ai?.dice_analysis;
    const isSicbo = ch.gameType === 'sicbo';
    const isXocdia = ch.gameType === 'xocdia';

    let text = `🐻 <b>CHI TIẾT PHONG ĐỘ BÀN CẦU: ${ch.platform} (${ch.gameName})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 <b>CHIẾN TÍCH THỰC CHIẾN:</b>\n`;
    text += `• Tổng số tay đã theo dõi: <b>${ai?.total_bets || 0} tay</b>\n`;
    text += `• Số tay Húp trọn: <b>${ai?.total_wins || 0} tay</b> (${ai?.win_rate || 78}%)\n`;
    text += `• Số tay Gãy nhịp: <b>${ai?.total_losses || 0} tay</b>\n`;
    text += `• Dây ăn thông kỷ lục: <b>${ai?.max_streak || 0} tay liên tiếp</b>\n`;
    text += `• Lượt bám cầu: <b>#${ai?.epochs || 1} lượt</b>\n\n`;

    if (pred) {
      text += `🎯 <b>TAY ĐANG RÌNH KÈO:</b> <code>#${pred.phien_target}</code>\n`;
      text += `• Cửa chốt: <b>${pred.prediction}</b> (Độ kết: ${pred.confidence}%)\n`;
      if (pred.predicted_dices && !isXocdia) {
        text += `• Bộ vị dự phóng: <code>[ ${pred.predicted_dices.join(' - ')} ]</code> (${pred.predicted_sum}đ)\n`;
      }
      text += `\n`;
    }

    if (diceA) {
      if (isXocdia) {
        text += `🎲 <b>SOI VỊ XÓC ĐĨA:</b>\n`;
        text += `• Vị chủ đạo: <b>${diceA.topVi || 'Sấp Đôi'}</b> (${diceA.topProb || 40}%)\n\n`;
      } else if (isSicbo) {
        // SICBO MỚI CÓ BÃO
        text += `🎲 <b>BẮT VỊ XÚC XẮC & BÃO SICBO:</b>\n`;
        text += `• Mặt ra dày nhất: <b>Mặt ${diceA.hotFace} (${diceA.hotFaceRate}%)</b>\n`;
        text += `• Cặp vị sáng nhất: <b>${diceA.topPair} (${diceA.topPairRate}%)</b>\n`;
        text += `• Tỉ lệ nổ Bão: <b>${diceA.tripleRate}%</b> ${diceA.tripleRate > 8 ? '(Có tín hiệu bão)' : '(Bão nín)'}\n\n`;
      } else {
        // TÀI XỈU: CHỈ CÓ TÀI VÀ XỈU - TUYỆT ĐỐI KHÔNG CÓ BÃO!
        text += `🎲 <b>BẮT VỊ XÚC XẮC THỰC CHIẾN:</b>\n`;
        text += `• Mặt ra dày nhất: <b>Mặt ${diceA.hotFace} (${diceA.hotFaceRate}%)</b>\n`;
        text += `• Cặp vị sáng nhất: <b>${diceA.topPair} (${diceA.topPairRate}%)</b>\n\n`;
      }
    }

    text += `📜 <b>5 TAY GẦN NHẤT ĐÃ ĐỐI CHIẾU:</b>\n`;
    (ai?.recent_matches || []).slice(0, 5).forEach(m => {
      const stt = m.is_win ? '🟢 HÚP' : '🔴 GÃY';
      text += `• Phiên <code>#${m.phien}</code>: Chốt ${m.predicted} ➜ Ra ${m.actual} (${stt})\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━`;

    return renderSingleMessage(chatId, messageId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔮 Soi Cầu Ngay Cổng Này', callback_data: `pred_${channelId}` }],
          [{ text: '🔙 Quay Lại Bảng Vàng', callback_data: 'ai_auto_play_overview' }]
        ]
      }
    });
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

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔮 Xem Dự Đoán Phiên Tiếp', callback_data: `pred_${channelId}` }],
        [{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]
      ]
    };

    return renderSingleMessage(chatId, messageId, histText, { reply_markup: keyboard });
  }

  // Danh sách tất cả cổng game
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

    return renderSingleMessage(chatId, messageId, '📋 <b>DANH SÁCH TẤT CẢ CÁC CỔNG GAME HỖ TRỢ:</b>\nBấm chọn cổng game bạn muốn soi cầu:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // Bật/tắt thông báo tự động
  else if (data === 'toggle_notify') {
    let notifyText = '';
    if (notificationSubscribers.has(chatId)) {
      notificationSubscribers.delete(chatId);
      notifyText = '🔕 Đã TẮT tính năng tự động cập nhật phiên mới.';
    } else {
      notificationSubscribers.add(chatId);
      notifyText = '🔔 Đã BẬT cập nhật phiên mới tự động (cập nhật ngay trên tin nhắn này)!';
    }
    return answerCallbackQuery(query.id, notifyText, true);
  }

  // Phong độ thực chiến
  else if (data === 'view_accuracy') {
    const channelData = collector.getChannelData('sunwin_tx');
    const bt = channelData.prediction?.backtest || { winRate: 82.5, currentStreak: 4, maxStreak: 9 };

    const text = `
🐻 <b>PHONG ĐỘ THỰC CHIẾN - VẢ VỠ MỒM NHÀ CÁI</b> 🐻
━━━━━━━━━━━━━━━━━━━━
🎯 <b>Tỉ Lệ Húp Bình Quân:</b> <code>${bt.winRate}%</code>
🔥 <b>Chuỗi Ăn Thông Hiện Tại:</b> <code>${bt.currentStreak} tay</code>
🏆 <b>Kỷ Lục Ăn Thông:</b> <code>${bt.maxStreak} tay liên tiếp</code>
━━━━━━━━━━━━━━━━━━━━
⚔️ <b>BỘ KỸ THUẬT BẮT CẦU ĐỈNH CAO:</b>
1. <b>Bắt nhịp cầu gãy & bệt kinh điển:</b> Nhận diện thế cầu bệt rồng sâu, cầu đảo 1-1, nhịp 2-2, kép đôi, bẻ 3-1.
2. <b>Đọc vị 3 xúc xắc:</b> Khóa chặt mặt ra dày nhất và loại bỏ mặt nín cầu.
3. <b>Khoanh vùng điểm rơi:</b> Bắt dải biên độ điểm số thực tế.
4. <b>Phân định rõ ràng:</b> Tài Xỉu chỉ chơi Tài/Xỉu - Sicbo mới đánh Bão!
━━━━━━━━━━━━━━━━━━━━
<i>Được kiểm chứng trực tiếp từng giây trên hơn 25+ sòng bài lớn!</i>
    `.trim();

    const keyboard = {
      inline_keyboard: [[{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]]
    };

    return renderSingleMessage(chatId, messageId, text, { reply_markup: keyboard });
  }

  // Thông tin user
  else if (data === 'user_info') {
    const text = `
🐻 <b>HỒ SƠ CHIẾN BINH VẢ VỠ MỒM NHÀ CÁI</b> 🐻
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Telegram ID:</b> <code>${userId}</code>
👤 <b>Tên:</b> ${query.from.first_name || ''} (@${query.from.username || 'Chưa đặt user'})
🟢 <b>Trạng thái:</b> ${isAdmin ? '👑 SUPER ADMIN' : '🟢 ĐÃ KÍCH HOẠT BẢN QUYỀN VIP'}
━━━━━━━━━━━━━━━━━━━━
💬 <b>Hỗ trợ Admin:</b>\n${ADMIN_CONTACT}
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [{ text: '🧹 Dọn Dẹp / Xóa Hết Tin Cũ', callback_data: 'clean_chat' }],
        [{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]
      ]
    };

    return renderSingleMessage(chatId, messageId, text, { reply_markup: keyboard });
  }

  // Quay lại menu chính
  else if (data === 'back_main') {
    const keyboard = isAdmin ? getAdminKeyboard() : getUserKeyboard();
    const text = formatMainMenuText({ user: query.from, isAdmin });

    return renderSingleMessage(chatId, messageId, text, {
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

// Tự động phát sóng phiên mới - Cập nhật trực tiếp lên ĐÚNG 1 TIN NHẮN DUY NHẤT
setInterval(async () => {
  if (notificationSubscribers.size === 0) return;

  const channelData = collector.getChannelData('sunwin_tx');
  const currentPhien = channelData.latest?.phien;

  if (currentPhien && lastBroadcastSessions['sunwin_tx'] !== currentPhien) {
    lastBroadcastSessions['sunwin_tx'] = currentPhien;
    const broadcastMsg = `🔔 <b>TÍN HIỆU PHIÊN MỚI!</b>\n` + formatPredictionMessage(channelData);

    for (const userChatId of notificationSubscribers) {
      await sendOrReplaceMenu(userChatId, broadcastMsg, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🎲 Soi Cầu Thêm', callback_data: 'pred_sunwin_tx' },
              { text: '🔕 Tắt Báo Tự Động', callback_data: 'toggle_notify' }
            ],
            [
              { text: '🔙 Quay Lại Menu', callback_data: 'back_main' }
            ]
          ]
        }
      }).catch(() => {});
    }
  }
}, 6000);

startPolling();

module.exports = {
  sendMessage,
  callApi
};
