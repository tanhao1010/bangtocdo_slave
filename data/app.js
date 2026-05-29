const app = {
  // ── TRẠNG THÁI (STATE) ──
  state: {
    isAuthenticated: false,
    currentCandidates: [],
    top16: [],
    // Stopwatch state
    swRunning: false,
    swStart: 0,
    swElapsed: 0,
    lapCount: 0,
    tournamentName: "Giải đấu trượt Patin chuyên nghiệp",
    lane1Idx: 0,
    lane2Idx: 1,
    lapRecords: [],
    // Timer mode (3/4) state
    timerMode: 3,           // 3 = dem nguoc, 4 = dem toi
    timerTarget: 60,
    // Counter mode (5) state
    counter1: 0,
    counter2: 0,
    // Polling
    pollInterval: null,
    statusPollInterval: null
  },

  // ── API ESP32 (gọi master qua HTTP) ──
  api: {
    base: '',  // cung host: '' (mac dinh)
    async _do(method, path, params) {
      const qs = params && Object.keys(params).length
        ? '?' + new URLSearchParams(params).toString()
        : '';
      try {
        const r = await fetch(this.base + path + qs, { method });
        if (!r.ok) return { ok: false, err: 'HTTP ' + r.status };
        return await r.json();
      } catch (e) {
        return { ok: false, err: e.message };
      }
    },
    post(path, params) { return this._do('POST', path, params); },
    get(path, params)  { return this._do('GET',  path, params); }
  },

  // ── KHỞI TẠO ──
  init() {
    this.loadState(); // Tải lại dữ liệu cũ nếu có
    this.checkAuth();
    this.startClock();
  },

  loadState() {
    const saved = localStorage.getItem('patin_pro_state');
    if (saved) {
      const data = JSON.parse(saved);
      this.state.currentCandidates = data.candidates || [];
      this.state.top16 = data.top16 || [];
      this.state.bracketSize = data.bracketSize || 16;
      this.state.tournamentName = data.tournamentName || "";
    }
  },

  saveToLocal() {
    const data = {
      candidates: this.state.currentCandidates,
      top16: this.state.top16,
      bracketSize: this.state.bracketSize || 16,
      tournamentName: this.state.tournamentName
    };
    localStorage.setItem('patin_pro_state', JSON.stringify(data));
  },

  // ── 1. MODULE XÁC THỰC ──
  login() {
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;

    // Gợi ý: admin / 123456
    if (user === 'admin' && pass === '123456') {
      this.state.isAuthenticated = true;
      document.getElementById('login-view').classList.remove('active');
      document.getElementById('main-layout').classList.add('active');
      this.navigate('dashboard');
      this.showToast('Chào mừng Quản trị viên!');
    } else {
      this.showToast('Sai thông tin đăng nhập!');
    }
  },

  logout() {
    this.state.isAuthenticated = false;
    document.getElementById('main-layout').classList.remove('active');
    document.getElementById('login-view').classList.add('active');
    document.getElementById('password').value = '';
    this.showToast('Đã đăng xuất');
  },

  checkAuth() {
    if (!this.state.isAuthenticated) {
      document.getElementById('login-view').classList.add('active');
      document.getElementById('main-layout').classList.remove('active');
    }
  },

  // ── 2. MODULE ĐIỀU HƯỚNG ──
  navigate(pageId, navTarget) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(pageId);
    if (target) target.classList.add('active');

    const navId = navTarget || pageId;
    document.querySelectorAll('.bnav-item').forEach(el => el.classList.remove('active'));
    const activeNav = document.querySelector(`.bnav-item[data-target="${navId}"]`);
    if (activeNav) activeNav.classList.add('active');

    // Nếu quay lại trang Pro (Import) mà đã có dữ liệu thì hiện lại preview
    if (pageId === 'pro' && this.state.currentCandidates.length > 0) {
      this.renderCSVPreview();
    }

    window.scrollTo(0, 0);
  },

  // ── 3. MODULE TIỆN ÍCH (CLOCK & TOAST) ──
  startClock() {
    const update = () => {
      const now = new Date();
      const p = v => String(v).padStart(2, '0');
      const clockEl = document.getElementById('home-clock');
      if (clockEl) clockEl.textContent = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
      const dateEl = document.getElementById('home-date');
      if (dateEl) {
        const options = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' };
        dateEl.textContent = now.toLocaleDateString('vi-VN', options);
      }
    };
    setInterval(update, 1000);
    update();
  },

  showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  },

  // ── 4. MODULE RACE VIEW (TẬP LUYỆN & VÒNG LOẠI) ──
  setPenalty(lane, val) {
    document.getElementById(`l${lane}-pen`).innerText = val;
    this.showToast(`Làn ${lane}: Penalty = ${val}`);
    if (this.state.raceMode === 'qualifying') this.saveCurrentDrafts();
  },

  swapLanes() {
    if (this.state.layoutMode === 'solo') return;

    if (this.state.raceMode === 'training') {
      const n1 = document.getElementById('l1-name').innerText;
      const n2 = document.getElementById('l2-name').innerText;
      const p1 = document.getElementById('l1-pen').innerText;
      const p2 = document.getElementById('l2-pen').innerText;
      document.getElementById('l1-name').innerText = n2;
      document.getElementById('l2-name').innerText = n1;
      document.getElementById('l1-pen').innerText = p2;
      document.getElementById('l2-pen').innerText = p1;
    } else {
      this.saveCurrentDrafts();
      const tempIdx = this.state.lane1Idx;
      this.state.lane1Idx = this.state.lane2Idx;
      this.state.lane2Idx = tempIdx;
      this.renderLanes();
    }

    this.showToast('Đã hoán đổi 2 làn');
  },

  showModeModal(mode) {
    if (mode === 'training') {
      document.getElementById('modal-mode-select-training').classList.add('active');
    } else {
      document.getElementById('modal-mode-select-qualifying').classList.add('active');
    }
  },

  closeModeModal(layout, mode) {
    if (mode === 'training') {
      document.getElementById('modal-mode-select-training').classList.remove('active');
    } else {
      document.getElementById('modal-mode-select-qualifying').classList.remove('active');
    }
    this.openRaceView(mode, layout);
  },

  openRaceView(mode, layout = 'pk') {
    this.state.raceMode = mode;
    this.state.layoutMode = layout;
    this.state.isBracketMatch = false; // Luôn reset về false khi mở chế độ bình thường
    const navTarget = (mode === 'training') ? 'race-view' : 'pro';
    this.navigate('race-view', navTarget);

    const lanesWrap = document.querySelector('.rv-lanes-wrap');
    const swapBtn = document.getElementById('btn-swap-lanes');
    if (layout === 'solo') {
      lanesWrap.classList.add('solo-mode');
      if (swapBtn) swapBtn.style.display = 'none';
    } else {
      lanesWrap.classList.remove('solo-mode');
      if (swapBtn) swapBtn.style.display = 'flex';
    }

    // Reset display
    ['l1', 'l2'].forEach(id => {
      document.getElementById(`${id}-time`).firstChild.textContent = '0';
      document.getElementById(`${id}-ms`).textContent = '.000s';
      document.getElementById(`${id}-pen`).innerText = '0';
    });

    const lapPanel = document.getElementById('rv-lap-panel');
    if (lapPanel) lapPanel.style.display = 'none';

    // Khôi phục hiển thị Penalty cho chế độ bình thường
    document.querySelectorAll('.rv-pen-wrap').forEach(el => el.style.display = '');

    if (mode === 'training') {
      document.getElementById('rv-title').innerText = 'TẬP LUYỆN';
      document.getElementById('rv-nav-wrap').style.display = 'none';
      document.getElementById('l1-name').innerText = 'VĐV Làn 1';
      document.getElementById('l2-name').innerText = 'VĐV Làn 2';
      document.getElementById('l1-status').innerText = 'Chờ bắt đầu';
      document.getElementById('l2-status').innerText = 'Chờ bắt đầu';
      document.getElementById('btn-custom-lock').style.display = 'none';
      document.getElementById('btn-rv-next').style.display = 'none';
      const candPanel = document.getElementById('rv-cand-panel');
      if (candPanel) { candPanel.classList.remove('active'); candPanel.style.display = 'none'; }
    } else {
      if (this.state.currentCandidates.length === 0) {
        this.showToast('Danh sách VĐV đang trống! Hãy Import CSV trước.');
        this.navigate('pro'); return;
      }
      document.getElementById('rv-title').innerText = 'VÒNG LOẠI';
      document.getElementById('rv-nav-wrap').style.display = 'flex';
      document.getElementById('btn-rv-next').style.display = 'flex';
      document.getElementById('btn-custom-lock').style.display = 'flex';
      const candPanel = document.getElementById('rv-cand-panel');
      if (candPanel) { candPanel.style.display = ''; }
      this.state.lane1Idx = 0;
      this.state.lane2Idx = 1;
      this.state.raceDraft = JSON.parse(localStorage.getItem('qualifying_draft') || '{}');
      this.renderLanes();
    }
  },

  openMassStart() {
    this.state.raceMode = 'mass-start';
    this.state.layoutMode = 'solo';
    this.state.isBracketMatch = false;
    this.state.lapRecords = [];

    this.navigate('race-view', 'mass-start');

    document.querySelector('.rv-lanes-wrap').classList.add('solo-mode');

    const swapBtn = document.getElementById('btn-swap-lanes');
    if (swapBtn) swapBtn.style.display = 'none';

    document.getElementById('l1-time').firstChild.textContent = '0';
    document.getElementById('l1-ms').textContent = '.000s';
    document.getElementById('l1-pen').innerText = '0';
    this.setStatus('l1', 'Chờ bắt đầu');

    document.getElementById('rv-title').innerText = 'TIME LAPSE';
    document.getElementById('rv-nav-wrap').style.display = 'none';
    document.getElementById('btn-custom-lock').style.display = 'none';
    document.getElementById('btn-rv-next').style.display = 'none';
    document.getElementById('l1-name').innerText = 'Đồng hồ Tổng';

    const candPanel = document.getElementById('rv-cand-panel');
    if (candPanel) { candPanel.classList.remove('active'); candPanel.setAttribute('style', 'display: none !important;'); }

    const lapPanel = document.getElementById('rv-lap-panel');
    if (lapPanel) lapPanel.style.display = 'flex';

    // Ẩn bảng Penalty trong chế độ Đua đồng hàng
    document.querySelectorAll('.rv-pen-wrap').forEach(el => el.style.display = 'none');

    this.renderLapList();
  },

  recordLap() {
    if (this.state.raceMode !== 'mass-start') return;
    if (!this.state.swRunning) {
      this.showToast('Vui lòng bấm START trước!');
      return;
    }
    if (this.state.lapRecords.length >= 20) {
      this.showToast('Đã ghi nhận tối đa 20 mốc thời gian!');
      return;
    }

    const ms = this.state.swElapsed;
    const totalSecs = Math.floor(ms / 1000);
    const msPart = ms % 1000;
    const timeStr = `${totalSecs}.${String(msPart).padStart(3, '0')}s`;

    this.state.lapRecords.push({ idx: this.state.lapRecords.length + 1, time: timeStr, timeMs: ms });
    this.renderLapList();
  },

  renderLapList() {
    const listEl = document.getElementById('lap-list');
    if (!listEl) return;

    let html = '';
    // Luôn vẽ sẵn 20 dòng
    for (let i = 1; i <= 20; i++) {
      const rec = this.state.lapRecords[i - 1];
      if (rec) {
        html += `
          <div class="lap-item filled fade-up">
            <span class="lap-idx">Vị trí ${i}</span>
            <span class="lap-time">${rec.time}</span>
          </div>
        `;
      } else {
        html += `
          <div class="lap-item">
            <span class="lap-idx">Vị trí ${i}</span>
            <span class="lap-time" style="font-family:'JetBrains Mono',monospace;">--.---s</span>
          </div>
        `;
      }
    }
    listEl.innerHTML = html;
  },

  handlePrevCandidate() {
    const offset = this.state.layoutMode === 'solo' ? -1 : -2;
    this.changeCandidate(offset);
  },

  handleNextCandidate() {
    const offset = this.state.layoutMode === 'solo' ? 1 : 2;
    this.changeCandidate(offset);
  },

  changeCandidate(offset) {
    this.saveCurrentDrafts();
    const maxIdx = this.state.currentCandidates.length - 1;
    let n1 = this.state.lane1Idx + offset;
    let n2 = this.state.lane2Idx + offset;

    if (n1 < 0) { n1 = 0; n2 = 1; }
    if (n1 > maxIdx) n1 = maxIdx;
    if (n2 > maxIdx) n2 = maxIdx;

    this.state.lane1Idx = n1;
    this.state.lane2Idx = n2;
    this.renderLanes();
    this.resetRaceLogic();
  },

  saveCurrentDrafts() {
    if (this.state.raceMode !== 'qualifying' || this.state.currentCandidates.length === 0) return;

    const tSec = this.state.swElapsed / 1000;

    // Đọc điểm penalty (số nguyên) và lưu nguyên gốc vào draft
    const pen1Raw = document.getElementById('l1-pen').innerText;
    const pen2Raw = document.getElementById('l2-pen').innerText;
    const pen1 = pen1Raw === 'DQ' ? 'DQ' : parseInt(pen1Raw) || 0;
    const pen2 = pen2Raw === 'DQ' ? 'DQ' : parseInt(pen2Raw) || 0;

    const i1 = this.state.lane1Idx;
    if (this.state.currentCandidates[i1]) {
      // Chỉ lưu time nếu có chạy, để tránh đè time = 0 lên time cũ
      if (tSec > 0 || !this.state.raceDraft[i1]) {
        this.state.raceDraft[i1] = { time: tSec, penalty: pen1 };
      } else {
        this.state.raceDraft[i1].penalty = pen1;
      }
    }

    const i2 = this.state.lane2Idx;
    if (this.state.layoutMode !== 'solo' && this.state.currentCandidates[i2]) {
      if (tSec > 0 || !this.state.raceDraft[i2]) {
        this.state.raceDraft[i2] = { time: tSec, penalty: pen2 };
      } else {
        this.state.raceDraft[i2].penalty = pen2;
      }
    }
    localStorage.setItem('qualifying_draft', JSON.stringify(this.state.raceDraft));
  },

  renderLanes() {
    const idx1 = this.state.lane1Idx;
    const idx2 = this.state.lane2Idx;
    const maxIdx = this.state.currentCandidates.length;

    if (this.state.layoutMode === 'solo') {
      document.getElementById('race-nav-status').innerText = `${idx1 + 1} / ${maxIdx}`;
    } else {
      document.getElementById('race-nav-status').innerText = `${idx1 + 1} & ${idx2 + 1} / ${maxIdx}`;
    }

    const c1 = this.state.currentCandidates[idx1];
    const c2 = this.state.currentCandidates[idx2];

    const d1 = this.state.raceDraft[idx1] || { time: 0, penalty: 0 };
    const d2 = this.state.raceDraft[idx2] || { time: 0, penalty: 0 };

    const formatName = (c) => {
      if (!c) return '---';
      if (!c.dob) return c.name;
      return `<div style="line-height:1.2;">${c.name}</div><div style="font-size:11.5px; color:rgba(180,200,255,0.65); font-weight:600; margin-top:1px;">${c.dob}</div>`;
    };

    document.getElementById('l1-name').innerHTML = formatName(c1);
    document.getElementById('l1-pen').innerText = d1.penalty;

    document.getElementById('l2-name').innerHTML = formatName(c2);
    document.getElementById('l2-pen').innerText = d2.penalty;

    // Nếu có time đã chạy trước đó, set l1-time
    this.updateLaneTimeDisplay('l1', d1.time * 1000);
    this.updateLaneTimeDisplay('l2', d2.time * 1000);

    // Render danh sách VĐV bấm chọn nhanh
    this.renderCandidateList();
  },

  renderCandidateList() {
    const panel = document.getElementById('rv-cand-panel');
    const listEl1 = document.getElementById('l1-cand-list');
    const listEl2 = document.getElementById('l2-cand-list');
    const title2 = document.getElementById('rv-cand-title-2');

    if (this.state.raceMode === 'training' || this.state.isBracketMatch || this.state.currentCandidates.length === 0) {
      panel.classList.remove('active');
      panel.style.display = 'none';
      listEl1.innerHTML = '';
      listEl2.innerHTML = '';
      return;
    }

    panel.classList.add('active');
    panel.style.display = '';
    const isSolo = this.state.layoutMode === 'solo';
    listEl2.style.display = isSolo ? 'none' : 'flex';
    title2.style.display = isSolo ? 'none' : 'block';

    const candidates = this.state.currentCandidates;
    const drafts = this.state.raceDraft || {};
    const i1 = this.state.lane1Idx;
    const i2 = this.state.lane2Idx;

    const formatTime = (sec) => {
      if (!sec || sec <= 0) return '0.000s';
      const s = Math.floor(sec);
      const ms = Math.floor((sec * 1000) % 1000);
      return `${s}.${String(ms).padStart(3, '0')}s`;
    };

    const buildHtml = (targetLane) => {
      return candidates.map((c, i) => {
        const d = drafts[i] || { time: 0, penalty: 0 };
        const hasTimed = d.time > 0;
        const isActive = (targetLane === 1) ? (i === i1) : (i === i2);
        let cls = 'rv-cand-item';
        if (isActive) cls += ' active';
        else if (hasTimed) cls += ' done';
        return `<div class="${cls}" onclick="app.jumpToCandidate(${targetLane}, ${i})">
          <span class="ci-rank">${i + 1}.</span>
          <span class="ci-name">${c.name}${c.dob ? ` <span style="font-size:10.5px; color:rgba(150,190,255,0.55); font-weight:500;">(${c.dob})</span>` : ''}</span>
          <span class="ci-time">${hasTimed ? formatTime(d.time) : '---'}</span>
        </div>`;
      }).join('');
    };

    listEl1.innerHTML = buildHtml(1);
    if (!isSolo) listEl2.innerHTML = buildHtml(2);

    // Scroll VĐV đang active vào giữa vùng nhìn thấy
    setTimeout(() => {
      const activeEl1 = listEl1.querySelector('.rv-cand-item.active');
      if (activeEl1) activeEl1.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (!isSolo) {
        const activeEl2 = listEl2.querySelector('.rv-cand-item.active');
        if (activeEl2) activeEl2.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 50);
  },

  jumpToCandidate(lane, targetIdx) {
    if (this.state.raceMode === 'training') return;

    if (lane === 1) {
      if (this.state.layoutMode !== 'solo' && targetIdx === this.state.lane2Idx) {
        this.showToast('VĐV này đang thi đấu ở Làn 2!');
        return;
      }
      this.saveCurrentDrafts();
      this.state.lane1Idx = targetIdx;
    } else {
      if (targetIdx === this.state.lane1Idx) {
        this.showToast('VĐV này đang thi đấu ở Làn 1!');
        return;
      }
      this.saveCurrentDrafts();
      this.state.lane2Idx = targetIdx;
    }

    this.renderLanes();
    this.resetRaceLogic();
  },

  updateLaneTimeDisplay(laneId, elapsedMs) {
    if (!elapsedMs) elapsedMs = 0;
    const msPart = elapsedMs % 1000;
    const totalSecs = Math.floor(elapsedMs / 1000);
    const display = document.getElementById(`${laneId}-time`);
    if (display) {
      display.firstChild.textContent = String(totalSecs);
      document.getElementById(`${laneId}-ms`).textContent = `.${String(msPart).padStart(3, '0')}s`;
    }
  },

  setPenalty(lane, points) {
    const penEl = document.getElementById(`l${lane}-pen`);
    if (points === 'DQ') {
      penEl.innerText = 'DQ';
      this.showToast(`Làn ${lane}: DQ - Loại khỏi vòng đấu!`);
    } else if (points === 0) {
      penEl.innerText = 0;
      this.showToast(`Làn ${lane}: Đã xóa penalty`);
    } else {
      penEl.innerText = points;
      const secs = (points * 0.2).toFixed(1);
      this.showToast(`Làn ${lane}: Lỗi: ${points} điểm (+${secs}s)`);
    }
    if (this.state.raceMode === 'qualifying') this.saveCurrentDrafts();
  },

  swTick() {
    // KHONG dem gio o day — thoi gian poll tu ESP32.
  },

  // Map giao dien -> mode slave (1..5)
  modeForRace() {
    const lm = this.state.layoutMode;
    // SOLO = mode 1 (slave1 = cong start, slave2 = cong finish, master dem)
    // PK / mass-start / bracket = mode 2 (2 lan thi dau song song)
    return (lm === 'solo') ? 1 : 2;
  },

  async startRace() {
    const mode = this.modeForRace();
    await this.api.post('/api/mode', { m: mode });
    await this.api.post('/api/arm');
    // Mode 1: master cung gui SIG_START -> 2 slave hien effect hinh vuong NGAY.
    // Master se cho cam bien slave 1 trigger moi bat dau dem.
    await this.api.post('/api/start');

    this.state.swRunning = true;
    this.state.swStart = Date.now();
    if (mode === 1) {
      this.setStatus('l1', 'CHO CAM BIEN START...', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
      this.setStatus('l2', 'CHO CAM BIEN START...', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
    } else {
      this.setStatus('l1', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      this.setStatus('l2', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
    }
    this._startPolling();
  },

  _startPolling() {
    if (this.state.pollInterval) clearInterval(this.state.pollInterval);
    this.state.pollInterval = setInterval(() => this.pollLEDTime(), 100);
  },
  _stopPolling() {
    if (this.state.pollInterval) { clearInterval(this.state.pollInterval); this.state.pollInterval = null; }
  },

  setStatus(laneId, text, color, bg, border) {
    const el = document.getElementById(`${laneId}-status`);
    if (!el) return;
    el.innerText = text;
    el.style.color = color;
    el.style.background = bg;
    el.style.borderColor = border;
  },

  async pollLEDTime() {
    const data = await this.api.get('/api/status');
    if (!data || !data.mode) return;

    const mode = data.mode;
    const mst  = data.mState; // 0=IDLE 1=ARMED 2=RUNNING 3=PAUSED 4=FINISHED

    let lane1Ms = 0, lane2Ms = 0;
    if (mode === 1) {
      // Master holds the timer; bua thoi gian giong nhau o 2 lan
      lane1Ms = lane2Ms = data.masterMs || 0;
    } else {
      const s1 = data.slave1 || {}, s2 = data.slave2 || {};
      lane1Ms = (s1.sec || 0) * 1000 + (s1.ms || 0);
      lane2Ms = (s2.sec || 0) * 1000 + (s2.ms || 0);
    }
    this.updateLaneTimeDisplay('l1', lane1Ms);
    if (this.state.layoutMode !== 'solo') this.updateLaneTimeDisplay('l2', lane2Ms);
    this.state.swElapsed = Math.max(lane1Ms, lane2Ms);

    // Mode 1: khi cam bien start trigger (master da vao RUNNING)
    if (mode === 1 && mst === 2 && this.state.swRunning) {
      this.setStatus('l1', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      this.setStatus('l2', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
    }

    // FINISHED -> dung poll
    if (mst === 4) {
      this._stopPolling();
      this.state.swRunning = false;
      const winner = data.winner; // 1 / 2 / 0 (vd mode 1 thi 0)
      const w1 = (mode === 2 && winner === 1) ? ' (THANG)' : '';
      const w2 = (mode === 2 && winner === 2) ? ' (THANG)' : '';
      this.setStatus('l1', 'KET THUC' + w1, '#80ffaa', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      this.setStatus('l2', 'KET THUC' + w2, '#80ffaa', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
    }
  },

  updateLaneTimeDisplay(laneId, elapsedMs) {
    if (!elapsedMs) elapsedMs = 0;
    const msPart = elapsedMs % 1000;
    const totalSecs = Math.floor(elapsedMs / 1000);
    const display = document.getElementById(`${laneId}-time`);
    if (display && display.firstChild) {
      display.firstChild.textContent = String(totalSecs);
      const msEl = document.getElementById(`${laneId}-ms`);
      if (msEl) msEl.textContent = `.${String(msPart).padStart(3, '0')}s`;
    }
  },

  async pauseRace() {
    await this.api.post('/api/pause');
    this.state.swRunning = false;
    this._stopPolling();
    this.setStatus('l1', 'TAM DUNG', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
    this.setStatus('l2', 'TAM DUNG', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
    if (this.state.raceMode === 'qualifying') this.saveCurrentDrafts();
  },

  resetRace() {
    document.getElementById('modal-confirm').classList.add('active');
  },

  closeResetModal() {
    document.getElementById('modal-confirm').classList.remove('active');
  },

  confirmReset() {
    this.closeResetModal();
    this.resetRaceLogic();
    this.showToast('Đã Reset dữ liệu trận đấu');
  },

  async resetRaceLogic() {
    this._stopPolling();
    this.state.swRunning = false;
    this.state.swElapsed = 0;
    await this.api.post('/api/reset');

    if (this.state.raceMode === 'mass-start') {
      this.state.lapRecords = [];
      this.renderLapList();
    }

    ['l1', 'l2'].forEach(id => {
      const el = document.getElementById(`${id}-time`);
      if (el && el.firstChild) el.firstChild.textContent = '0';
      const ms = document.getElementById(`${id}-ms`);
      if (ms) ms.textContent = '.000s';
      this.setStatus(id, 'CHO BAT DAU', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
    });
  },

  async customLock() {
    await this.api.post('/api/stop');
    if (this.state.raceMode === 'qualifying') {
      document.getElementById('modal-round-select').classList.add('active');
    } else {
      this.showToast('Da ghi nhan lenh CHOT!');
    }
  },

  completeQualifying(topN) {
    document.getElementById('modal-round-select').classList.remove('active');
    this.saveCurrentDrafts();
    const drafts = this.state.raceDraft;
    let results = [];

    this.state.currentCandidates.forEach((c, index) => {
      const d = drafts[index] || { time: 0, penalty: 0 };
      const penaltySeconds = d.penalty === 'DQ' ? 9999 : (parseInt(d.penalty) || 0) * 0.2;
      results.push({ name: c.name, dob: c.dob, total: d.time + penaltySeconds, rank: 0, originalIndex: index });
    });

    results.forEach(r => { if (r.total === 0) r.total = 9999; });
    results.sort((a, b) => {
      if (a.total === b.total) return a.originalIndex - b.originalIndex;
      return a.total - b.total;
    });

    const topResults = results.slice(0, topN).map((r, i) => {
      r.rank = i + 1;
      return r;
    });

    this.state.top16 = topResults;
    this.state.bracketSize = topN;

    this.saveToLocal();
    const roundNames = { 16: 'Vòng 1/16', 8: 'Vòng 1/8', 4: 'Vòng 1/4', 2: 'Chung kết' };
    this.showToast(`Đã chọn Top ${topN}. Tạo Bracket ${roundNames[topN]}...`);
    this.navigate('bracket');
    this.generateBracket();
  },

  generateBracket() {
    const container = document.getElementById('bracket-container');

    if (!this.state.top16 || this.state.top16.length === 0) {
      if (this.state.currentCandidates && this.state.currentCandidates.length > 0) {
        // Tự động bật modal chọn chế độ chốt để nó tự động lấy từ trên xuống
        document.getElementById('modal-round-select').classList.add('active');
      } else {
        container.innerHTML = `<div class="bk-empty">Chưa có dữ liệu vận động viên.<br>Vui lòng Import CSV trước.</div>`;
      }
      return;
    }

    const topData = this.state.top16;
    const bracketSize = this.state.bracketSize || 16;

    // Pad VĐV nếu thiếu
    const seeds = [];
    for (let i = 1; i <= bracketSize; i++) {
      seeds[i] = topData[i - 1] || { name: '---', rank: i };
    }

    // Hàm tạo các cặp đấu theo thứ tự chuẩn single-elimination
    const buildSeededMatches = (n, s) => {
      if (n === 2) return [[s[1], s[2]]];
      if (n === 4) return [[s[1], s[4]], [s[3], s[2]]];
      if (n === 8) return [
        [s[1], s[8]], [s[4], s[5]],
        [s[3], s[6]], [s[7], s[2]],
      ];
      // n === 16
      return [
        [s[1], s[16]], [s[8], s[9]],
        [s[4], s[13]], [s[5], s[12]],
        [s[3], s[14]], [s[6], s[11]],
        [s[7], s[10]], [s[2], s[15]],
      ];
    };

    const matches = buildSeededMatches(bracketSize, seeds);

    const pm = (p1, p2) => `
      <div class="bk-match" onclick="app.startBracketMatch(${p1.rank}, ${p2.rank})">
        <div class="bk-player"><span class="bk-seed">#${p1.rank}</span><span class="bk-name" style="display:flex; flex-direction:column;"><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p1.name}</span>${p1.dob ? `<span style="font-size:8.5px; color:rgba(150,180,255,0.6); font-weight:500; margin-top:-2px;">${p1.dob}</span>` : ''}</span></div>
        <div class="bk-sep"></div>
        <div class="bk-player"><span class="bk-seed">#${p2.rank}</span><span class="bk-name" style="display:flex; flex-direction:column;"><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p2.name}</span>${p2.dob ? `<span style="font-size:8.5px; color:rgba(150,180,255,0.6); font-weight:500; margin-top:-2px;">${p2.dob}</span>` : ''}</span></div>
      </div>`;

    const tbd = () => `
      <div class="bk-match bk-match-tbd" onclick="app.showToast('Vui lòng hoàn thành vòng đấu trước đó!')">
        <div class="bk-player bk-tbd"><span class="bk-name">TBD</span></div>
        <div class="bk-sep"></div>
        <div class="bk-player bk-tbd"><span class="bk-name">TBD</span></div>
      </div>`;

    // Xây dựng các cột bracket theo từng kích thước
    const roundLabels = {
      16: 'Vòng 1/16',
      8: 'Tứ kết (1/8)',
      4: 'Bán kết',
      2: 'Chung kết'
    };

    let html = '<div class="bwc-bracket bk-std">';

    // ── Cột đầu tiên: các cặp đấu thật ──
    const firstRoundLabel = roundLabels[bracketSize];
    html += `<div class="bwc-col bwc-r16"><div class="bk-round-label">${firstRoundLabel}</div>`;

    if (bracketSize >= 8) {
      // Nhóm 2 cặp đấu vào 1 group
      for (let g = 0; g < matches.length; g += 2) {
        html += `<div class="bwc-group bwc-group-left">${pm(...matches[g])}${pm(...matches[g + 1])}</div>`;
      }
    } else if (bracketSize === 4) {
      html += `<div class="bwc-group bwc-group-left">${pm(...matches[0])}${pm(...matches[1])}</div>`;
    } else {
      // bracketSize === 2: 1 trận duy nhất
      html += pm(...matches[0]);
    }
    html += '</div>';

    // ── Các cột tiếp theo (TBD) ──
    let remaining = bracketSize / 2;
    const nextRounds = [];
    if (bracketSize === 16) nextRounds.push({ n: 8, label: 'Vòng 1/8', cls: 'bwc-qf' });
    if (bracketSize >= 8) nextRounds.push({ n: 4, label: 'Vòng 1/4', cls: 'bwc-sf' });
    if (bracketSize >= 4) nextRounds.push({ n: 2, label: 'Chung kết', cls: 'bwc-final' });

    for (const round of nextRounds) {
      html += `<div class="bwc-col ${round.cls}"><div class="bk-round-label">${round.label}</div>`;
      const numMatches = round.n / 2;
      if (numMatches >= 2) {
        for (let g = 0; g < numMatches; g += 2) {
          html += `<div class="bwc-group bwc-group-left">${tbd()}${g + 1 < numMatches ? tbd() : ''}</div>`;
        }
      } else {
        html += tbd();
      }
      html += '</div>';
    }


    html += '</div>';

    container.innerHTML = html;
  },

  startBracketMatch(rank1, rank2) {
    const p1 = this.state.top16.find(x => x.rank === rank1) || { name: '---', dob: '' };
    const p2 = this.state.top16.find(x => x.rank === rank2) || { name: '---', dob: '' };
    const name1 = p1.name;
    const name2 = p2.name;

    if (name1 === '---' || name2 === '---') {
      this.showToast('Chưa đủ vận động viên cho trận đấu này!');
      return;
    }

    // Set lanes manually for this specific match without destroying the global array
    this.state.lane1Idx = this.state.currentCandidates.findIndex(x => x.name === name1) || 0;
    this.state.lane2Idx = this.state.currentCandidates.findIndex(x => x.name === name2) || 1;

    // Switch to race view
    this.state.raceMode = 'qualifying'; // Reuse qualifying UI
    this.state.layoutMode = 'pk'; // Bracket is always PK mode
    this.state.isBracketMatch = true; // Đánh dấu là đang đấu bracket
    this.navigate('race-view', 'pro');

    document.querySelector('.rv-lanes-wrap').classList.remove('solo-mode');
    const swapBtn = document.getElementById('btn-swap-lanes');
    if (swapBtn) swapBtn.style.display = 'flex';

    // Reset display and set names
    ['l1', 'l2'].forEach(id => {
      document.getElementById(`${id}-time`).firstChild.textContent = '0';
      document.getElementById(`${id}-ms`).textContent = '.000s';
      document.getElementById(`${id}-pen`).innerText = '0';
      this.setStatus(id, 'Đang chờ bắt đầu');
    });

    document.getElementById('rv-title').innerText = 'THI ĐẤU ĐỐI KHÁNG';
    document.getElementById('rv-nav-wrap').style.display = 'none';
    document.getElementById('btn-custom-lock').style.display = 'flex';
    document.getElementById('btn-rv-next').style.display = 'none';

    // Khôi phục hiển thị Penalty cho chế độ Bracket
    document.querySelectorAll('.rv-pen-wrap').forEach(el => el.style.display = '');

    // Ẩn triệt để panel bằng inline style (chống mọi lỗi ghi đè class)
    const candPanel = document.getElementById('rv-cand-panel');
    if (candPanel) {
      candPanel.classList.remove('active');
      candPanel.setAttribute('style', 'display: none !important;');
      document.getElementById('l1-cand-list').innerHTML = '';
      document.getElementById('l2-cand-list').innerHTML = '';
    }

    const formatMatchName = (p) => {
      if (!p.dob) return p.name;
      return `<div style="line-height:1.2;">${p.name}</div><div style="font-size:11.5px; color:rgba(180,200,255,0.65); font-weight:600; margin-top:1px;">${p.dob}</div>`;
    };

    document.getElementById('l1-name').innerHTML = formatMatchName(p1);
    document.getElementById('l2-name').innerHTML = formatMatchName(p2);

    this.showToast(`Bắt đầu trận đấu: ${name1} vs ${name2}`);
  },

  // ── 6. MODULE DỮ LIỆU (CSV) ──
  processCSV() {
    const file = document.getElementById('csv-file').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => this.parseCSV(e.target.result);
    reader.readAsText(file, 'UTF-8');
  },

  parseCSV(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length <= 1) {
      this.showToast("File trống hoặc sai định dạng!");
      return;
    }
    this.state.currentCandidates = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length >= 2) {
        this.state.currentCandidates.push({ name: cols[0].trim(), dob: cols[1].trim() });
      }
    }
    this.renderCSVPreview();
  },

  renderCSVPreview() {
    const tbody = document.querySelector('#candidate-table tbody');
    tbody.innerHTML = this.state.currentCandidates.map((c, i) => `
      <tr><td>${i + 1}</td><td><strong>${c.name}</strong></td><td>${c.dob}</td></tr>
    `).join('');
    document.getElementById('total-candidates').innerText = this.state.currentCandidates.length;
    if (this.state.tournamentName) {
      document.getElementById('tournament-name').value = this.state.tournamentName;
    }
    document.getElementById('csv-preview').classList.remove('hidden');
  },

  saveTournament() {
    let name = document.getElementById('tournament-name').value.trim();
    if (!name) name = "Giải Đấu Cấp Tốc";
    this.state.tournamentName = name;

    if (this.state.currentCandidates.length === 0) {
      this.showToast('Danh sách VĐV đang trống, hãy Import CSV!');
      return;
    }
    this.saveToLocal();
    // Xóa draft cũ khi load giải mới
    localStorage.removeItem('qualifying_draft');
    this.showToast('Dã lưu! Bắt đầu Vòng loại...');
    this.openRaceView('qualifying', 'solo');
  },

  saveSettings() {
    this.showToast('Da luu cau hinh ESP32!');
  },

  // ============================================================
  //  TIMER MODE (Mode 3 = dem nguoc, Mode 4 = dem toi)
  // ============================================================
  showTimerModal() {
    document.getElementById('modal-timer-select').classList.add('active');
  },

  openTimer(timerMode) {
    this.state.timerMode = (timerMode === 4) ? 4 : 3;
    this.navigate('timer-view', 'timer-view');
    document.getElementById('timer-title').innerText =
      (this.state.timerMode === 3) ? 'DEM NGUOC' : 'DEM TOI';
    document.getElementById('timer-target-input').value = this.state.timerTarget;
    this._updateTimerDisplay(this.state.timerTarget * 1000, '#a0e0ff');
    document.getElementById('timer-status').innerText = 'CHO BAT DAU';
  },

  async timerStart() {
    const tgt = parseInt(document.getElementById('timer-target-input').value) || 0;
    this.state.timerTarget = Math.max(0, Math.min(9999, tgt));
    await this.api.post('/api/mode', { m: this.state.timerMode });
    await this.api.post('/api/target', { s: this.state.timerTarget });
    await this.api.post('/api/arm');
    await this.api.post('/api/start');
    document.getElementById('timer-status').innerText = 'DANG CHAY';
    this._startTimerPoll();
  },

  async timerPause() {
    await this.api.post('/api/pause');
    document.getElementById('timer-status').innerText = 'TAM DUNG';
  },

  async timerResume() {
    await this.api.post('/api/resume');
    document.getElementById('timer-status').innerText = 'DANG CHAY';
  },

  async timerStop() {
    await this.api.post('/api/stop');
    document.getElementById('timer-status').innerText = 'DA DUNG';
    this._stopTimerPoll();
  },

  async timerReset() {
    await this.api.post('/api/reset');
    document.getElementById('timer-status').innerText = 'CHO BAT DAU';
    this._stopTimerPoll();
    this._updateTimerDisplay(this.state.timerTarget * 1000, '#a0e0ff');
  },

  _startTimerPoll() {
    this._stopTimerPoll();
    this.state.pollInterval = setInterval(() => this._pollTimer(), 200);
  },
  _stopTimerPoll() {
    if (this.state.pollInterval) { clearInterval(this.state.pollInterval); this.state.pollInterval = null; }
  },

  async _pollTimer() {
    const data = await this.api.get('/api/status');
    if (!data || !data.mode) return;
    const s1 = data.slave1 || {};
    const elapsedMs = (s1.sec || 0) * 1000 + (s1.ms || 0);
    let color = '#a0e0ff';
    if (data.mState === 4) color = '#ff8080';
    else if (data.mState === 3) color = '#ffcc40';
    this._updateTimerDisplay(elapsedMs, color);
    if (data.mState === 4) {
      document.getElementById('timer-status').innerText = 'KET THUC';
      this._stopTimerPoll();
    }
  },

  _updateTimerDisplay(totalMs, color) {
    const sec = Math.floor(totalMs / 1000);
    const txt = String(sec).padStart(2, '0');
    const el = document.getElementById('timer-big');
    if (el) {
      el.textContent = txt;
      el.style.color = color || '#a0e0ff';
    }
  },

  // ============================================================
  //  COUNTER MODE (Mode 5 = dem cam bien doc lap)
  // ============================================================
  async openCounter() {
    this.navigate('counter-view', 'counter-view');
    await this.api.post('/api/mode', { m: 5 });
    await this.api.post('/api/arm');
    this._startCounterPoll();
  },

  async counterSet(slave) {
    const inputId = (slave === 1) ? 'cnt1-input' : 'cnt2-input';
    let v = parseInt(document.getElementById(inputId).value) || 0;
    v = Math.max(0, Math.min(9999, v));
    await this.api.post('/api/set', { slave: slave, v: v });
    if (slave === 1) this.state.counter1 = v; else this.state.counter2 = v;
    this._renderCounters();
  },

  async counterReset(slave) {
    await this.api.post('/api/set', { slave: slave, v: 0 });
    if (slave === 1) this.state.counter1 = 0; else this.state.counter2 = 0;
    this._renderCounters();
  },

  async counterClose() {
    this._stopCounterPoll();
    await this.api.post('/api/reset');
    this.navigate('dashboard');
  },

  _startCounterPoll() {
    this._stopCounterPoll();
    this.state.statusPollInterval = setInterval(() => this._pollCounter(), 300);
  },
  _stopCounterPoll() {
    if (this.state.statusPollInterval) {
      clearInterval(this.state.statusPollInterval);
      this.state.statusPollInterval = null;
    }
  },

  async _pollCounter() {
    const data = await this.api.get('/api/status');
    if (!data || !data.slave1 || !data.slave2) return;
    this.state.counter1 = data.slave1.value || data.slave1.sec || 0;
    this.state.counter2 = data.slave2.value || data.slave2.sec || 0;
    this._renderCounters();
  },

  _renderCounters() {
    const e1 = document.getElementById('cnt1-big');
    const e2 = document.getElementById('cnt2-big');
    if (e1) e1.textContent = String(this.state.counter1).padStart(2, '0');
    if (e2) e2.textContent = String(this.state.counter2).padStart(2, '0');
  }
};

document.addEventListener('DOMContentLoaded', () => app.init());
