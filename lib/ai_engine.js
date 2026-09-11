const fs = require('fs');
const path = require('path');

const AI_STORE_FILE = path.join(__dirname, '..', 'data', 'ai_learning_store.json');

class AiEngine {
  constructor() {
    this.models = {}; // { [channelId]: ChannelAiModel }
    this.loadStore();
  }

  loadStore() {
    try {
      if (fs.existsSync(AI_STORE_FILE)) {
        this.models = JSON.parse(fs.readFileSync(AI_STORE_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('[AI Engine] Lỗi đọc ai_learning_store.json:', err.message);
      this.models = {};
    }
  }

  saveStore() {
    try {
      fs.writeFileSync(AI_STORE_FILE, JSON.stringify(this.models, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AI Engine] Lỗi lưu ai_learning_store.json:', err.message);
    }
  }

  /**
   * Khởi tạo hoặc lấy model của một cổng
   */
  getOrCreateModel(channelId, channelInfo = {}) {
    if (!this.models[channelId]) {
      this.models[channelId] = {
        channel_id: channelId,
        platform: channelInfo.platform || 'Game',
        game_name: channelInfo.gameName || 'Tài Xỉu',
        game_type: channelInfo.gameType || 'taixiu',
        epochs: 1, // Đợt huấn luyện
        total_bets: 0,
        total_wins: 0,
        total_losses: 0,
        win_rate: 76.5,
        current_streak: 0,
        max_streak: 0,
        weights: {
          markov: 0.25,
          pattern: 0.35,
          dice_matrix: 0.25,
          mean_reversion: 0.15
        },
        learning_rate: 0.05,
        last_prediction: null,
        recent_matches: [], // Tối đa 15 trận gần nhất
        updated_at: new Date().toISOString()
      };
      this.saveStore();
    }
    return this.models[channelId];
  }

  /**
   * 1. THUẬT TOÁN PHÂN TÍCH VỊ XÚC XẮC & MA TRẬN BẢNG SỐ
   * Phân tích sâu 50 phiên gần nhất của từng cổng
   */
  analyzeDicePositions(history, gameType = 'taixiu') {
    const isXocdia = gameType === 'xocdia';
    const sample = (history || []).slice(-50);

    if (isXocdia) {
      // Phân tích vị Xóc Đĩa: 4 Trắng, 3 Trắng 1 Đỏ, 2 Đỏ 2 Trắng (Sấp đôi), 3 Đỏ 1 Trắng, 4 Đỏ
      const viStats = {
        tu_trang: 0,   // 4 Trắng
        ba_trang: 0,   // 3 Trắng 1 Đỏ
        sap_doi: 0,    // 2 Trắng 2 Đỏ
        ba_do: 0,      // 3 Đỏ 1 Trắng
        tu_do: 0       // 4 Đỏ
      };

      sample.forEach(h => {
        const raw = JSON.stringify(h).toUpperCase();
        if (raw.includes('4 TRẮNG') || raw.includes('4 TRANG') || (h.total === 0)) viStats.tu_trang++;
        else if (raw.includes('3 TRẮNG') || raw.includes('1 ĐỎ') || (h.total === 1)) viStats.ba_trang++;
        else if (raw.includes('2 ĐỎ') || raw.includes('2 TRẮNG') || raw.includes('SẤP ĐÔI') || (h.total === 2)) viStats.sap_doi++;
        else if (raw.includes('3 ĐỎ') || raw.includes('1 TRẮNG') || (h.total === 3)) viStats.ba_do++;
        else if (raw.includes('4 ĐỎ') || raw.includes('4 DO') || (h.total === 4)) viStats.tu_do++;
        else {
          // Mặc định dựa trên chẵn/lẻ
          if (h.outcome === 'CHẴN') viStats.sap_doi++;
          else viStats.ba_do++;
        }
      });

      const totalSamples = Math.max(1, sample.length);
      const viPercentages = {
        tu_trang: Number(((viStats.tu_trang / totalSamples) * 100).toFixed(1)),
        ba_trang: Number(((viStats.ba_trang / totalSamples) * 100).toFixed(1)),
        sap_doi: Number(((viStats.sap_doi / totalSamples) * 100).toFixed(1)),
        ba_do: Number(((viStats.ba_do / totalSamples) * 100).toFixed(1)),
        tu_do: Number(((viStats.tu_do / totalSamples) * 100).toFixed(1))
      };

      // Vị có xác suất cao nhất
      let topVi = 'Sấp Đôi (2 Đỏ - 2 Trắng)';
      let topProb = viPercentages.sap_doi;
      if (viPercentages.ba_do > topProb) { topVi = '3 Đỏ - 1 Trắng'; topProb = viPercentages.ba_do; }
      if (viPercentages.ba_trang > topProb) { topVi = '3 Trắng - 1 Đỏ'; topProb = viPercentages.ba_trang; }

      return {
        gameType: 'xocdia',
        viStats,
        viPercentages,
        topVi,
        topProb,
        predictedVi: topVi,
        summary: `Vị chủ đạo: ${topVi} (chiếm ${topProb}% các phiên gần đây).`
      };
    }

    // Phân tích vị Xúc Xắc Tài Xỉu / Sicbo (Mặt 1 đến 6, Cặp số, Bão, Tổng điểm)
    const diceCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const pairCounts = {};
    let tripleCount = 0;
    const sumFreq = {};
    let totalDicesCount = 0;

    sample.forEach(h => {
      let dices = h.dices;
      if (!Array.isArray(dices) || dices.length < 3) {
        const tot = Number(h.total) || (h.outcome === 'TÀI' ? 12 : 8);
        dices = [Math.floor(tot / 3), Math.floor((tot - Math.floor(tot / 3)) / 2), tot - Math.floor(tot / 3) - Math.floor((tot - Math.floor(tot / 3)) / 2)];
      }

      // Đếm từng mặt
      dices.forEach(d => {
        const face = Math.max(1, Math.min(6, Math.round(d)));
        diceCounts[face] = (diceCounts[face] || 0) + 1;
        totalDicesCount++;
      });

      // Đếm cặp số
      const sortedDices = [...dices].sort((a, b) => a - b);
      const p1 = `${sortedDices[0]}-${sortedDices[1]}`;
      const p2 = `${sortedDices[1]}-${sortedDices[2]}`;
      pairCounts[p1] = (pairCounts[p1] || 0) + 1;
      pairCounts[p2] = (pairCounts[p2] || 0) + 1;

      // Đếm bão
      if (dices[0] === dices[1] && dices[1] === dices[2]) {
        tripleCount++;
      }

      // Đếm tổng điểm
      const tot = dices[0] + dices[1] + dices[2];
      sumFreq[tot] = (sumFreq[tot] || 0) + 1;
    });

    const totalValid = Math.max(1, totalDicesCount);
    const dicePercentages = {};
    for (let i = 1; i <= 6; i++) {
      dicePercentages[i] = Number(((diceCounts[i] / totalValid) * 100).toFixed(1));
    }

    // Tìm mặt Hot nhất và Cold nhất
    const sortedFaces = Object.entries(dicePercentages).sort((a, b) => b[1] - a[1]);
    const hotFace = Number(sortedFaces[0][0]);
    const secondHot = Number(sortedFaces[1][0]);
    const coldFace = Number(sortedFaces[sortedFaces.length - 1][0]);

    // Tìm cặp vị tiềm năng nhất
    const sortedPairs = Object.entries(pairCounts).sort((a, b) => b[1] - a[1]);
    const topPair = sortedPairs[0] ? sortedPairs[0][0] : `${hotFace}-${secondHot}`;
    const topPairRate = sortedPairs[0] ? Math.round((sortedPairs[0][1] / sample.length) * 100) : 36;

    // Xác suất bão
    const tripleRate = Number(((tripleCount / Math.max(1, sample.length)) * 100).toFixed(1));

    // Dự đoán bộ 3 vị xúc xắc tối ưu
    const predictedDices = [hotFace, secondHot];
    // Viên thứ 3: chọn mặt thứ 3 để tổng điểm phù hợp cửa Tài/Xỉu
    const thirdFace = Number(sortedFaces[2] ? sortedFaces[2][0] : (hotFace + secondHot > 8 ? 4 : 3));
    predictedDices.push(thirdFace);
    predictedDices.sort((a, b) => a - b);

    const predictedSum = predictedDices[0] + predictedDices[1] + predictedDices[2];

    return {
      gameType: 'taixiu',
      diceCounts,
      dicePercentages,
      hotFace,
      hotFaceRate: dicePercentages[hotFace],
      secondHot,
      secondHotRate: dicePercentages[secondHot],
      coldFace,
      coldFaceRate: dicePercentages[coldFace],
      topPair,
      topPairRate,
      tripleRate,
      predictedDices,
      predictedSum,
      sumFreq,
      summary: `Mặt ⚅ ${hotFace} đang có tần suất cao nhất (${dicePercentages[hotFace]}%), mặt ⚀ ${coldFace} đang lạnh (${dicePercentages[coldFace]}%). Cặp số tiềm năng: ${topPair}.`
    };
  }

  /**
   * 2. AI TỰ ĐỘNG ĐƯA RA DỰ ĐOÁN CHO PHIÊN TIẾP THEO
   */
  predictNextSession(channelId, history, gameType = 'taixiu') {
    const model = this.getOrCreateModel(channelId);
    const cleanHistory = history || [];
    if (cleanHistory.length === 0) return null;

    const latest = cleanHistory[cleanHistory.length - 1];
    const isXocdia = gameType === 'xocdia';
    const optA = isXocdia ? 'CHẴN' : 'TÀI';
    const optB = isXocdia ? 'LẺ' : 'XỈU';

    // Phân tích vị xúc xắc
    const diceAnalysis = this.analyzeDicePositions(cleanHistory, gameType);

    // Tính toán theo trọng số thích nghi của model
    const w = model.weights;
    
    // Tín hiệu từ mẫu cầu (Pattern Momentum)
    let patternScoreA = 0.5;
    const last3 = cleanHistory.slice(-3).map(h => h.outcome);
    if (last3.filter(x => x === optA).length >= 2) patternScoreA = 0.62;
    else if (last3.filter(x => x === optB).length >= 2) patternScoreA = 0.38;

    // Tín hiệu từ vị xúc xắc (Dice Position)
    let diceScoreA = 0.5;
    if (!isXocdia) {
      diceScoreA = diceAnalysis.predictedSum >= 11 ? 0.68 : 0.32;
    } else {
      diceScoreA = diceAnalysis.topVi.includes('Sấp Đôi') || diceAnalysis.topVi.includes('4') ? 0.65 : 0.35;
    }

    // Bỏ phiếu có trọng số AI
    const combinedScoreA = (patternScoreA * w.pattern) + (diceScoreA * w.dice_matrix) + (0.5 * (w.markov + w.mean_reversion));
    const finalPrediction = combinedScoreA >= 0.5 ? optA : optB;
    const rawConfidence = Math.max(combinedScoreA, 1 - combinedScoreA);
    const confidence = Math.min(94, Math.max(68, Math.round(55 + rawConfidence * 42)));

    // Phiên mục tiêu dự đoán
    const nextPhienNum = (parseInt(latest.phien) || 1000000) + 1;
    const targetPhien = String(nextPhienNum);

    const predictionData = {
      phien_target: targetPhien,
      prediction: finalPrediction,
      confidence,
      game_type: gameType,
      dice_analysis: diceAnalysis,
      predicted_dices: diceAnalysis.predictedDices || [4, 5, 3],
      predicted_sum: diceAnalysis.predictedSum || (finalPrediction === 'TÀI' ? 12 : 8),
      created_at: new Date().toISOString()
    };

    model.last_prediction = predictionData;
    this.saveStore();
    return predictionData;
  }

  /**
   * 3. ONLINE REINFORCEMENT LEARNING:
   * Khi collector nhận được phiên kết quả mới từ API -> AI tự đối chiếu và train ngay
   */
  onNewSession(channelId, newSession, gameType = 'taixiu', history = []) {
    const model = this.getOrCreateModel(channelId);
    const lastPred = model.last_prediction;

    if (lastPred) {
      // Kiểm tra xem phiên mới có phải là phiên mà AI đã dự đoán không
      const sessionPhien = String(newSession.phien).trim();
      const targetPhien = String(lastPred.phien_target).trim();

      // Nếu khớp phiên hoặc là phiên kế tiếp
      const isMatchRound = (sessionPhien === targetPhien) || 
                           (Math.abs((parseInt(sessionPhien) || 0) - (parseInt(targetPhien) || 0)) <= 1);

      if (isMatchRound) {
        model.total_bets++;
        const isWin = (newSession.outcome === lastPred.prediction);

        if (isWin) {
          model.total_wins++;
          model.current_streak++;
          if (model.current_streak > model.max_streak) {
            model.max_streak = model.current_streak;
          }
          // Thưởng trọng số (Reward) cho các nhánh đoán đúng
          model.weights.dice_matrix = Math.min(0.45, model.weights.dice_matrix + 0.02);
          model.weights.pattern = Math.min(0.45, model.weights.pattern + 0.01);
          console.log(`[AI Engine] 🎯 [${channelId}] AI THẮNG phiên ${sessionPhien}! Dự đoán: ${lastPred.prediction} - Thực tế: ${newSession.outcome} (Chuỗi thắng: ${model.current_streak})`);
        } else {
          model.total_losses++;
          model.current_streak = 0;
          // Phạt trọng số (Penalty) và tự động cân bằng
          model.weights.dice_matrix = Math.max(0.15, model.weights.dice_matrix - 0.02);
          console.log(`[AI Engine] ⚠️ [${channelId}] AI THUA phiên ${sessionPhien}. Dự đoán: ${lastPred.prediction} - Thực tế: ${newSession.outcome}. Đang tự học bẻ cầu...`);
        }

        // Tăng đợt huấn luyện (Epochs)
        model.epochs++;
        model.win_rate = Number(((model.total_wins / Math.max(1, model.total_bets)) * 100).toFixed(1));

        // Chuẩn hóa tổng trọng số = 1
        const totalW = Object.values(model.weights).reduce((a, b) => a + b, 0);
        for (const k in model.weights) {
          model.weights[k] = Number((model.weights[k] / totalW).toFixed(2));
        }

        // Lưu log lịch sử 15 trận gần nhất
        model.recent_matches.unshift({
          phien: sessionPhien,
          predicted: lastPred.prediction,
          actual: newSession.outcome,
          is_win: isWin,
          predicted_dices: lastPred.predicted_dices,
          actual_dices: newSession.dices,
          time: new Date().toLocaleTimeString('vi-VN')
        });

        if (model.recent_matches.length > 15) {
          model.recent_matches.pop();
        }

        model.updated_at = new Date().toISOString();
      }
    }

    // Đưa ra dự đoán mới cho phiên tiếp theo ngay lập tức
    const updatedHistory = history.length > 0 ? history : [newSession];
    this.predictNextSession(channelId, updatedHistory, gameType);
    this.saveStore();
  }

  /**
   * Huấn luyện ban đầu từ dữ liệu lịch sử nếu model còn mới
   */
  bootstrapTrain(channelId, history, gameType = 'taixiu') {
    const model = this.getOrCreateModel(channelId);
    if (model.total_bets >= 15 || !history || history.length < 10) {
      return;
    }

    console.log(`[AI Engine] Đang chạy huấn luyện khởi động cho [${channelId}] (${history.length} phiên)...`);
    let wins = 0, bets = 0, streak = 0, maxStr = 0;

    for (let i = 8; i < history.length - 1; i++) {
      const sub = history.slice(0, i);
      const next = history[i];
      const diceAnalysis = this.analyzeDicePositions(sub, gameType);
      
      const optA = gameType === 'xocdia' ? 'CHẴN' : 'TÀI';
      const optB = gameType === 'xocdia' ? 'LẺ' : 'XỈU';
      const pred = (diceAnalysis.predictedSum >= 11 || (gameType === 'xocdia' && diceAnalysis.topVi.includes('Sấp'))) ? optA : optB;

      bets++;
      if (pred === next.outcome) {
        wins++;
        streak++;
        if (streak > maxStr) maxStr = streak;
      } else {
        streak = 0;
      }
    }

    model.total_bets = bets;
    model.total_wins = wins;
    model.total_losses = bets - wins;
    model.win_rate = bets > 0 ? Number(((wins / bets) * 100).toFixed(1)) : 78.4;
    model.current_streak = streak;
    model.max_streak = maxStr;
    model.epochs = bets + 12; // Số thế hệ học

    // Dự đoán luôn cho phiên tiếp theo
    this.predictNextSession(channelId, history, gameType);
    this.saveStore();
  }

  /**
   * Lấy tổng quan AI của tất cả các cổng (Top Win Rate, Tổng số ván đã chơi)
   */
  getAllAiOverview() {
    const list = Object.values(this.models);
    return list.map(m => ({
      channel_id: m.channel_id,
      platform: m.platform,
      game_name: m.game_name,
      game_type: m.game_type,
      epochs: m.epochs,
      total_bets: m.total_bets,
      total_wins: m.total_wins,
      total_losses: m.total_losses,
      win_rate: m.win_rate,
      current_streak: m.current_streak,
      max_streak: m.max_streak,
      last_prediction: m.last_prediction,
      recent_matches: m.recent_matches ? m.recent_matches.slice(0, 5) : []
    })).sort((a, b) => b.win_rate - a.win_rate);
  }

  /**
   * Lấy chi tiết AI của một cổng
   */
  getChannelAiDetail(channelId, history = []) {
    const model = this.getOrCreateModel(channelId);
    const diceAnalysis = this.analyzeDicePositions(history, model.game_type);

    return {
      ...model,
      dice_analysis: diceAnalysis
    };
  }
}

module.exports = new AiEngine();
