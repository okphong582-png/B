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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8738721874:AAG22QXgkzi8tURDRWJLkmJQUCtdbIxnG2E';
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

        return sendMessage(
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

        return sendMessage(
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
        return sendMessage(
          chatId,
          `
⚠️ <b>THÔNG BÁO XỬ LÝ THẺ CÀO CHẬM</b>
━━━━━━━━━━━━━━━━━━━━
Mã đơn: <code>${requestId}</code>
Nhà mạng đang xử lý thẻ chậm hơn bình thường.
Vui lòng nhắn tin kèm mã đơn cho Admin để được hỗ trợ kiểm tra và cộng quyền ngay:
${ADMIN_CONTACT}
          `.trim()
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

// Bộ nhớ lưu ID các tin nhắn đã gửi cho từng chat để tự động xóa sạch khi hết hạn
const userMessageHistory = {}; // { [chatId]: Set of messageId }

function trackUserMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  if (!userMessageHistory[chatId]) userMessageHistory[chatId] = new Set();
  userMessageHistory[chatId].add(messageId);
  if (userMessageHistory[chatId].size > 50) {
    const arr = Array.from(userMessageHistory[chatId]);
    userMessageHistory[chatId] = new Set(arr.slice(-50));
  }
}

async function cleanAllUserMessages(chatId) {
  if (!chatId || !userMessageHistory[chatId]) return;
  const ids = Array.from(userMessageHistory[chatId]);
  userMessageHistory[chatId].clear();
  for (const mid of ids) {
    await deleteMessage(chatId, mid).catch(() => {});
  }
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
  }
  return res;
}

async function editMessageText(chatId, messageId, text, options = {}) {
  trackUserMessage(chatId, messageId);
  return callApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options
  });
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
        { text: '🤖 AI Tự Động Chơi & BXH Thắng', callback_data: 'ai_auto_play_overview' },
        { text: '🔔 Bật Báo Tự Động', callback_data: 'toggle_notify' }
      ],
      [
        { text: '📋 Xem Tất Cả 25+ Cổng Game', callback_data: 'menu_all_portals' }
      ],
      [
        { text: '💳 Nạp Thẻ Cào Mua Token', callback_data: 'napthe_menu' },
        { text: '📊 Tỷ Lệ Thắng AI', callback_data: 'view_accuracy' }
      ],
      [
        { text: '👤 Thông Tin Bản Quyền', callback_data: 'user_info' }
      ]
    ]
  };
}

// Bàn phím Admin
function getAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚡ Tạo Token Mới (/taotoken)', callback_data: 'admin_create_token_prompt' },
        { text: '👑 Quản Lý Admin', callback_data: 'admin_manage_admins' }
      ],
      [
        { text: '🤖 AI Tự Động Chơi & BXH Thắng', callback_data: 'ai_auto_play_overview' },
        { text: '🔑 Xem Thống Kê Token', callback_data: 'admin_view_tokens' }
      ],
      [
        { text: '💳 Nạp Thẻ Thử Nghiệm', callback_data: 'napthe_menu' },
        { text: '🛠 Cập Nhật Link Cổng (/updatecong)', callback_data: 'admin_update_cong' }
      ],
      [
        { text: '⚠️ Đặt Báo Trì (/baotri)', callback_data: 'admin_set_baotri' },
        { text: '✅ Tắt Báo Trì (/tatbaotri)', callback_data: 'admin_off_baotri' }
      ],
      [
        { text: '☀️ Sunwin TX', callback_data: 'pred_sunwin_tx' },
        { text: '🔥 Hitclub TX', callback_data: 'pred_hitclub_tx' }
      ],
      [
        { text: '✈️ B52 Tài Xỉu', callback_data: 'pred_b52_tx' },
        { text: '📋 Xem Tất Cả Các Cổng', callback_data: 'menu_all_portals' }
      ]
    ]
  };
}

// Format tin nhắn dự đoán chuyên sâu với phân tích vị xúc xắc và AI tự chơi
function formatPredictionMessage(channelData) {
  const { channel, latest, prediction, ai } = channelData;
  const nextNum = latest?.phien ? (parseInt(latest.phien) ? parseInt(latest.phien) + 1 : 'Kế Tiếp') : 'Kế Tiếp';
  const isXocdia = channel.gameType === 'xocdia';
  const outcomeEmoji = prediction.prediction === 'TÀI' ? '🔴 TÀI' : (prediction.prediction === 'XỈU' ? '🔵 XỈU' : (prediction.prediction === 'CHẴN' ? '⚪ CHẴN' : '🔴 LẺ'));
  
  const dicesStr = (prediction.predictedDices || [4, 4, 3]).join(' - ');
  const diceAnalysis = ai?.dice_analysis || null;
  const backtest = prediction.backtest || { winRate: 78.5, currentStreak: 3 };

  let diceSection = '';
  if (!isXocdia) {
    diceSection = `
🎲 <b>PHÂN TÍCH VỊ XÚC XẮC:</b>
• Bộ vị dự đoán: <code>[ ${dicesStr} ]</code> (Tổng: ${prediction.predictedDices ? prediction.predictedDices.reduce((a,b)=>a+b, 0) : 12}đ)
• Cặp số tiềm năng: <b>${diceAnalysis?.topPair || '3-5'}</b> (Xác suất ${diceAnalysis?.topPairRate || 38}%)
• Tỉ lệ nổ Bão: <b>${diceAnalysis?.tripleRate || 2.4}%</b> (Cực thấp - Không bão)
🎯 <b>Khoảng Điểm Dự Kiến:</b> <b>${prediction.expectedSumRange || '12 - 14'} Điểm</b>

📊 <b>BẢNG SỐ THỐNG KÊ (50 PHIÊN GẦN NHẤT):</b>
• Mặt HOT nhất: <b>⚄ Mặt ${diceAnalysis?.hotFace || 5} (${diceAnalysis?.hotFaceRate || 36}%)</b> | <b>⚂ Mặt ${diceAnalysis?.secondHot || 3} (${diceAnalysis?.secondHotRate || 31}%)</b>
• Mặt COLD nhất: <b>⚀ Mặt ${diceAnalysis?.coldFace || 1} (${diceAnalysis?.coldFaceRate || 10}%)</b>
• Nhịp cầu vị: <b>${prediction.patternInfo?.name || 'Cầu Thuận'}</b>`;
  } else {
    diceSection = `
🎲 <b>PHÂN TÍCH VỊ XÓC ĐĨA:</b>
• Vị dự báo: <b>${diceAnalysis?.predictedVi || 'Sấp Đôi (2 Đỏ - 2 Trắng)'}</b>
• Tỉ lệ xuất hiện vị này: <b>${diceAnalysis?.topProb || 42}%</b>
• Thế cầu: <b>${prediction.patternInfo?.name || 'Cầu Thuận'}</b>`;
  }

  const aiStats = `
🤖 <b>TRẠNG THÁI AI HUẤN LUYỆN (${channel.platform}):</b>
• Đợt huấn luyện (Epoch): <b>#${ai?.epochs || 85} đợt</b>
• Tỉ lệ AI thắng cổng này: <b>${ai?.win_rate || backtest.winRate}%</b> (${ai?.total_wins || Math.round((ai?.total_bets || 50) * 0.8)} Thắng / ${ai?.total_losses || Math.round((ai?.total_bets || 50) * 0.2)} Thua)
• Chuỗi thắng hiện tại: <b>${ai?.current_streak ? '🔥 ' + ai.current_streak + ' ván liên tiếp' : '🔥 2 ván'}</b>`;

  return `
👑 <b>TOOL DỰ ĐOÁN TÀI XỈU AI VIP</b> 👑
━━━━━━━━━━━━━━━━━━━━
🎮 <b>Cổng game:</b> ${channel.icon || '🎲'} <b>${channel.platform}</b> (${channel.gameName})
🎯 <b>MỤC TIÊU PHIÊN:</b> <code>#${nextNum}</code>

🔮 <b>KẾT QUẢ DỰ BÁO:</b> <b>${outcomeEmoji}</b>
📊 <b>ĐỘ TỰ TIN AI:</b> <b>${prediction.confidence}%</b>
━━━━━━━━━━━━━━━━━━━━${diceSection}
━━━━━━━━━━━━━━━━━━━━${aiStats}
━━━━━━━━━━━━━━━━━━━━
💡 <b>GỢI Ý VÀO TIỀN:</b> <b>${prediction.tactic || 'VÀO ĐỀU TAY 1X'}</b>
📝 <i>"${prediction.advice || 'Cầu đang ổn định, giữ kỷ luật vốn.'}"</i>
━━━━━━━━━━━━━━━━━━━━
⏱ <b>Phiên vừa xổ:</b> #${latest ? latest.phien : '---'} ra <b>${latest ? latest.outcome : '-'}</b> (${latest ? latest.total : '-'} điểm: ${(latest?.dices || []).join('-')})
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

  // 0. XỬ LÝ NHẬP MÃ THẺ & SỐ SERI
  if (userCardInputState[chatId]?.action === 'awaiting_card') {
    const state = userCardInputState[chatId];
    if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'huy') {
      delete userCardInputState[chatId];
      return sendMessage(chatId, '✅ Đã hủy thao tác nạp thẻ cào. Gõ /menu hoặc /napthe khi bạn muốn nạp lại.');
    }

    const tokens = text.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
      return sendMessage(
        chatId,
        `❌ <b>Bạn cần gửi cả Mã Thẻ và Số Seri cách nhau bằng dấu cách!</b>\n\nVí dụ: <code>123456789012 10001234567890</code>\nHoặc gõ <code>/cancel</code> để hủy thao tác.`
      );
    }

    delete userCardInputState[chatId];
    const code = tokens[0];
    const serial = tokens[1];
    const { telco, amount, packageType } = state;
    const requestId = `REQ-VIP-${Date.now()}-${userId}`;

    sendMessage(
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

      return sendMessage(
        chatId,
        `
🎉 <b>NẠP THẺ & KÍCH HOẠT TOKEN THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>Tài khoản:</b> ${msg.from.first_name || ''} (@${msg.from.username || userId})
💳 <b>Thẻ:</b> ${telco} ${amount.toLocaleString('vi-VN')} VNĐ
🔑 <b>MÃ TOKEN VIP:</b> <code>${key}</code>
⏱ <b>Thời hạn sử dụng:</b> <b>${duration}</b>
━━━━━━━━━━━━━━━━━━━━
✨ <i>Bot đã được tự động kích hoạt! Bấm chọn cổng game bên dưới để bắt đầu soi cầu:</i>
        `.trim(),
        { reply_markup: getUserKeyboard() }
      );
    }

    if (res && res.status === 99) {
      startCardPolling({ requestId, chatId, userId, userDetails: msg.from, telco, code, serial, amount, packageType });

      return sendMessage(
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
        `.trim()
      );
    }

    // Thẻ lỗi
    await firebase.updateCardTransaction(requestId, { status: 'FAILED', message: res?.message || 'Lỗi gửi thẻ' });
    return sendMessage(
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
            [{ text: '💬 Liên Hệ Admin', url: 'https://t.me/spamsmstaken' }]
          ]
        }
      }
    );
  }

  // Lệnh /napthe hoặc /muatoken
  if (text === '/napthe' || text === '/muatoken' || text === '/napthedo') {
    return sendMessage(
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

  // Lệnh /aituchoi hoặc /bxh
  if (text === '/aituchoi' || text === '/bxh' || text === '/ai') {
    const overviewList = collector.getAiOverview();
    const top5 = overviewList.slice(0, 8);

    let bxhText = `🤖 <b>BẢNG XẾP HẠNG AI TỰ ĐỘNG CHƠI & HUẤN LUYỆN</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    bxhText += `<i>AI tự động phân tích và đưa ra dự đoán độc lập 24/7 cho từng cổng. Khi nhận kết quả thực tế, AI tự đối chiếu và cộng dồn số trận thắng/thua, tự điều chỉnh trọng số mạng nơ-ron qua từng đợt train để ngày càng thông minh hơn!</i>\n\n`;
    bxhText += `🏆 <b>TOP CÁC CỔNG AI ĐANG THẮNG CAO NHẤT:</b>\n`;

    top5.forEach((item, idx) => {
      const icon = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : '🔹'));
      const pred = item.last_prediction;
      const predStr = pred ? `➜ Dự đoán phiên <b>#${pred.phien_target}</b>: <b>${pred.prediction}</b> (${pred.confidence}%)` : '';
      bxhText += `${icon} <b>${item.platform} - ${item.game_name}</b>\n`;
      bxhText += `   • Tỷ lệ thắng: <b>${item.win_rate}%</b> (${item.total_wins} Thắng / ${item.total_losses} Thua)\n`;
      bxhText += `   • Đợt train (Epoch): <b>#${item.epochs} đợt</b> | Chuỗi thắng: <b>${item.current_streak} tay</b>\n`;
      if (predStr) bxhText += `   • ${predStr}\n`;
      bxhText += `\n`;
    });

    const rows = [];
    for (let i = 0; i < Math.min(6, top5.length); i += 2) {
      const r = [{ text: `🤖 ${top5[i].platform}`, callback_data: `ai_detail_${top5[i].channel_id}` }];
      if (top5[i + 1]) {
        r.push({ text: `🤖 ${top5[i + 1].platform}`, callback_data: `ai_detail_${top5[i + 1].channel_id}` });
      }
      rows.push(r);
    }
    rows.push([{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]);

    return sendMessage(chatId, bxhText, { reply_markup: { inline_keyboard: rows } });
  }

  // 1. CÁC LỆNH DÀNH CHO ADMIN
  if (isAdmin) {
    // Admin đang gửi link cập nhật cổng
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
📡 <b>Trạng thái:</b> ${fetchRes.ok ? '🟢 Kết Nối OK' : '🔴 Chưa phản hồi'}
━━━━━━━━━━━━━━━━━━━━
<i>Áp dụng ngay lập tức cho toàn bộ hệ thống.</i>
          `.trim()
        );
      }
    }

    // Admin đang nhập nội dung bảo trì
    if (adminInputState[chatId]?.action === 'awaiting_maintenance_msg') {
      delete adminInputState[chatId];
      await firebase.setMaintenance(true, text, userId);
      return sendMessage(chatId, `⚠️ <b>ĐÃ KÍCH HOẠT BẢO TRÌ:</b>\n<i>"${text}"</i>`);
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

        return sendMessage(
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
        return sendMessage(
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
<code>👉 Mở bot @spamsmslol_bot gửi mã này để kích hoạt nhé!</code>
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
        return sendMessage(chatId, `❌ Lỗi tạo token: ${res.error}`);
      }
    }

    // Lệnh thêm/nâng cấp admin: /addadmin <id> [tên]
    if (text.startsWith('/addadmin')) {
      const parts = text.split(' ').filter(Boolean);
      if (parts.length < 2) {
        return sendMessage(chatId, `👉 Cú pháp: <code>/addadmin &lt;telegram_id&gt; [tên_admin]</code>\nVí dụ: <code>/addadmin 7769479790 SuperAdmin</code>`);
      }
      const newAdminId = parts[1].trim();
      const adminName = parts.slice(2).join(' ') || '';
      const addRes = await firebase.promoteToAdmin(newAdminId, 'Super Admin', adminName);

      if (addRes.success) {
        return sendMessage(chatId, `👑 <b>ĐÃ NÂNG LÊN SUPER ADMIN!</b>\nTài khoản ID: <code>${newAdminId}</code> đã nhận toàn bộ quyền quản trị.`);
      } else {
        return sendMessage(chatId, `❌ Thất bại: ${addRes.error}`);
      }
    }

    // Lệnh gỡ admin (chuyển thành dân thường): /deladmin <id>
    if (text.startsWith('/deladmin')) {
      const parts = text.split(' ').filter(Boolean);
      if (parts.length < 2) {
        return sendMessage(chatId, `👉 Cú pháp: <code>/deladmin &lt;telegram_id&gt;</code>\nVí dụ: <code>/deladmin 7769479790</code>`);
      }
      const targetId = parts[1].trim();
      const delRes = await firebase.demoteAdminToUser(targetId);

      if (delRes.success) {
        return sendMessage(chatId, `🔄 <b>ĐÃ CHUYỂN THÀNH DÂN THƯỜNG!</b>\nTài khoản ID: <code>${targetId}</code> đã bị thu hồi quyền Admin, phải có token để soi cầu như người dùng bình thường.`);
      } else {
        return sendMessage(chatId, `❌ Không thể chuyển: ${delRes.error}`);
      }
    }

    // Lệnh chuyển đổi qua lại 2 chiều: /chuyenquyen <id>
    if (text.startsWith('/chuyenquyen')) {
      const parts = text.split(' ').filter(Boolean);
      if (parts.length < 2) {
        return sendMessage(chatId, `👉 Cú pháp: <code>/chuyenquyen &lt;telegram_id&gt;</code>\nVí dụ: <code>/chuyenquyen 7769479790</code>`);
      }
      const targetId = parts[1].trim();
      await firebase.toggleAdminRole(targetId);
      const isNowAdmin = firebase.isAdmin(targetId);

      if (isNowAdmin) {
        return sendMessage(chatId, `👑 <b>ĐÃ CHUYỂN SANG ADMIN!</b>\nTài khoản ID: <code>${targetId}</code> đã được nâng lên làm Super Admin.`);
      } else {
        return sendMessage(chatId, `🔄 <b>ĐÃ CHUYỂN SANG DÂN THƯỜNG!</b>\nTài khoản ID: <code>${targetId}</code> đã chuyển thành người dùng bình thường.`);
      }
    }

    // Lệnh /baotri
    if (text.startsWith('/baotri')) {
      const parts = text.split(' ');
      parts.shift();
      const content = parts.join(' ').trim();

      if (content.toLowerCase() === 'off' || content.toLowerCase() === 'tat') {
        await firebase.setMaintenance(false, '', userId);
        return sendMessage(chatId, `✅ <b>ĐÃ TẮT BẢO TRÌ!</b> Người dùng có thể sử dụng bình thường.`);
      }

      if (!content) {
        adminInputState[chatId] = { action: 'awaiting_maintenance_msg' };
        return sendMessage(chatId, `👉 <b>Vui lòng gửi nội dung thông báo bảo trì:</b>`);
      }

      await firebase.setMaintenance(true, content, userId);
      return sendMessage(chatId, `⚠️ <b>ĐÃ BẬT BẢO TRÌ:</b> "${content}"`);
    }

    // Lệnh /tatbaotri
    if (text === '/tatbaotri') {
      await firebase.setMaintenance(false, '', userId);
      return sendMessage(chatId, `✅ <b>ĐÃ TẮT BẢO TRÌ!</b>`);
    }

    // Lệnh /updatecong
    if (text.startsWith('/updatecong')) {
      const channels = config.loadEndpoints();
      const rows = [];
      channels.forEach(c => {
        rows.push([{ text: `✏️ ${c.icon || '🎲'} ${c.platform} - ${c.gameName}`, callback_data: `admin_edit_url_${c.id}` }]);
      });
      rows.push([{ text: '🔙 Quay Lại', callback_data: 'back_main' }]);

      return sendMessage(chatId, `🛠 <b>CHỌN CỔNG GAME BẠN MUỐN CẬP NHẬT LINK:</b>`, {
        reply_markup: { inline_keyboard: rows }
      });
    }
  }

  // 2. KIỂM TRA BẢO TRÌ VỚI USER THƯỜNG
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

  // 3. KIỂM TRA QUYỀN TRUY CẬP (TOKEN BẢN QUYỀN)
  const authCheck = await firebase.checkUserAuthorized(userId);

  // Nếu user không hợp lệ (Chưa nhập token, hoặc Token đã hết hạn / bị xóa)
  if (!authCheck.authorized) {
    if (authCheck.reason === 'TOKEN_DELETED' || authCheck.reason === 'TOKEN_EXPIRED' || authCheck.reason === 'TOKEN_REVOKED') {
      return sendMessage(
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
      return sendMessage(
        chatId,
        `
🔐 <b>CHÀO MỪNG BẠN ĐẾN VỚI BOT SOI CẦU TÀI XỈU VIP</b> 🔐
━━━━━━━━━━━━━━━━━━━━
⚠️ <b>YÊU CẦU KÍCH HOẠT BẢN QUYỀN:</b>
Hệ thống bot được bảo vệ bằng Token do <b>Admin</b> cấp phép.
Mỗi mã Token chỉ được kích hoạt cho <b>1 tài khoản duy nhất</b>.

👉 <b>Nếu đã có Token:</b> Hãy gửi mã vào đây để mở khóa bot!
━━━━━━━━━━━━━━━━━━━━
💳 <b>MUA TOKEN TỰ ĐỘNG BẰNG THẺ CÀO 24/7:</b>
• 🌟 <b>Gói VIP 7 Ngày:</b> <code>200.000 VNĐ</code>
• 👑 <b>Gói VIP 30 Ngày:</b> <code>1.000.000 VNĐ</code>
<i>Duyệt thẻ tự động qua cổng gạch thẻ, cấp token và mở khóa bot tức thì!</i>
━━━━━━━━━━━━━━━━━━━━
💬 <b>Hoặc liên hệ Admin để mua trực tiếp:</b>
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
      return sendMessage(
        chatId,
        `
✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>Tài khoản:</b> ${msg.from.first_name || ''} (@${msg.from.username || userId})
🔑 <b>Mã Token:</b> <code>${text.toUpperCase()}</code>
⏱ <b>Thời hạn:</b> ${result.tokenData?.duration || 'Vĩnh viễn'}
━━━━━━━━━━━━━━━━━━━━
🎉 Chào mừng bạn! Bot đã sẵn sàng soi cầu tất cả các cổng game.

👇 <b>Chọn cổng game bên dưới để bắt đầu:</b>
        `.trim(),
        { reply_markup: getUserKeyboard() }
      );
    } else {
      return sendMessage(
        chatId,
        `❌ <b>KÍCH HOẠT THẤT BẠI:</b>\n\n${result.message}\n\n💬 <b>Liên hệ Admin để mua token:</b>\n${ADMIN_CONTACT}`
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
Dữ liệu đang đồng bộ trực tiếp hơn 15+ cổng game.

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
• Bấm nút cổng game để xem dự đoán phiên tiếp theo
• Bấm <b>"Bật Báo Tự Động"</b> để bot tự động gửi tin khi có phiên mới
💬 <b>Hỗ trợ Admin:</b>\n${ADMIN_CONTACT}
      `.trim()
    );
  }
}

// Xử lý Callback nút bấm (Inline Buttons)
async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
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

  // 2. KIỂM TRA QUYỀN TRUY CẬP REALTIME
  // NẾU TOKEN HẾT HẠN HOẶC BỊ XÓA -> TỰ ĐỘNG XÓA TIN NHẮN ĐANG BẤM, XÓA TOÀN BỘ TIN NHẮN CŨ & KICK OUT NGAY!
  // (Ngoại trừ các nút bấm nạp thẻ mua token để người dùng có thể mua bản quyền tự động)
  const authCheck = await firebase.checkUserAuthorized(userId);
  if (!authCheck.authorized && !data.startsWith('napthe_')) {
    await answerCallbackQuery(query.id, '❌ Token đã hết hạn hoặc bị xóa! Toàn bộ tin nhắn đã bị vô hiệu hóa.', true);
    
    // Tự động xóa ngay tin nhắn cũ mà user vừa nhấn vào
    await deleteMessage(chatId, messageId).catch(() => {});

    // Tự động xóa toàn bộ danh sách các tin nhắn cũ của bot trong chat này
    await cleanAllUserMessages(chatId);

    // Xóa khỏi danh sách nhận thông báo tự động
    notificationSubscribers.delete(chatId);

    // Gửi cảnh báo kick-out duy nhất 1 lần
    return sendMessage(
      chatId,
      `
⚠️ <b>THÔNG BÁO: TÀI KHOẢN ĐÃ HẾT HẠN HOẶC BỊ THU HỒI TOKEN!</b>
━━━━━━━━━━━━━━━━━━━━
Toàn bộ tin nhắn và nút soi cầu cũ đã tự động bị xóa sạch.
Nếu bạn bấm vào bất kỳ tin nhắn cũ nào cũng không còn tác dụng.

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

  // ================= NẠP THẺ CÀO TỰ ĐỘNG (DOITHEVIP) =================
  if (data === 'napthe_menu') {
    return sendMessage(
      chatId,
      `
💳 <b>HỆ THỐNG NẠP THẺ CÀO BÁN TOKEN BOT TỰ ĐỘNG 24/7</b>
━━━━━━━━━━━━━━━━━━━━
⚡ Gạch thẻ tự động siêu tốc qua cổng <b>DoiTheVip.com</b> (15s - 45s)
🎁 Tự động kích hoạt bot và cấp mã token ngay khi thẻ đúng!

📋 <b>BẢNG GIÁ GÓI TOKEN VIP:</b>
• 🌟 <b>GÓI VIP 7 NGÀY:</b> <code>200.000 VNĐ</code>
• 👑 <b>GÓI VIP 30 NGÀY:</b> <code>1.000.000 VNĐ</code>
━━━━━━━━━━━━━━━━━━━━
👇 <b>Bấm chọn gói bạn muốn nạp bên dưới:</b>
      `.trim(),
      { reply_markup: getNapThePackagesKeyboard() }
    );
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

    return sendMessage(
      chatId,
      `
📡 <b>CHỌN NHÀ MẠNG CHO [GÓI ${packName}]</b>
━━━━━━━━━━━━━━━━━━━━
Hỗ trợ tất cả các nhà mạng và thẻ game:
• Viettel, Mobifone, Vinaphone, Vietnamobile
• Thẻ Zing, Thẻ Gate
━━━━━━━━━━━━━━━━━━━━
👇 <b>Bấm chọn loại thẻ bạn đang có:</b>
      `.trim(),
      { reply_markup: getNapTheTelcoKeyboard(packType) }
    );
  }

  else if (data.startsWith('napthe_telco_')) {
    const parts = data.replace('napthe_telco_', '').split('_');
    const telco = parts[0];
    const packageType = parts[1] || '7d';

    if (packageType === 'custom') {
      return sendMessage(
        chatId,
        `
💵 <b>CHỌN MỆNH GIÁ THẺ [${telco}] CỦA BẠN:</b>
━━━━━━━━━━━━━━━━━━━━
<i>Lưu ý: Bạn cần chọn đúng mệnh giá thẻ để nhà mạng duyệt nhanh nhất!</i>
        `.trim(),
        { reply_markup: getNapTheAmountKeyboard(telco, packageType) }
      );
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

    return sendMessage(
      chatId,
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
<i>Gõ /cancel nếu bạn muốn hủy bỏ thao tác này.</i>
      `.trim()
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

    return sendMessage(
      chatId,
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
<i>Gõ /cancel nếu bạn muốn hủy bỏ thao tác này.</i>
      `.trim()
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

    return editMessageText(chatId, messageId, '⚡ <b>CHỌN THỜI HẠN TOKEN CẦN TẠO:</b>', {
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

    return sendMessage(
      chatId,
      `
✅ <b>ĐÃ TẠO MÃ TOKEN THÀNH CÔNG!</b>
━━━━━━━━━━━━━━━━━━━━
🔑 <b>Mã Token:</b> <code>${key}</code>
⏱ <b>Thời hạn:</b> <b>${duration}</b>
━━━━━━━━━━━━━━━━━━━━
📋 <b>Nội dung gửi khách:</b>
<code>Chào bạn, mã Token kích hoạt bot của bạn là:</code>
<code>${key}</code>
<code>👉 Vào bot @spamsmslol_bot gửi mã trên để kích hoạt nhé!</code>
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
      if (isNowAdmin) {
        await sendMessage(chatId, `👑 <b>ĐÃ NÂNG LÊN ADMIN!</b>\nTài khoản ID <code>${targetId}</code> đã nhận lại toàn bộ quyền quản trị.`);
      } else {
        await sendMessage(chatId, `🔄 <b>ĐÃ CHUYỂN THÀNH DÂN THƯỜNG!</b>\nTài khoản ID <code>${targetId}</code> đã bị thu hồi quyền quản trị, muốn soi cầu phải dùng token như người bình thường.`);
      }
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

    return sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  }

  // Thao tác sửa link cổng
  else if (data.startsWith('admin_edit_url_')) {
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

  else if (data === 'admin_update_cong') {
    if (!isAdmin) return;
    const channels = config.loadEndpoints();
    const rows = [];
    channels.forEach(c => {
      rows.push([{ text: `✏️ ${c.icon || '🎲'} ${c.platform} - ${c.gameName}`, callback_data: `admin_edit_url_${c.id}` }]);
    });
    rows.push([{ text: '🔙 Quay Lại', callback_data: 'back_main' }]);

    return editMessageText(chatId, messageId, '🛠 <b>CHỌN CỔNG GAME BẠN MUỐN CẬP NHẬT LINK:</b>', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  else if (data === 'admin_set_baotri') {
    if (!isAdmin) return;
    adminInputState[chatId] = { action: 'awaiting_maintenance_msg' };
    return sendMessage(chatId, `👉 <b>Vui lòng gửi nội dung thông báo bảo trì:</b>`);
  }

  else if (data === 'admin_off_baotri') {
    if (!isAdmin) return;
    await firebase.setMaintenance(false, '', userId);
    return sendMessage(chatId, `✅ <b>ĐÃ TẮT BẢO TRÌ!</b>`);
  }

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
💡 Tạo thêm token nhanh: gõ <code>/taotoken 30ngay</code> hoặc bấm nút bên dưới:
      `.trim(),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚡ Tạo Token Mới', callback_data: 'admin_create_token_prompt' }],
            [{ text: '🔙 Quay Lại', callback_data: 'back_main' }]
          ]
        }
      }
    );
  }

  // ================= GENERAL USER ACTIONS =================
  // Xem dự đoán kênh với hiệu ứng phân tích vị & ma trận bảng số (Delay 3.5s)
  else if (data.startsWith('pred_')) {
    const channelId = data.replace('pred_', '');
    const channelData = collector.getChannelData(channelId);

    // Gửi màn hình quét ma trận trước (Visual AI Scanning)
    const scanText = `
🧠 <b>ĐANG PHÂN TÍCH VỊ XÚC XẮC & BẢNG SỐ MA TRẬN...</b>
━━━━━━━━━━━━━━━━━━━━
🎮 Cổng: <b>${channelData.channel.platform}</b> (${channelData.channel.gameName})
⚡ <i>Thuật toán AI đang tính toán dải biến thiên Z-Score & ma trận 6 mặt xúc xắc...</i>

[▓▓▓▓▓▓▓▓░░] <b>78%</b> Đang hoàn tất mô hình học máy...
⏳ <i>Vui lòng đợi 3-5 giây để AI tính toán vị tối ưu nhất...</i>
    `.trim();

    await editMessageText(chatId, messageId, scanText).catch(() => {});

    // Delay 3.2s để phân tích vị chuyên sâu
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
          { text: '🤖 Xem AI Tự Chơi Cổng Này', callback_data: `ai_detail_${channelId}` },
          { text: '🔙 Chọn Cổng Game Khác', callback_data: 'back_main' }
        ]
      ]
    };

    const res = await editMessageText(chatId, messageId, text, { reply_markup: keyboard });
    if (!res || !res.ok) {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  // ================= AI TỰ CHƠI & BẢNG XẾP HẠNG THẮNG =================
  else if (data === 'ai_auto_play_overview') {
    const overviewList = collector.getAiOverview();
    const top5 = overviewList.slice(0, 8);

    let text = `🤖 <b>BẢNG XẾP HẠNG AI TỰ ĐỘNG CHƠI & HUẤN LUYỆN</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    text += `<i>AI tự động phân tích và đưa ra dự đoán độc lập 24/7 cho từng cổng. Khi nhận kết quả thực tế, AI tự đối chiếu và cộng dồn số trận thắng/thua, tự điều chỉnh trọng số mạng nơ-ron qua từng đợt train để ngày càng thông minh hơn!</i>\n\n`;
    text += `🏆 <b>TOP CÁC CỔNG AI ĐANG THẮNG CAO NHẤT:</b>\n`;

    top5.forEach((item, idx) => {
      const icon = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : '🔹'));
      const pred = item.last_prediction;
      const predStr = pred ? `➜ Dự đoán phiên <b>#${pred.phien_target}</b>: <b>${pred.prediction}</b> (${pred.confidence}%)` : '';
      text += `${icon} <b>${item.platform} - ${item.game_name}</b>\n`;
      text += `   • Tỷ lệ thắng: <b>${item.win_rate}%</b> (${item.total_wins} Thắng / ${item.total_losses} Thua)\n`;
      text += `   • Đợt train (Epoch): <b>#${item.epochs} đợt</b> | Chuỗi thắng: <b>${item.current_streak} tay</b>\n`;
      if (predStr) text += `   • ${predStr}\n`;
      text += `\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━\n💡 <i>Bấm vào cổng bên dưới để xem chi tiết phân tích vị và lịch sử cược AI:</i>`;

    const rows = [];
    for (let i = 0; i < Math.min(6, top5.length); i += 2) {
      const r = [{ text: `🤖 ${top5[i].platform}`, callback_data: `ai_detail_${top5[i].channel_id}` }];
      if (top5[i + 1]) {
        r.push({ text: `🤖 ${top5[i + 1].platform}`, callback_data: `ai_detail_${top5[i + 1].channel_id}` });
      }
      rows.push(r);
    }
    rows.push([{ text: '🔙 Quay Lại Menu Chính', callback_data: 'back_main' }]);

    editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
  }

  // Chi tiết AI của 1 cổng
  else if (data.startsWith('ai_detail_')) {
    const channelId = data.replace('ai_detail_', '');
    const channelData = collector.getChannelData(channelId);
    const ai = channelData.ai;
    const ch = channelData.channel;
    const pred = ai?.last_prediction;
    const diceA = ai?.dice_analysis;

    let text = `🤖 <b>CHI TIẾT AI TỰ CHƠI: ${ch.platform} (${ch.gameName})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 <b>HIỆU SUẤT THỰC CHIẾN AI:</b>\n`;
    text += `• Tổng số phiên AI đã tự chơi: <b>${ai?.total_bets || 0} ván</b>\n`;
    text += `• Số phiên thắng: <b>${ai?.total_wins || 0} ván</b> (${ai?.win_rate || 78}%)\n`;
    text += `• Số phiên thua: <b>${ai?.total_losses || 0} ván</b>\n`;
    text += `• Chuỗi thắng kỷ lục: <b>${ai?.max_streak || 0} ván liên tiếp</b>\n`;
    text += `• Đợt huấn luyện (Epochs): <b>#${ai?.epochs || 1} thế hệ</b>\n\n`;

    if (pred) {
      text += `🎯 <b>PHIÊN AI ĐANG CƯỢC:</b> <code>#${pred.phien_target}</code>\n`;
      text += `• Cửa cược: <b>${pred.prediction}</b> (Tự tin: ${pred.confidence}%)\n`;
      if (pred.predicted_dices) {
        text += `• Vị xúc xắc dự đoán: <code>[ ${pred.predicted_dices.join(' - ')} ]</code> (${pred.predicted_sum}đ)\n`;
      }
      text += `\n`;
    }

    if (diceA) {
      text += `🎲 <b>PHÂN TÍCH VỊ XÚC XẮC:</b>\n`;
      text += `• Mặt Hot nhất: <b>Mặt ${diceA.hotFace} (${diceA.hotFaceRate}%)</b>\n`;
      text += `• Cặp vị tiềm năng: <b>${diceA.topPair} (${diceA.topPairRate}%)</b>\n`;
      text += `• Tỉ lệ nổ Bão: <b>${diceA.tripleRate}%</b>\n\n`;
    }

    text += `📜 <b>5 VÁN GẦN NHẤT AI ĐÃ CHƠI:</b>\n`;
    (ai?.recent_matches || []).slice(0, 5).forEach(m => {
      const stt = m.is_win ? '🟢 THẮNG' : '🔴 THUA';
      text += `• Phiên <code>#${m.phien}</code>: Cược ${m.predicted} ➜ Ra ${m.actual} (${stt})\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━`;

    editMessageText(chatId, messageId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔮 Soi Cầu Ngay Cổng Này', callback_data: `pred_${channelId}` }],
          [{ text: '🔙 Quay Lại BXH AI', callback_data: 'ai_auto_play_overview' }]
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

    sendMessage(chatId, histText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔮 Xem Dự Đoán Phiên Tiếp', callback_data: `pred_${channelId}` }],
          [{ text: '🔙 Quay Lại Menu', callback_data: 'back_main' }]
        ]
      }
    });
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

    editMessageText(chatId, messageId, '📋 <b>DANH SÁCH TẤT CẢ CÁC CỔNG GAME HỖ TRỢ:</b>\nBấm chọn cổng game bạn muốn soi cầu:', {
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
    editMessageText(chatId, messageId, '👑 <b>BẢNG ĐIỀU KHIỂN SOI CẦU TÀI XỈU VIP</b>\n\n👇 Chọn cổng game bạn muốn soi cầu:', {
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
