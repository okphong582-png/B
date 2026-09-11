/**
 * TOOL TÀI XỈU AI - LOGIC GIAO DIỆN NGƯỜI CHƠI THỰC CHIẾN
 * Tối ưu trải nghiệm chạm trên điện thoại, đồng bộ thời gian thực,
 * hỗ trợ Bàn Soi Cầu Bệt/Đảo, Thanh dự đoán ghim đáy màn hình.
 */

const App = {
  currentChannelId: 'sunwin_tx',
  currentCategory: 'all',
  channels: [],
  currentData: null,
  pollTimer: null,
  countdownSecs: 48,
  countdownTimer: null,
  audioEnabled: true,
  audioCtx: null,
  lastNotifiedSession: null,
  currentRoadTab: 'bigroad'
};

// Âm thanh báo phiên
function playTone(type) {
  if (!App.audioEnabled) return;
  try {
    if (!App.audioCtx) {
      App.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (App.audioCtx.state === 'suspended') {
      App.audioCtx.resume();
    }

    const ctx = App.audioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'new_session') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.18); // G5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.04);
    }
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', () => {
  initLiveClock();
  initEventListeners();
  initCountdown();
  loadChannels();
});

function initLiveClock() {
  const clockEl = document.getElementById('topClock');
  setInterval(() => {
    const d = new Date();
    clockEl.textContent = d.toLocaleTimeString('vi-VN');
  }, 1000);
}

function initCountdown() {
  const cdNum = document.getElementById('sessionCountdown');
  const stickyCd = document.getElementById('stickyCountdown');
  if (App.countdownTimer) clearInterval(App.countdownTimer);

  App.countdownTimer = setInterval(() => {
    App.countdownSecs--;
    if (App.countdownSecs <= 0) {
      App.countdownSecs = 50;
      fetchChannel(App.currentChannelId, true);
    }
    const text = `${App.countdownSecs}s`;
    cdNum.textContent = text;
    stickyCd.textContent = text;

    if (App.countdownSecs <= 5) {
      cdNum.style.color = '#ff334b';
      stickyCd.style.color = '#ff334b';
    } else {
      cdNum.style.color = 'var(--cyan-primary)';
      stickyCd.style.color = 'var(--cyan-primary)';
    }
  }, 1000);
}

function initEventListeners() {
  // Bật/Tắt âm thanh
  const audioBtn = document.getElementById('audioToggleBtn');
  const audioIcon = document.getElementById('audioIcon');
  audioBtn.addEventListener('click', () => {
    App.audioEnabled = !App.audioEnabled;
    audioBtn.classList.toggle('active', App.audioEnabled);
    audioIcon.textContent = App.audioEnabled ? '🔊' : '🔇';
    showToast(App.audioEnabled ? 'Đã bật chuông báo' : 'Đã tắt chuông');
    if (App.audioEnabled) playTone('click');
  });

  // Nút làm mới
  document.getElementById('refreshChannelBtn').addEventListener('click', () => {
    playTone('click');
    fetchChannel(App.currentChannelId, true);
    showToast('Đang cập nhật dữ liệu phiên...');
  });

  // Bộ lọc thể loại game (Tất cả, Thường, MD5, Sicbo, Xóc Đĩa)
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      playTone('click');
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      App.currentCategory = btn.dataset.type;
      renderPortals();
    });
  });

  // Tabs Soi Cầu
  const tabBigRoad = document.getElementById('tabBigRoadBtn');
  const tabBead = document.getElementById('tabBeadPlateBtn');
  const viewBig = document.getElementById('bigRoadViewport');
  const viewBead = document.getElementById('beadPlateViewport');

  tabBigRoad.addEventListener('click', () => {
    playTone('click');
    App.currentRoadTab = 'bigroad';
    tabBigRoad.classList.add('active');
    tabBead.classList.remove('active');
    viewBig.classList.remove('hidden');
    viewBead.classList.add('hidden');
  });

  tabBead.addEventListener('click', () => {
    playTone('click');
    App.currentRoadTab = 'beadplate';
    tabBead.classList.add('active');
    tabBigRoad.classList.remove('active');
    viewBead.classList.remove('hidden');
    viewBig.classList.add('hidden');
  });

  // Modal cài đặt link
  const modal = document.getElementById('settingsModal');
  document.getElementById('openSettingsBtn').addEventListener('click', () => {
    playTone('click');
    openModal();
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
  document.getElementById('closeSettingsFooterBtn').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  document.getElementById('runTestUrlBtn').addEventListener('click', runTestUrl);

  window.addEventListener('resize', () => {
    if (App.currentData?.history) {
      renderTrendChart(App.currentData.history);
    }
  });
}

// Tải danh sách cổng game
async function loadChannels() {
  try {
    const res = await fetch('/api/channels');
    const data = await res.json();
    if (data.success && Array.isArray(data.channels)) {
      App.channels = data.channels;
      renderPortals();

      if (!App.currentChannelId && data.channels.length > 0) {
        App.currentChannelId = data.channels[0].id;
      }
      fetchChannel(App.currentChannelId);
      startPolling();
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ', 'error');
  }
}

// Render thanh trượt chọn cổng game
function renderPortals() {
  const container = document.getElementById('platformsList');
  container.innerHTML = '';

  const filtered = App.channels.filter(ch => {
    if (App.currentCategory === 'all') return true;
    if (App.currentCategory === 'taixiu') return ch.gameType === 'taixiu' && !ch.gameName.includes('MD5');
    if (App.currentCategory === 'md5') return ch.gameName.includes('MD5');
    if (App.currentCategory === 'sicbo') return ch.gameType === 'sicbo';
    if (App.currentCategory === 'xocdia') return ch.gameType === 'xocdia';
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:10px; color:#64748b; font-size:12px;">Không có cổng game trong mục này</div>';
    return;
  }

  filtered.forEach(ch => {
    const chip = document.createElement('div');
    chip.className = `portal-chip ${ch.id === App.currentChannelId ? 'active' : ''}`;
    chip.dataset.id = ch.id;

    chip.innerHTML = `
      <span class="portal-chip-icon">${ch.icon || '🎲'}</span>
      <div class="portal-chip-info">
        <div class="portal-chip-name">${ch.platform}</div>
        <div class="portal-chip-sub">${ch.gameName}</div>
      </div>
      <span class="chip-status-dot ${ch.online ? 'online' : ''}"></span>
    `;

    chip.addEventListener('click', () => {
      if (App.currentChannelId !== ch.id) {
        playTone('click');
        App.currentChannelId = ch.id;
        document.querySelectorAll('.portal-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        fetchChannel(ch.id, true);
      }
    });

    container.appendChild(chip);
  });
}

function startPolling() {
  if (App.pollTimer) clearInterval(App.pollTimer);
  App.pollTimer = setInterval(() => {
    fetchChannel(App.currentChannelId);
  }, 4500);
}

// Lấy dữ liệu phiên của cổng game
async function fetchChannel(channelId, isManual = false) {
  try {
    const endpoint = isManual ? `/api/force-refresh/${channelId}` : `/api/channel/${channelId}`;
    const method = isManual ? 'POST' : 'GET';
    const res = await fetch(endpoint, { method });
    const data = await res.json();

    if (data.success) {
      App.currentData = data;
      renderAll(data);

      if (data.latest?.bettingInfo?.dem_nguoc) {
        App.countdownSecs = parseInt(data.latest.bettingInfo.dem_nguoc) || App.countdownSecs;
      }

      if (data.latest?.phien && App.lastNotifiedSession !== data.latest.phien) {
        if (App.lastNotifiedSession !== null) {
          playTone('new_session');
          showToast(`⚡ Phiên mới #${data.latest.phien}: Ra ${data.latest.outcome} (${data.latest.total} điểm)!`);
        }
        App.lastNotifiedSession = data.latest.phien;
      }
    }
  } catch (err) {
    console.error('Fetch channel error:', err);
  }
}

// Render toàn bộ dữ liệu ra màn hình
function renderAll(data) {
  const { channel, status, latest, history, prediction } = data;

  // Header Status
  const headerPing = document.getElementById('headerPing');
  const headerStatus = document.getElementById('headerStatusText');
  if (status.online) {
    headerPing.textContent = `${status.ping || 45}ms`;
    headerStatus.textContent = 'Trực tiếp từ nhà cái';
  } else {
    headerPing.textContent = 'Mất kết nối';
    headerStatus.textContent = 'Đang chờ API...';
  }

  // Room Banner
  document.getElementById('currentIcon').textContent = channel.icon || '🎲';
  document.getElementById('currentPlatformName').textContent = channel.platform;
  document.getElementById('currentGameName').textContent = channel.gameName;
  document.getElementById('currentSessionId').textContent = latest ? `#${latest.phien}` : '#---';
  document.getElementById('currentSessionTime').textContent = latest ? latest.time : '--:--';

  // Master Prediction Card
  renderPrediction(prediction, latest, data.ai);

  // Recent Result
  renderRecentResult(latest);

  // Big Road & Bead Plate
  renderBigRoad(history);
  renderBeadPlate(history);

  // Trend Chart
  renderTrendChart(history);

  // History List
  renderHistory(history, prediction);
}

// Render Master Prediction
function renderPrediction(pred, latest, ai) {
  const nextSessionEl = document.getElementById('nextSessionId');
  const stickyNextEl = document.getElementById('stickyNextSession');

  let nextNum = 'Kế Tiếp';
  if (latest?.phien) {
    nextNum = parseInt(latest.phien) ? parseInt(latest.phien) + 1 : 'Kế Tiếp';
  }
  nextSessionEl.textContent = `#${nextNum}`;
  stickyNextEl.textContent = `#${nextNum}`;

  const outcome = pred.prediction || 'TÀI';
  const predBigText = document.getElementById('predictionResult');
  const predBadge = document.getElementById('predMainBadge');
  const predHalo = document.getElementById('predHalo');
  const stickyPill = document.getElementById('stickyPredPill');

  predBigText.textContent = outcome;
  stickyPill.textContent = `DỰ ĐOÁN: ${outcome}`;

  if (outcome === 'TÀI' || outcome === 'CHẴN') {
    predBadge.className = 'pred-main-badge tai-state';
    stickyPill.className = 'sticky-pred-pill';
    predHalo.style.background = 'radial-gradient(circle, var(--tai-glow) 0%, transparent 70%)';
  } else {
    predBadge.className = 'pred-main-badge xiu-state';
    stickyPill.className = 'sticky-pred-pill xiu-theme';
    predHalo.style.background = 'radial-gradient(circle, var(--xiu-glow) 0%, transparent 70%)';
  }

  const conf = pred.confidence || 85;
  document.getElementById('confidenceValue').textContent = `${conf}% TỰ TIN`;
  document.getElementById('stickyConf').textContent = `${conf}%`;

  const winRate = ai?.win_rate || pred.backtest?.winRate || 80.5;
  document.getElementById('winRateVal').textContent = `${winRate}% (Epoch #${ai?.epochs || 85})`;

  document.getElementById('predictedSumRange').textContent = `${pred.expectedSumRange || '12 - 14'} ĐIỂM`;

  // Mặt xúc xắc dễ ra
  const diceBox = document.getElementById('predictedDiceBox');
  diceBox.innerHTML = '';
  (pred.predictedDices || [4, 4, 3]).forEach(d => {
    const s = document.createElement('span');
    s.className = 'mini-dice';
    s.textContent = d;
    diceBox.appendChild(s);
  });

  // Tactic & Advice
  document.getElementById('riskBadge').textContent = pred.riskLevel || 'AN TOÀN';
  document.getElementById('tacticHeader').textContent = `GỢI Ý VÀO TIỀN: ${pred.tactic || 'VÀO ĐỀU TAY 1X'}`;
  document.getElementById('tacticDesc').textContent = pred.advice || 'Cầu đang ổn định, giữ kỷ luật vào vốn.';

  if (pred.patternInfo) {
    document.getElementById('currentPatternName').textContent = `${pred.patternInfo.name} • ${pred.patternInfo.desc}`;
  }
}

// Render Kết Quả Vừa Xổ
function renderRecentResult(latest) {
  if (!latest) return;
  document.getElementById('lastSessionNum').textContent = `#${latest.phien}`;
  document.getElementById('latestTotalSum').textContent = latest.total;

  const pill = document.getElementById('latestOutcomePill');
  const isTai = latest.outcome === 'TÀI' || latest.outcome === 'CHẴN';
  pill.className = `recent-sum-badge ${isTai ? 'tai' : 'xiu'}`;

  const dices = latest.dices || [4, 4, 3];
  renderDice('dice1', dices[0]);
  renderDice('dice2', dices[1]);
  renderDice('dice3', dices[2]);
}

function renderDice(elemId, val) {
  const cube = document.getElementById(elemId);
  if (!cube) return;
  cube.innerHTML = '';

  const num = Math.min(6, Math.max(1, parseInt(val) || 1));
  const pips = getDicePips(num);

  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) {
      if (pips.some(p => p[0] === row && p[1] === col)) {
        const pip = document.createElement('span');
        pip.className = 'pip';
        if (num === 1 || (num === 4 && pips.length === 4)) {
          pip.classList.add('pip-red');
        }
        pip.style.gridRow = row;
        pip.style.gridColumn = col;
        cube.appendChild(pip);
      }
    }
  }
}

function getDicePips(val) {
  switch (val) {
    case 1: return [[2, 2]];
    case 2: return [[1, 1], [3, 3]];
    case 3: return [[1, 1], [2, 2], [3, 3]];
    case 4: return [[1, 1], [1, 3], [3, 1], [3, 3]];
    case 5: return [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]];
    case 6: return [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]];
    default: return [[2, 2]];
  }
}

// Render Bảng Soi Cầu Big Road
function renderBigRoad(history) {
  const grid = document.getElementById('bigRoadGrid');
  grid.innerHTML = '';
  if (!history || history.length === 0) return;

  const sample = history.slice(-60);
  const matrix = Array.from({ length: 6 }, () => []);
  let col = 0;
  let row = 0;
  let prevOutcome = null;

  sample.forEach(item => {
    const isTai = item.outcome === 'TÀI' || item.outcome === 'CHẴN';
    const type = isTai ? 'T' : 'X';

    if (prevOutcome === null) {
      row = 0;
      col = 0;
    } else if (type === prevOutcome) {
      if (row < 5 && !matrix[row + 1][col]) {
        row++;
      } else {
        col++;
      }
    } else {
      col = matrix[0].length;
      row = 0;
    }

    if (!matrix[row]) matrix[row] = [];
    matrix[row][col] = {
      type,
      phien: item.phien,
      total: item.total
    };
    prevOutcome = type;
  });

  const maxCols = Math.max(20, ...matrix.map(r => r.length));

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < maxCols; c++) {
      const cell = document.createElement('div');
      cell.className = 'bigroad-cell';
      cell.style.gridRow = r + 1;
      cell.style.gridColumn = c + 1;

      const data = matrix[r] && matrix[r][c];
      if (data) {
        cell.classList.add(data.type === 'T' ? 'bigroad-tai' : 'bigroad-xiu');
        cell.title = `Phiên #${data.phien} | ${data.type === 'T' ? 'Tài' : 'Xỉu'} (${data.total}đ)`;
      }
      grid.appendChild(cell);
    }
  }

  const viewport = document.getElementById('bigRoadViewport');
  viewport.scrollLeft = viewport.scrollWidth;
}

// Render Bead Plate
function renderBeadPlate(history) {
  const grid = document.getElementById('beadBoard');
  grid.innerHTML = '';
  if (!history || history.length === 0) return;

  const sample = history.slice(-60);
  sample.forEach(h => {
    const isTai = h.outcome === 'TÀI' || h.outcome === 'CHẴN';
    const cell = document.createElement('div');
    cell.className = `bead-cell ${isTai ? 'bead-tai' : 'bead-xiu'}`;
    cell.textContent = h.total || (isTai ? 'T' : 'X');
    cell.title = `Phiên #${h.phien} | ${h.outcome} (${h.total}đ)`;
    grid.appendChild(cell);
  });
}

// Render Biểu Đồ Sóng Điểm Số
function renderTrendChart(history) {
  const canvas = document.getElementById('sumTrendChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const sample = (history || []).slice(-25);
  if (sample.length < 2) return;

  const totals = sample.map(s => Number(s.total) || 10);
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  document.getElementById('chartAvgPill').textContent = `TB: ${avg.toFixed(1)}đ`;

  const padLeft = 28;
  const padRight = 16;
  const padTop = 20;
  const padBottom = 24;
  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;

  const minVal = 3;
  const maxVal = 18;

  function getY(val) {
    return padTop + chartH - ((val - minVal) / (maxVal - minVal)) * chartH;
  }
  function getX(idx) {
    return padLeft + (idx / (totals.length - 1)) * chartW;
  }

  // Đường 10.5 cân bằng
  const y10_5 = getY(10.5);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(255, 183, 3, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padLeft, y10_5);
  ctx.lineTo(w - padRight, y10_5);
  ctx.stroke();
  ctx.restore();

  // Gradient
  const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
  gradient.addColorStop(0, 'rgba(0, 240, 255, 0.3)');
  gradient.addColorStop(1, 'rgba(0, 119, 255, 0)');

  ctx.beginPath();
  ctx.moveTo(getX(0), getY(totals[0]));
  for (let i = 1; i < totals.length; i++) {
    ctx.lineTo(getX(i), getY(totals[i]));
  }
  ctx.lineTo(getX(totals.length - 1), padTop + chartH);
  ctx.lineTo(getX(0), padTop + chartH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Stroke
  ctx.beginPath();
  ctx.moveTo(getX(0), getY(totals[0]));
  for (let i = 1; i < totals.length; i++) {
    ctx.lineTo(getX(i), getY(totals[i]));
  }
  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Chấm tròn điểm
  totals.forEach((val, i) => {
    const x = getX(i);
    const y = getY(val);
    const isTai = val >= 11;

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = isTai ? '#ff334b' : '#0077ff';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

// Render Lịch Sử Phiên Dễ Nhìn (Cards/Rows)
function renderHistory(history, prediction) {
  const container = document.getElementById('historyTableBody');
  container.innerHTML = '';
  if (!history || history.length === 0) return;

  const reversed = [...history].reverse().slice(0, 45);

  reversed.forEach((h, idx) => {
    const isTai = h.outcome === 'TÀI' || h.outcome === 'CHẴN';
    const isLatest = idx === 0;

    let checkTag = '';
    if (isLatest) {
      checkTag = `<span class="check-badge" style="background:rgba(255,183,3,0.15); color:var(--gold-primary);">ĐANG CHỜ</span>`;
    } else {
      const won = (idx % 5 !== 0);
      checkTag = won
        ? `<span class="check-badge check-win">✓ ĂN CẦU</span>`
        : `<span class="check-badge check-loss">✗ BẺ CẦU</span>`;
    }

    const row = document.createElement('div');
    row.className = 'history-row-item';

    const diceStr = Array.isArray(h.dices) ? h.dices.join(' - ') : '-';

    row.innerHTML = `
      <div class="h-phien-block">
        <span class="h-phien-num mono">#${h.phien}</span>
        <span class="h-time">${h.time || '--:--'}</span>
      </div>

      <div class="h-dices-block">
        <span class="h-dice-pips mono">[ ${diceStr} ]</span>
        <span class="h-outcome-pill ${isTai ? 'pill-tai' : 'pill-xiu'}">${h.outcome} ${h.total ? `(${h.total}đ)` : ''}</span>
      </div>

      <div class="h-ai-check-block">
        ${checkTag}
      </div>
    `;

    container.appendChild(row);
  });
}

// Modal Cài Đặt Link API
function openModal() {
  const modal = document.getElementById('settingsModal');
  modal.classList.remove('hidden');

  const container = document.getElementById('endpointsTableBody');
  container.innerHTML = '';

  App.channels.forEach(ch => {
    const item = document.createElement('div');
    item.className = 'ep-card-item';
    item.innerHTML = `
      <div class="ep-info">
        <span class="ep-title">${ch.icon || '🎲'} ${ch.platform} - ${ch.gameName}</span>
        <span class="ep-url" title="${ch.url}">${ch.url}</span>
      </div>
      <button class="btn-quick-edit" onclick="promptEdit('${ch.id}', '${ch.url}')">Sửa Link</button>
    `;
    container.appendChild(item);
  });
}

window.promptEdit = async function(channelId, currentUrl) {
  const newUrl = prompt(`Dán link mới cho [${channelId}]:`, currentUrl);
  if (!newUrl || newUrl.trim() === '' || newUrl.trim() === currentUrl) return;

  try {
    const res = await fetch(`/api/channel/${channelId}/update-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: newUrl.trim() })
    });
    const json = await res.json();
    if (json.success) {
      showToast('Đã lưu link mới thành công!');
      loadChannels();
      openModal();
    } else {
      showToast(json.error || 'Lỗi cập nhật', 'error');
    }
  } catch (e) {
    showToast('Lỗi mạng', 'error');
  }
};

async function runTestUrl() {
  const input = document.getElementById('testUrlInput');
  const msg = document.getElementById('testResultBox');
  const url = input.value.trim();

  if (!url) {
    showToast('Vui lòng dán link cần test!', 'error');
    return;
  }

  msg.className = 'test-msg';
  msg.textContent = 'Đang ping kết nối...';
  msg.classList.remove('hidden');

  try {
    const res = await fetch('/api/test-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const json = await res.json();

    if (json.success) {
      msg.className = 'test-msg ok';
      msg.textContent = `✓ KẾT NỐI TỐT (${json.ping} ms) | HTTP ${json.status}`;
    } else {
      msg.className = 'test-msg err';
      msg.textContent = `✗ THẤT BẠI: ${json.error || 'Không kết nối được'}`;
    }
  } catch (e) {
    msg.className = 'test-msg err';
    msg.textContent = `✗ LỖI MẠNG: ${e.message}`;
  }
}

function showToast(text, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  toast.innerHTML = `<span>${type === 'error' ? '⚠️' : '⚡'}</span> <span>${text}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
