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
    lane1Elapsed: 0,
    lane2Elapsed: 0,
    lapCount: 0,
    tournamentName: "Giải đấu trượt Patin chuyên nghiệp",
    lane1Idx: 0,
    lane2Idx: 1,
    bracketLaneSwapped: false, // đối kháng: đã hoán đổi làn (ghi kết quả theo p1/p2 đúng)
    lapRecords: [],
    timeLapseSeq: 0,
    // Vòng loại 2 lượt
    qualPass: 1,          // lượt hiện tại: 1 hoặc 2
    qualOrder: [],        // thứ tự chạy (mảng index VĐV) của lượt hiện tại
    qualPos: 0,           // vị trí hiện tại trong qualOrder
    qualRun1: {},         // {candIdx: {time, penalty}} kết quả lượt 1
    qualRun2: {},         // kết quả lượt 2
    // Giai đoạn 2: bracket loại trực tiếp
    bracket: null,        // {size, rounds:[[match...]], third, placement}
    currentMatch: null,   // trận đang đấu: {round, idx} hoặc {third:true}
    // Timer mode (3/4) state
    timerMode: 3,           // 3 = dem nguoc, 4 = dem toi
    timerTarget: 60,
    // Counter mode (5) state
    counter1: 0,
    counter2: 0,
    // Polling
    pollInterval: null,
    _statusBusy: false,
    _pushDisplayTimer: null,
    _pendingDisplayOpts: null,
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
    get(path, params) { return this._do('GET', path, params); }
  },

  // ── KHỞI TẠO ──
  async init() {
    await this.loadStateFromServer(); // Tải lại dữ liệu từ server trước
    await this.loadSettingsFromServer();
    this.checkAuth();
    this.startClock();
    this.startBackgroundPoll(); // Bắt đầu poll trạng thái nền
  },

  async loadSettingsFromServer() {
    try {
      const data = await this.api.get('/api/status');
      if (data && data.colorSlave1) {
        const sel1 = document.getElementById('color-slave1');
        const sel2 = document.getElementById('color-slave2');
        if (sel1) sel1.value = data.colorSlave1;
        if (sel2) sel2.value = data.colorSlave2;
      }
    } catch (e) {
      console.error("Error loading color settings:", e);
    }
  },

  async loadStateFromServer() {
    // 1. Tải main state từ server
    try {
      const r = await fetch('/api/load-state');
      if (r.ok) {
        const data = await r.json();
        if (data && Array.isArray(data.candidates) && data.candidates.length > 0) {
          this.state.currentCandidates = data.candidates;
          this.state.top16 = data.top16 || [];
          this.state.bracketSize = data.bracketSize || 16;
          this.state.tournamentName = data.tournamentName || "";
          this.state.qualRun1 = data.qualRun1 || {};
          this.state.qualRun2 = data.qualRun2 || {};
          this.state.bracket = data.bracket || null;
        }
      }
    } catch (e) { }

    // 2. Tải qualifying session từ server
    try {
      const r = await fetch('/api/load-session');
      if (r.ok) {
        const saved = await r.json();
        const n = this.state.currentCandidates.length;
        if (saved && saved.n === n && Array.isArray(saved.qualOrder) && saved.qualOrder.length === n) {
          this.state.qualPass = saved.qualPass || 1;
          this.state.qualOrder = saved.qualOrder;
          this.state.qualPos = saved.qualPos || 0;
          this.state.qualRun1 = saved.qualRun1 || {};
          this.state.qualRun2 = saved.qualRun2 || {};
          this.state.raceDraft = saved.raceDraft || {};
          if (typeof saved.lane1Idx === 'number') this.state.lane1Idx = saved.lane1Idx;
          if (typeof saved.lane2Idx === 'number') this.state.lane2Idx = saved.lane2Idx;
        }
      }
    } catch (e) { }
  },

  async apiSaveStateServer(data) {
    try {
      const r = await fetch('/api/save-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!r.ok) {
        this.showToast('Lỗi: ESP32 từ chối lưu trạng thái!');
      }
    } catch (e) {
      this.showToast('Lỗi kết nối: Không thể gửi trạng thái lên ESP32!');
    }
  },

  async apiSaveSessionServer(sess) {
    try {
      const r = await fetch('/api/save-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sess)
      });
      if (!r.ok) {
        this.showToast('Lỗi: ESP32 từ chối lưu phiên chạy!');
      }
    } catch (e) {
      this.showToast('Lỗi kết nối: Không thể gửi phiên chạy lên ESP32!');
    }
  },

  startBackgroundPoll() {
    if (this.state.statusPollInterval) clearInterval(this.state.statusPollInterval);
    this.state.backgroundTick = 0;
    this.state.statusPollInterval = setInterval(async () => {
      const activePage = document.querySelector('.page.active');
      const pageId = activePage ? activePage.id : '';
      // Trang đua / hẹn giờ / đếm: không poll nền (tránh chồng request với điều khiển)
      if (pageId === 'timer-view' || pageId === 'counter-view' || pageId === 'race-view') return;
      if (this.state.pollInterval) return;

      // Đồng bộ CSV/bracket từ ESP ~30s khi rảnh (không làm mỗi giây)
      this.state.backgroundTick++;
      if (this.state.backgroundTick % 12 === 0 && !this.state.swRunning) {
        await this.loadStateFromServer();
        if (activePage) {
          if (pageId === 'add-tournament' || pageId === 'pro') {
            this.renderCSVPreview();
          } else if (pageId === 'bracket') {
            this.generateBracket();
          }
        }
      }

      if (this.state.swRunning) return;

      try {
        const data = await this.api.get('/api/status');
        if (!data || !data.mode) return;

        const mst = data.mState; // 0=IDLE, 1=ARMED, 2=RUNNING, 3=PAUSED, 4=FINISHED

        if (mst === 1 || mst === 2 || mst === 3) {
          this.state.swRunning = true;
          this._startPolling();
        } else {
          if (mst === 4) {
            const winner = data.winner;
            const w1 = (data.mode === 2 && winner === 1) ? ' (THANG)' : '';
            const w2 = (data.mode === 2 && winner === 2) ? ' (THANG)' : '';
            this.setStatus('l1', 'KET THUC' + w1, '#80ffaa', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
            this.setStatus('l2', 'KET THUC' + w2, '#80ffaa', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
          } else {
            this.setStatus('l1', 'CHO BAT DAU', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
            this.setStatus('l2', 'CHO BAT DAU', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
          }
        }
      } catch (e) { }
    }, 2500);
  },

  saveToLocal() {
    const data = {
      candidates: this.state.currentCandidates,
      top16: this.state.top16,
      bracketSize: this.state.bracketSize || 16,
      tournamentName: this.state.tournamentName,
      qualRun1: this.state.qualRun1 || {},
      qualRun2: this.state.qualRun2 || {},
      bracket: this.state.bracket || null
    };
    this.apiSaveStateServer(data);
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

    // Vào trang Import/Danh sách mà đã có dữ liệu thì hiện lại bảng + thống kê
    if ((pageId === 'pro' || pageId === 'add-tournament') && this.state.currentCandidates.length > 0) {
      this.renderCSVPreview();
    }
    if (pageId === 'settings') {
      this.loadSettingsFromServer();
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

  // ── Màn hình display.html (poll ESP chậm, không nhảy số khi đang chạy) ──
  _displayRev: 0,

  _formatDisplayTime(elapsedMs) {
    if (!elapsedMs || elapsedMs <= 0) {
      return { timeMain: '-', timeMs: '.---s' };
    }
    const msPart = elapsedMs % 1000;
    const totalSecs = Math.floor(elapsedMs / 1000);
    return {
      timeMain: String(totalSecs),
      timeMs: `.${String(msPart).padStart(3, '0')}s`
    };
  },

  _laneDisplayFromUi(laneId, includeTimes) {
    const nameEl = document.getElementById(`${laneId}-name`);
    const penEl = document.getElementById(`${laneId}-pen`);
    const name = nameEl ? nameEl.innerHTML : '---';
    const penalty = penEl ? penEl.innerText.trim() : '0';
    let timeMain = '-';
    let timeMs = '.---s';
    if (includeTimes) {
      const orig = laneId === 'l1'
        ? (this.state.lane1OriginalElapsed != null ? this.state.lane1OriginalElapsed : this.state.lane1Elapsed)
        : (this.state.lane2OriginalElapsed != null ? this.state.lane2OriginalElapsed : this.state.lane2Elapsed);
      const fmt = this._formatDisplayTime(orig || 0);
      timeMain = fmt.timeMain;
      timeMs = fmt.timeMs;
      if (penalty === 'DQ') {
        timeMain = 'DQ';
        timeMs = '';
      }
    }
    return { name, penalty, timeMain, timeMs };
  },

  _currentDisplayRound() {
    const cm = this.state.currentMatch;
    const bk = this.state.bracket;
    if (!this.state.isBracketMatch || !cm || !bk) return 1;
    const match = cm.third ? bk.third : bk.rounds[cm.round][cm.idx];
    return (match && match.games) ? match.games.length + 1 : 1;
  },

  // Màn chiếu: vòng loại = 1 làn, đối kháng = 2 làn (theo chế độ đang chạy, không cho chọn tay)
  _displayLaneLayout() {
    if (this.state.isBracketMatch) return 'pk';
    if (this.state.raceMode === 'qualifying') return 'solo';
    return this.state.layoutMode === 'solo' ? 'solo' : 'pk';
  },

  _displayGameDots() {
    const cm = this.state.currentMatch;
    const bk = this.state.bracket;
    if (!this.state.isBracketMatch || !cm || !bk) {
      return { lane1: [], lane2: [], bestOf: 5 };
    }
    const match = cm.third ? bk.third : bk.rounds[cm.round][cm.idx];
    const bestOf = bk.bestOf || 5;
    const games = (match && match.games) || [];
    const dotsFor = (side) => {
      const dots = [];
      for (let i = 0; i < bestOf; i++) {
        const g = games[i];
        dots.push(g ? (g.winner === side ? 'win' : 'lose') : 'idle');
      }
      return dots;
    };
    return { lane1: dotsFor(1), lane2: dotsFor(2), bestOf };
  },

  buildDisplayPayload(opts = {}) {
    const includeTimes = opts.includeTimes === true;
    const phase = opts.phase || (this.state.swRunning ? 'running' : 'idle');
    this._displayRev += 1;
    const titleEl = document.getElementById('rv-title');
    return {
      rev: this._displayRev,
      phase,
      title: titleEl ? titleEl.innerText : 'KẾT QUẢ',
      layoutMode: this._displayLaneLayout(),
      currentRound: this._currentDisplayRound(),
      gameDots: this._displayGameDots(),
      lane1: this._laneDisplayFromUi('l1', includeTimes),
      lane2: this._laneDisplayFromUi('l2', includeTimes)
    };
  },

  pushDisplayState(opts = {}, immediate = false) {
    this._pendingDisplayOpts = { ...(this._pendingDisplayOpts || {}), ...opts };
    if (this.state._pushDisplayTimer) clearTimeout(this.state._pushDisplayTimer);
    const send = () => {
      this.state._pushDisplayTimer = null;
      const merged = this._pendingDisplayOpts || {};
      this._pendingDisplayOpts = null;
      const body = this.buildDisplayPayload(merged);
      return fetch('/api/save-display', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(() => {});
    };
    if (immediate) {
      return send();
    }
    return new Promise(resolve => {
      this.state._pushDisplayTimer = setTimeout(() => resolve(send()), 80);
    });
  },

  // ── 4. MODULE RACE VIEW (TẬP LUYỆN & VÒNG LOẠI) ──


  // Hoán đổi thời gian đang hiển thị giữa 2 làn (slave1 vẫn map làn1, slave2 → làn2)
  swapLaneElapsedState() {
    [this.state.lane1Elapsed, this.state.lane2Elapsed] = [
      this.state.lane2Elapsed, this.state.lane1Elapsed
    ];
    [this.state.lane1OriginalElapsed, this.state.lane2OriginalElapsed] = [
      this.state.lane2OriginalElapsed, this.state.lane1OriginalElapsed
    ];
    this.updateLaneTimeDisplay('l1', this.state.lane1Elapsed);
    this.updateLaneTimeDisplay('l2', this.state.lane2Elapsed);
  },

  // Đổi tên, penalty, thời gian, chấm ván (bracket) trên UI
  swapLaneVisuals(htmlNames = true) {
    const n1 = document.getElementById('l1-name');
    const n2 = document.getElementById('l2-name');
    if (n1 && n2) {
      if (htmlNames) {
        const t = n1.innerHTML;
        n1.innerHTML = n2.innerHTML;
        n2.innerHTML = t;
      } else {
        const t = n1.innerText;
        n1.innerText = n2.innerText;
        n2.innerText = t;
      }
    }
    const p1 = document.getElementById('l1-pen');
    const p2 = document.getElementById('l2-pen');
    if (p1 && p2) {
      const t = p1.innerText;
      p1.innerText = p2.innerText;
      p2.innerText = t;
    }
    this.swapLaneElapsedState();
    const g1 = document.getElementById('l1-games');
    const g2 = document.getElementById('l2-games');
    if (g1 && g2 && g1.style.display !== 'none') {
      const t = g1.innerHTML;
      g1.innerHTML = g2.innerHTML;
      g2.innerHTML = t;
    }
  },

  swapLanes() {
    if (this.state.layoutMode === 'solo') return;

    if (this.state.isBracketMatch) {
      this.swapLaneVisuals(true);
      this.state.bracketLaneSwapped = !this.state.bracketLaneSwapped;
    } else if (this.state.raceMode === 'training') {
      this.swapLaneVisuals(false);
    } else {
      // Vòng loại: đổi VĐV trên làn — slave1↔làn1, slave2↔làn2; draft theo index VĐV
      this.saveCurrentDrafts();
      const tempIdx = this.state.lane1Idx;
      this.state.lane1Idx = this.state.lane2Idx;
      this.state.lane2Idx = tempIdx;
      this.saveQualSession();
      this.renderLanes();
    }

    this.pushDisplayState({ phase: this.state.swRunning ? 'running' : 'idle', includeTimes: !this.state.swRunning });
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
    this.state.bracketLaneSwapped = false;
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
    // Ẩn game dots (chỉ dùng cho bracket)
    this.renderGameDots(null);

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
      this.pushDisplayState({ phase: 'idle', includeTimes: false }, true);
    } else {
      if (this.state.currentCandidates.length === 0) {
        this.showToast('Danh sách VĐV đang trống! Hãy Import CSV trước.');
        this.navigate('pro'); return;
      }
      document.getElementById('rv-nav-wrap').style.display = 'flex';
      document.getElementById('btn-rv-next').style.display = 'flex';
      document.getElementById('btn-custom-lock').style.display = 'flex';
      const candPanel = document.getElementById('rv-cand-panel');
      if (candPanel) { candPanel.style.display = ''; }

      // Khôi phục phiên vòng loại đang dở (nếu có), ngược lại khởi tạo mới
      const n = this.state.currentCandidates.length;
      if (this.state.qualOrder && this.state.qualOrder.length === n) {
        // Sử dụng dữ liệu đã load từ server
        this.applyLayoutUI();
        this.applyQualPos();
      } else {
        this.state.qualPass = 1;
        this.state.qualOrder = Array.from({ length: n }, (_, i) => i);
        this.state.qualPos = 0;
        this.state.qualRun1 = {};
        this.state.qualRun2 = {};
        this.state.raceDraft = {};
        this.applyQualPos();
      }
      this.updateQualTitle();
      this.renderLanes();
      this.saveQualSession();
    }
  },

  openMassStart() {
    this.state.raceMode = 'mass-start';
    this.state.layoutMode = 'solo';
    this.state.isBracketMatch = false;
    this.state.lapRecords = [];
    this.state.timeLapseSeq = 0;

    this.navigate('race-view', 'mass-start');

    document.querySelector('.rv-lanes-wrap').classList.add('solo-mode');

    const swapBtn = document.getElementById('btn-swap-lanes');
    if (swapBtn) swapBtn.style.display = 'none';

    document.getElementById('l1-time').firstChild.textContent = '0';
    document.getElementById('l1-ms').textContent = '.000s';
    document.getElementById('l1-pen').innerText = '0';
    this.setStatus('l1', 'CHO BAM START', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');

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

  addTimeLapseRecord(ms) {
    if (this.state.raceMode !== 'mass-start') return;
    if (this.state.lapRecords.length >= 20) return;

    const totalSecs = Math.floor(ms / 1000);
    const msPart = ms % 1000;
    const timeStr = `${totalSecs}.${String(msPart).padStart(3, '0')}s`;
    this.state.lapRecords.push({
      idx: this.state.lapRecords.length + 1,
      time: timeStr,
      timeMs: ms
    });
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

  renderLapList() {
    const listEl = document.getElementById('lap-list');
    if (!listEl) return;

    let html = '';
    for (let i = 1; i <= 20; i++) {
      const rec = this.state.lapRecords[i - 1];
      html += rec ? `
        <div class="lap-item filled fade-up">
          <span class="lap-idx">Vòng ${i}</span>
          <span class="lap-time">${rec.time}</span>
        </div>
      ` : `
        <div class="lap-item">
          <span class="lap-idx">Vòng ${i}</span>
          <span class="lap-time" style="font-family:'JetBrains Mono',monospace;">--.---s</span>
        </div>
      `;
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
    const order = this.state.qualOrder;

    // Fallback: nếu chưa có thứ tự vòng loại thì dùng index thô (an toàn cho bracket)
    if (!order || order.length === 0) {
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
      this.pushDisplayState({ phase: 'idle', includeTimes: false }, true);
      return;
    }

    const step = this.state.layoutMode === 'solo'
      ? (offset > 0 ? 1 : -1)
      : (offset > 0 ? 2 : -2);
    let pos = this.state.qualPos + step;
    if (pos < 0) pos = 0;
    if (pos > order.length - 1) pos = order.length - 1;
    this.state.qualPos = pos;
    this.applyQualPos();
    this.saveQualSession(); // Lưu vị trí mới lên server ngay, tránh background poll restore lại vị trí cũ
    this.renderLanes();
    this.resetRaceLogic();
    this.pushDisplayState({ phase: 'idle', includeTimes: false }, true);
  },

  // Đặt lane1Idx/lane2Idx theo vị trí qualPos trong thứ tự chạy hiện tại
  applyQualPos() {
    const order = this.state.qualOrder;
    if (!order || order.length === 0) return;
    const pos = this.state.qualPos;
    this.state.lane1Idx = order[pos];
    if (this.state.layoutMode === 'solo') {
      this.state.lane2Idx = order[pos];
    } else {
      const p2 = (pos + 1 <= order.length - 1) ? pos + 1 : pos;
      this.state.lane2Idx = order[p2];
    }
  },

  saveCurrentDrafts() {
    if (this.state.raceMode !== 'qualifying' || this.state.currentCandidates.length === 0) return;

    const orig1 = this.state.lane1OriginalElapsed != null ? this.state.lane1OriginalElapsed : this.state.lane1Elapsed;
    const orig2 = this.state.lane2OriginalElapsed != null ? this.state.lane2OriginalElapsed : this.state.lane2Elapsed;
    const tSec1 = (orig1 || 0) / 1000;
    const tSec2 = (orig2 || 0) / 1000;

    // Đọc điểm penalty (số nguyên) và lưu nguyên gốc vào draft
    const pen1Raw = document.getElementById('l1-pen').innerText;
    const pen2Raw = document.getElementById('l2-pen').innerText;
    const pen1 = pen1Raw === 'DQ' ? 'DQ' : parseInt(pen1Raw) || 0;
    const pen2 = pen2Raw === 'DQ' ? 'DQ' : parseInt(pen2Raw) || 0;

    const i1 = this.state.lane1Idx;
    if (this.state.currentCandidates[i1]) {
      // Chỉ lưu time nếu có chạy, để tránh đè time = 0 lên time cũ
      if (tSec1 > 0 || !this.state.raceDraft[i1]) {
        this.state.raceDraft[i1] = { time: tSec1, penalty: pen1 };
      } else {
        this.state.raceDraft[i1].penalty = pen1;
      }
    }

    const i2 = this.state.lane2Idx;
    if (this.state.layoutMode !== 'solo' && this.state.currentCandidates[i2]) {
      if (tSec2 > 0 || !this.state.raceDraft[i2]) {
        this.state.raceDraft[i2] = { time: tSec2, penalty: pen2 };
      } else {
        this.state.raceDraft[i2].penalty = pen2;
      }
    }
    this.saveQualSession();
  },

  // Lưu toàn bộ phiên vòng loại để khôi phục khi tải lại trang
  saveQualSession() {
    if (this.state.raceMode !== 'qualifying' || this.state.isBracketMatch) return;
    const sess = {
      n: this.state.currentCandidates.length,
      qualPass: this.state.qualPass,
      qualOrder: this.state.qualOrder,
      qualPos: this.state.qualPos,
      qualRun1: this.state.qualRun1,
      qualRun2: this.state.qualRun2,
      raceDraft: this.state.raceDraft,
      layoutMode: this.state.layoutMode,
      lane1Idx: this.state.lane1Idx,
      lane2Idx: this.state.lane2Idx
    };
    this.apiSaveSessionServer(sess);
  },

  // Áp dụng giao diện solo/pk theo layoutMode hiện tại
  applyLayoutUI() {
    const lanesWrap = document.querySelector('.rv-lanes-wrap');
    const swapBtn = document.getElementById('btn-swap-lanes');
    if (this.state.layoutMode === 'solo') {
      if (lanesWrap) lanesWrap.classList.add('solo-mode');
      if (swapBtn) swapBtn.style.display = 'none';
    } else {
      if (lanesWrap) lanesWrap.classList.remove('solo-mode');
      if (swapBtn) swapBtn.style.display = 'flex';
    }
  },

  renderLanes() {
    const idx1 = this.state.lane1Idx;
    const idx2 = this.state.lane2Idx;
    const total = this.state.currentCandidates.length;
    const order = this.state.qualOrder;
    const usingOrder = order && order.length > 0;
    const pos = this.state.qualPos;
    // Số thứ tự hiển thị: vị trí trong lượt chạy (qualOrder) nếu có, ngược lại index thô
    const n1 = usingOrder ? pos + 1 : idx1 + 1;
    const n2 = usingOrder ? Math.min(pos + 2, total) : idx2 + 1;

    if (this.state.layoutMode === 'solo') {
      document.getElementById('race-nav-status').innerText = `${n1} / ${total}`;
    } else {
      document.getElementById('race-nav-status').innerText = `${n1} & ${n2} / ${total}`;
    }

    const c1 = this.state.currentCandidates[idx1];
    const c2 = this.state.currentCandidates[idx2];

    const d1 = this.state.raceDraft[idx1] || { time: 0, penalty: 0 };
    const d2 = this.state.raceDraft[idx2] || { time: 0, penalty: 0 };

    const formatName = (c) => {
      if (!c) return '---';
      const sbd = c.sbd ? `<span style="color:#80b0ff; font-weight:800;">#${c.sbd}</span> ` : '';
      const sub = [c.dob, c.province].filter(Boolean).join(' · ');
      const nameLine = `<div style="line-height:1.2;">${sbd}${c.name}</div>`;
      if (!sub) return nameLine;
      return `${nameLine}<div style="font-size:11.5px; color:rgba(180,200,255,0.65); font-weight:600; margin-top:1px;">${sub}</div>`;
    };

    document.getElementById('l1-name').innerHTML = formatName(c1);
    document.getElementById('l1-pen').innerText = d1.penalty;

    document.getElementById('l2-name').innerHTML = formatName(c2);
    document.getElementById('l2-pen').innerText = d2.penalty;

    // Load original and elapsed states from draft if pre-existing
    const penVal1 = d1.penalty === 'DQ' ? 0 : parseInt(d1.penalty) || 0;
    const penVal2 = d2.penalty === 'DQ' ? 0 : parseInt(d2.penalty) || 0;

    if (d1.penalty === 'DQ') {
      this.state.lane1OriginalElapsed = d1.time * 1000;
      this.state.lane1Elapsed = 0;
    } else if (penVal1 > 0) {
      this.state.lane1OriginalElapsed = d1.time * 1000;
      this.state.lane1Elapsed = d1.time * 1000 + penVal1 * 200;
    } else {
      this.state.lane1OriginalElapsed = null;
      this.state.lane1Elapsed = d1.time * 1000;
    }

    if (d2.penalty === 'DQ') {
      this.state.lane2OriginalElapsed = d2.time * 1000;
      this.state.lane2Elapsed = 0;
    } else if (penVal2 > 0) {
      this.state.lane2OriginalElapsed = d2.time * 1000;
      this.state.lane2Elapsed = d2.time * 1000 + penVal2 * 200;
    } else {
      this.state.lane2OriginalElapsed = null;
      this.state.lane2Elapsed = d2.time * 1000;
    }

    // Nếu có time đã chạy trước đó, set l1-time
    this.updateLaneTimeDisplay('l1', this.state.lane1Elapsed);
    this.updateLaneTimeDisplay('l2', this.state.lane2Elapsed);

    // Render danh sách VĐV bấm chọn nhanh
    this.renderCandidateList();
    const hasSavedTime = (d1.time || 0) > 0 || (d2.time || 0) > 0;
    this.pushDisplayState({
      phase: this.state.swRunning ? 'running' : 'idle',
      includeTimes: hasSavedTime && !this.state.swRunning
    });
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
    const run1 = this.state.qualRun1 || {};
    const run2 = this.state.qualRun2 || {};
    const pass = this.state.qualPass;
    const i1 = this.state.lane1Idx;
    const i2 = this.state.lane2Idx;

    // Thứ tự hiển thị = thứ tự chạy của lượt hiện tại (hiện từng VĐV theo trình tự)
    const order = (this.state.qualOrder && this.state.qualOrder.length)
      ? this.state.qualOrder
      : candidates.map((_, i) => i);

    const formatTime = (sec) => {
      if (!sec || sec <= 0) return '--.---';
      const s = Math.floor(sec);
      const ms = Math.floor((sec * 1000) % 1000);
      return `${s}.${String(ms).padStart(3, '0')}`;
    };

    // Thời gian từng lượt: lượt đang chạy lấy từ raceDraft, lượt đã xong lấy từ qualRun
    // Hiển thị thời gian đã cộng penalty (giống CSV) để nhất quán
    const runTime = (idx, which) => {
      const src = (which === 1)
        ? (pass === 1 ? drafts[idx] : run1[idx])
        : (pass === 2 ? drafts[idx] : run2[idx]);
      if (!src || src.time <= 0) return 0;
      if (src.penalty === 'DQ') return 0; // DQ → hiện --.---
      const pen = (parseInt(src.penalty) || 0) * 0.2;
      return src.time + pen;
    };

    const buildHtml = (targetLane) => {
      return order.map((idx) => {
        const c = candidates[idx];
        if (!c) return '';
        const t1 = runTime(idx, 1);
        const t2 = runTime(idx, 2);
        const hasTimed = t1 > 0 || t2 > 0;
        const isActive = (targetLane === 1) ? (idx === i1) : (idx === i2);
        let cls = 'rv-cand-item';
        if (isActive) cls += ' active';
        else if (hasTimed) cls += ' done';
        const sbd = c.sbd ? `<span class="ci-rank">${c.sbd}</span>` : `<span class="ci-rank">${idx + 1}.</span>`;
        return `<div class="${cls}" onclick="app.jumpToCandidate(${targetLane}, ${idx})">
          ${sbd}
          <span class="ci-name">${c.name}${c.dob ? ` <span style="font-size:10.5px; color:rgba(150,190,255,0.55); font-weight:500;">(${c.dob})</span>` : ''}</span>
          <span class="ci-time" style="display:flex; flex-direction:column; line-height:1.25; text-align:right;">
            <span style="font-size:11px;"><span style="color:rgba(150,190,255,0.6);">L1</span> ${formatTime(t1)}</span>
            <span style="font-size:11px;"><span style="color:rgba(150,190,255,0.6);">L2</span> ${formatTime(t2)}</span>
          </span>
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
      // Đồng bộ vị trí trong lượt chạy theo VĐV vừa chọn
      const order = this.state.qualOrder;
      if (order && order.length > 0) {
        const p = order.indexOf(targetIdx);
        if (p >= 0) this.state.qualPos = p;
      }
    } else {
      if (targetIdx === this.state.lane1Idx) {
        this.showToast('VĐV này đang thi đấu ở Làn 1!');
        return;
      }
      this.saveCurrentDrafts();
      this.state.lane2Idx = targetIdx;
    }

    this.saveQualSession(); // Lưu vị trí mới lên server ngay, tránh background poll restore lại vị trí cũ
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

  setPenalty(laneArg, points) {
    const lane = Number(laneArg);
    const isSolo = this.state.layoutMode === 'solo';
    const lanes = isSolo ? [1, 2] : [lane];

    const penEl = document.getElementById(`l${lane}-pen`);
    if (!penEl) return;
    const currentPenText = penEl.innerText.trim();

    if (points !== 0 && points !== '0') {
      // Locking logic: if a penalty is already set (not '0'), we block choosing another penalty
      if (currentPenText !== '0') {
        if (currentPenText !== String(points)) {
          this.showToast('Vui lòng ấn CLR để xóa lỗi cũ trước!');
        }
        return;
      }

      // First time setting penalty: save the original elapsed time
      lanes.forEach(l => {
        if (l === 1) {
          if (this.state.lane1OriginalElapsed === undefined || this.state.lane1OriginalElapsed === null) {
            this.state.lane1OriginalElapsed = this.state.lane1Elapsed;
          }
        } else {
          if (this.state.lane2OriginalElapsed === undefined || this.state.lane2OriginalElapsed === null) {
            this.state.lane2OriginalElapsed = this.state.lane2Elapsed;
          }
        }
      });

      if (points === 'DQ') {
        lanes.forEach(l => {
          const el = document.getElementById(`l${l}-pen`);
          if (el) el.innerText = 'DQ';

          if (l === 1) {
            this.state.lane1Elapsed = 0;
          } else {
            this.state.lane2Elapsed = 0;
          }

          // Update display on web UI to 0.000
          this.updateLaneTimeDisplay(`l${l}`, 0);
        });

        this.showToast(isSolo ? 'DQ - Loại khỏi vòng đấu!' : `Làn ${lane}: DQ - Loại khỏi vòng đấu!`);

        // Update display on slave LED board to 0.000
        fetch(`/api/slave-time?slave=${lane}&ms=0`, { method: 'POST' })
          .catch(err => console.error("Error setting slave time for DQ:", err));
      } else {
        let finalNewTimeMs = 0;
        lanes.forEach(l => {
          const el = document.getElementById(`l${l}-pen`);
          if (el) el.innerText = points;

          // Add 0.2s * points to the display time
          const originalTime = l === 1 ? this.state.lane1OriginalElapsed : this.state.lane2OriginalElapsed;
          const newTimeMs = (originalTime || 0) + points * 200;

          if (l === 1) {
            this.state.lane1Elapsed = newTimeMs;
            finalNewTimeMs = newTimeMs;
          } else {
            this.state.lane2Elapsed = newTimeMs;
          }

          // Update display on web UI immediately
          this.updateLaneTimeDisplay(`l${l}`, newTimeMs);
        });

        const secs = (points * 0.2).toFixed(1);
        this.showToast(isSolo ? `Lỗi: ${points} điểm (+${secs}s)` : `Làn ${lane}: Lỗi: ${points} điểm (+${secs}s)`);

        // Update display on slave LED board via ESP32 endpoint
        fetch(`/api/slave-time?slave=${lane}&ms=${finalNewTimeMs}`, { method: 'POST' })
          .catch(err => console.error("Error setting slave time:", err));
      }
    } else {
      // CLR clicked (points === 0)
      lanes.forEach(l => {
        const el = document.getElementById(`l${l}-pen`);
        if (el) el.innerText = '0';
      });
      this.showToast(isSolo ? 'Đã xóa penalty' : `Làn ${lane}: Đã xóa penalty`);

      // Restore original time
      let restoredTime1 = null;
      let restoredTime2 = null;

      if (this.state.lane1OriginalElapsed !== undefined && this.state.lane1OriginalElapsed !== null) {
        restoredTime1 = this.state.lane1OriginalElapsed;
        this.state.lane1Elapsed = restoredTime1;
        this.state.lane1OriginalElapsed = null;
        this.updateLaneTimeDisplay('l1', restoredTime1);
      }

      if (this.state.lane2OriginalElapsed !== undefined && this.state.lane2OriginalElapsed !== null) {
        restoredTime2 = this.state.lane2OriginalElapsed;
        this.state.lane2Elapsed = restoredTime2;
        this.state.lane2OriginalElapsed = null;
        this.updateLaneTimeDisplay('l2', restoredTime2);
      }

      const fetchTime = lane === 1 ? restoredTime1 : restoredTime2;
      if (fetchTime !== null) {
        // Send restored time to ESP32 board
        fetch(`/api/slave-time?slave=${lane}&ms=${fetchTime}`, { method: 'POST' })
          .catch(err => console.error("Error restoring slave time:", err));
      }
    }

    if (this.state.raceMode === 'qualifying') this.saveCurrentDrafts();
    if (!this.state.swRunning) {
      this.pushDisplayState({ phase: 'done', includeTimes: true }, true);
    }
  },

  swTick() {
    // KHONG dem gio o day — thoi gian poll tu ESP32.
  },

  // Map giao dien -> mode slave (1..6)
  modeForRace() {
    if (this.state.raceMode === 'mass-start') return 6;
    const lm = this.state.layoutMode;
    // SOLO = mode 1 (slave1 = cong start, slave2 = cong finish, master dem)
    // PK / bracket = mode 2 (2 lan thi dau song song), Time lapse = mode 6.
    return (lm === 'solo') ? 1 : 2;
  },

  async startRace() {
    const mode = this.modeForRace();
    const isTimeLapse = this.state.raceMode === 'mass-start';
    const status = await this.api.get('/api/status');
    if (status && status.mode === mode && status.mState === 3) {
      await this.api.post('/api/resume');
      this.state.swRunning = true;
      this.state.swStart = Date.now();
      if (mode === 6) {
        this.setStatus('l1', 'DANG DEM...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      } else {
        this.setStatus('l1', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
        this.setStatus('l2', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      }
      await this.pushDisplayState({ phase: 'running', includeTimes: false }, true);
      this._startPolling();
      return;
    }

    // Reset hiển thị về 0 trước khi poll bắt đầu (xóa thời gian cũ từ draft)
    this.state.lane1Elapsed = 0;
    this.state.lane2Elapsed = 0;
    this.state.lane1OriginalElapsed = null;
    this.state.lane2OriginalElapsed = null;
    this.state.timeLapseSeq = 0;
    if (isTimeLapse) {
      this.state.lapRecords = [];
      this.state.timeLapseSeq = 0;
      this.renderLapList();
    }
    ['l1', 'l2'].forEach(id => {
      const el = document.getElementById(`${id}-time`);
      if (el && el.firstChild) el.firstChild.textContent = '0';
      const ms = document.getElementById(`${id}-ms`);
      if (ms) ms.textContent = '.000s';
    });

    this.state.swRunning = true;
    this.state.swStart = Date.now();
    if (mode === 6) {
      this.setStatus('l1', 'CHO CAM BIEN BAT DAU...', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
      this.setStatus('l2', 'CHO CAM BIEN BAT DAU...', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
    } else if (mode === 1) {
      this.setStatus('l1', 'CHO CAM BIEN START...', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
      this.setStatus('l2', 'CHO CAM BIEN START...', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
    } else {
      this.setStatus('l1', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      this.setStatus('l2', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
    }
    await this.pushDisplayState({ phase: 'running', includeTimes: false }, true);

    await this.api.post('/api/mode', { m: mode });
    await this.api.post('/api/arm');
    // Mode 1: master cung gui SIG_START -> 2 slave hien effect hinh vuong NGAY.
    // Master se cho cam bien slave 1 trigger moi bat dau dem.
    await this.api.post('/api/start');
    this._startPolling();
  },

  _startPolling() {
    if (this.state.pollInterval) clearInterval(this.state.pollInterval);
    this.state._statusBusy = false;
    // 80ms + chỉ 1 request /api/status tại một thời điểm (tránh reset TCP trên ESP AP)
    this.state.pollInterval = setInterval(() => {
      if (this.state._statusBusy) return;
      this.pollLEDTime();
    }, 80);
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
    if (this.state._statusBusy) return;
    this.state._statusBusy = true;
    let data;
    try {
      data = await this.api.get('/api/status');
    } finally {
      this.state._statusBusy = false;
    }
    if (!data || !data.mode) return;

    const mode = data.mode;
    const mst = data.mState; // 0=IDLE 1=ARMED 2=RUNNING 3=PAUSED 4=FINISHED

    if (mode === 6 && this.state.raceMode === 'mass-start') {
      const seq = data.timeLapseSeq || 0;
      if (seq > (this.state.timeLapseSeq || 0)) {
        this.state.timeLapseSeq = seq;
        this.addTimeLapseRecord(data.timeLapseMs || 0);
      }
    }

    let lane1Ms = 0, lane2Ms = 0;
    if (mode === 1 && mst !== 4 && mst !== 0) {
      // Master holds the timer; bua thoi gian giong nhau o 2 lan
      lane1Ms = lane2Ms = data.masterMs || 0;
    } else {
      const s1 = data.slave1 || {}, s2 = data.slave2 || {};
      const raw1 = (s1.sec || 0) * 1000 + (s1.ms || 0);
      const raw2 = (s2.sec || 0) * 1000 + (s2.ms || 0);
      // slave1 → làn1, slave2 → làn2 (sau swap chỉ đổi VĐV trên làn, không đảo sensor)
      lane1Ms = raw1;
      lane2Ms = raw2;
    }
    this.updateLaneTimeDisplay('l1', lane1Ms);
    if (this.state.layoutMode !== 'solo') this.updateLaneTimeDisplay('l2', lane2Ms);
    this.state.swElapsed = Math.max(lane1Ms, lane2Ms);
    this.state.lane1Elapsed = lane1Ms;
    this.state.lane2Elapsed = lane2Ms;

    // Mode 1: khi cam bien start trigger (master da vao RUNNING)
    if (mode === 1 && mst === 2 && this.state.swRunning) {
      this.setStatus('l1', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      this.setStatus('l2', 'DANG CHAY...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
    }

    if (mode === 6 && this.state.swRunning) {
      if (mst === 1) {
        this.setStatus('l1', 'CHO CAM BIEN BAT DAU...', '#ffcc40', 'rgba(255,190,30,0.18)', 'rgba(255,190,30,0.45)');
      } else if (mst === 2) {
        this.setStatus('l1', 'DANG DEM...', '#40ff80', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      }
    }

    // FINISHED -> dung poll
    if (mst === 4) {
      this._stopPolling();
      this.state.swRunning = false;
      const winner = data.winner; // 1 / 2 / 0 (vd mode 1 thi 0)
      this.state.lastWinner = winner; // dùng phân định hòa ở trận bracket
      const w1 = (mode === 2 && winner === 1) ? ' (THANG)' : '';
      const w2 = (mode === 2 && winner === 2) ? ' (THANG)' : '';
      this.setStatus('l1', 'KET THUC' + w1, '#80ffaa', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      this.setStatus('l2', 'KET THUC' + w2, '#80ffaa', 'rgba(0,180,80,0.2)', 'rgba(0,200,80,0.5)');
      this.pushDisplayState({ phase: 'done', includeTimes: true }, true);
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
    this.state.lane1Elapsed = 0;
    this.state.lane2Elapsed = 0;
    this.state.lane1OriginalElapsed = null;
    this.state.lane2OriginalElapsed = null;
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
      const pen = document.getElementById(`${id}-pen`);
      if (pen) pen.innerText = '0';
    });
    this.pushDisplayState({ phase: 'idle', includeTimes: false }, true);
  },

  async customLock() {
    this._stopPolling();
    this.state.swRunning = false;
    await this.api.post('/api/stop');

    // Trận bracket: ghi kết quả, tiến vòng
    if (this.state.isBracketMatch) {
      this.recordBracketResult();
      return;
    }
    if (this.state.raceMode !== 'qualifying') {
      this.showToast('Da ghi nhan lenh CHOT!');
      return;
    }

    this.saveCurrentDrafts();

    if (this.state.qualPass === 1) {
      // ── Kết thúc Lượt 1 ──
      this.state.qualRun1 = JSON.parse(JSON.stringify(this.state.raceDraft || {}));
      await this.saveResultsCsv('luot1');

      // Sắp xếp thứ tự chạy Lượt 2: chậm nhất (tổng lớn nhất) chạy trước
      const order = this.state.currentCandidates.map((c, i) => i);
      order.sort((a, b) => {
        const ta = this.draftTotal(this.state.qualRun1[a]);
        const tb = this.draftTotal(this.state.qualRun1[b]);
        if (tb === ta) return a - b;
        return tb - ta; // giảm dần
      });

      this.state.qualOrder = order;
      this.state.qualPos = 0;
      this.state.qualPass = 2;
      this.state.raceDraft = {};
      this.applyQualPos();
      this.updateQualTitle();
      this.renderLanes();
      this.saveQualSession();
      this.saveToLocal();
      this.showToast('Xong Lượt 1! Lượt 2 chạy ngược: VĐV chậm nhất chạy trước.');
    } else {
      // ── Kết thúc Lượt 2 ──
      this.state.qualRun2 = JSON.parse(JSON.stringify(this.state.raceDraft || {}));
      this.saveQualSession();
      this.saveToLocal();
      await this.saveResultsCsv('luot2');
      document.getElementById('modal-round-select').classList.add('active');
    }
  },

  // Chuẩn bị ván tiếp theo của trận bracket (ở lại màn đua, không về sơ đồ)
  async prepareNextGame(match) {
    await this.resetRaceLogic();   // reset đồng hồ + ESP32 + status các làn
    this.state.bracketLaneSwapped = false;
    this.state.lastWinner = 0;
    document.getElementById('l1-pen').innerText = '0';
    document.getElementById('l2-pen').innerText = '0';
    const bestOf = (this.state.bracket && this.state.bracket.bestOf) || 5;
    const gameNo = (match.games ? match.games.length : 0) + 1;
    document.getElementById('rv-title').innerText =
      `ĐỐI KHÁNG · Ván ${Math.min(gameNo, bestOf)}/${bestOf} (${match.wins1 || 0}-${match.wins2 || 0})`;
    // Vẫn ở chế độ đấu bracket để CHỐT lần sau ghi tiếp vào trận này
    this.state.isBracketMatch = true;
    this.renderGameDots(match);
    this.pushDisplayState({ phase: 'idle', includeTimes: false }, true);
  },

  // Render 5 chấm tròn tỉ số ván (lane 1 vs lane 2) lên giao diện
  renderGameDots(match) {
    const el1 = document.getElementById('l1-games');
    const el2 = document.getElementById('l2-games');
    if (!el1 || !el2) return;

    if (!match) {
      el1.style.display = 'none';
      el2.style.display = 'none';
      return;
    }

    const bestOf = (this.state.bracket && this.state.bracket.bestOf) || 5;
    const games = match.games || [];

    const buildDots = (side) => {
      let html = '';
      for (let i = 1; i <= bestOf; i++) {
        const g = games[i - 1];
        let cls = 'rv-gdot';
        if (g) {
          cls += g.winner === side ? ' win' : ' lose';
        }
        html += `<span class="${cls}">${i}</span>`;
      }
      return html;
    };

    el1.innerHTML = buildDots(1);
    el2.innerHTML = buildDots(2);
    el1.style.display = 'flex';
    el2.style.display = 'flex';
  },

  // Ghi kết quả 1 VÁN của trận bracket (best-of-5). Đủ 3 ván thắng = vào vòng trong.
  recordBracketResult() {
    const bk = this.state.bracket;
    const cm = this.state.currentMatch;
    if (!bk || !cm) { this.showToast('Không rõ trận đang đấu!'); this.navigate('bracket'); return; }

    const match = cm.third ? bk.third : bk.rounds[cm.round][cm.idx];
    if (!match) { this.navigate('bracket'); return; }

    // Tương thích bracket cũ chưa có cấu trúc best-of-5
    if (!Array.isArray(match.games)) { match.games = []; match.wins1 = 0; match.wins2 = 0; }
    const winTarget = bk.winTarget || 3;
    const bestOf = bk.bestOf || 5;

    if (match.done) { this.showToast('Trận này đã kết thúc!'); this.navigate('bracket'); this.generateBracket(); return; }

    let pen1Raw = document.getElementById('l1-pen').innerText.trim();
    let pen2Raw = document.getElementById('l2-pen').innerText.trim();
    const penSec = (raw) => raw === 'DQ' ? 90000 : (parseInt(raw) || 0) * 0.2;
    let t1 = (this.state.lane1OriginalElapsed != null ? this.state.lane1OriginalElapsed : this.state.lane1Elapsed || 0) / 1000;
    let t2 = (this.state.lane2OriginalElapsed != null ? this.state.lane2OriginalElapsed : this.state.lane2Elapsed || 0) / 1000;
    // Sau swap làn: làn1 hiện p2, làn2 hiện p1 — map lại về p1/p2 khi ghi ván
    if (this.state.bracketLaneSwapped) {
      [t1, t2] = [t2, t1];
      [pen1Raw, pen2Raw] = [pen2Raw, pen1Raw];
    }
    const pen1 = penSec(pen1Raw);
    const pen2 = penSec(pen2Raw);
    const total1 = (pen1Raw === 'DQ') ? 99999 : ((t1 <= 0) ? 9999 : t1 + pen1);
    const total2 = (pen2Raw === 'DQ') ? 99999 : ((t2 <= 0) ? 9999 : t2 + pen2);

    // Nhanh hơn thắng ván; bằng nhau dùng winner cảm biến (1=slave1, 2=slave2)
    let g1wins;
    if (total1 === total2) {
      let w = this.state.lastWinner;
      if (this.state.bracketLaneSwapped && w) w = w === 1 ? 2 : 1;
      g1wins = w !== 2;
    }
    else g1wins = total1 < total2;

    // Lưu thời gian từng ván (để xem trực tiếp)
    match.games.push({
      t1: total1 < 9999 ? total1 : 0,
      t2: total2 < 9999 ? total2 : 0,
      winner: g1wins ? 1 : 2
    });
    if (g1wins) match.wins1++; else match.wins2++;

    this.renderGameDots(match);
    this.pushDisplayState({ phase: 'done', includeTimes: true }, true);

    // Hiển thị thời gian ván gần nhất lên ô trận
    match.t1 = total1 < 9999 ? total1 : 0;
    match.t2 = total2 < 9999 ? total2 : 0;

    const decided = match.wins1 >= winTarget || match.wins2 >= winTarget || match.games.length >= bestOf;

    if (!decided) {
      // Chưa phân thắng bại: Ở LẠI màn đua, chuẩn bị ván tiếp theo ngay
      this.saveToLocal();
      this.saveResultsCsv('bracket');   // lưu thời gian ván vừa đấu lên thiết bị
      this.prepareNextGame(match);
      this.showToast(`Ván ${match.games.length}/${bestOf} xong: ${match.wins1} - ${match.wins2}. Bấm START đấu ván tiếp.`);
      return;
    }

    // Đã phân thắng bại
    const p1wins = match.wins1 > match.wins2;
    match.winner = p1wins ? match.p1 : match.p2;
    match.loser = p1wins ? match.p2 : match.p1;
    match.done = true;

    if (cm.third) {
      bk.placement[3] = match.winner;
      bk.placement[4] = match.loser;
    } else {
      const lastRound = bk.rounds.length - 1;
      if (cm.round === lastRound) {
        // Chung kết
        bk.placement[1] = match.winner;
        bk.placement[2] = match.loser;
      } else {
        // Tiến vòng sau
        const nIdx = Math.floor(cm.idx / 2);
        const slot = (cm.idx % 2 === 0) ? 'p1' : 'p2';
        bk.rounds[cm.round + 1][nIdx][slot] = match.winner;
      }
      // Sau bán kết (vòng áp chót, >= 2 trận): tạo trận tranh hạng 3 khi cả 2 bán kết xong
      const semiRound = bk.rounds.length - 2;
      if (cm.round === semiRound && bk.size >= 4 && !bk.third) {
        const semis = bk.rounds[semiRound];
        if (semis.length === 2 && semis.every(m => m.done)) {
          bk.third = {
            p1: semis[0].loser, p2: semis[1].loser,
            games: [], wins1: 0, wins2: 0, t1: 0, t2: 0, winner: null, loser: null, done: false
          };
        }
      }
    }

    this.state.currentMatch = null;
    this.state.isBracketMatch = false;
    this.saveToLocal();
    this.saveResultsCsv('bracket');   // lưu toàn bộ thời gian các ván lên thiết bị
    this.navigate('bracket');
    this.generateBracket();
    this.showToast(`Kết thúc trận: ${match.wins1} - ${match.wins2}!`);
  },

  // Tổng thời gian 1 lượt của 1 VĐV (giây). Chưa chạy / DQ = 9999.
  draftTotal(d) {
    if (!d) return 99999;
    if (d.penalty === 'DQ') return 99999;
    const pen = (parseInt(d.penalty) || 0) * 0.2;
    const t = d.time || 0;
    if (t <= 0) return 99999;
    return t + pen;
  },

  updateQualTitle() {
    const el = document.getElementById('rv-title');
    if (!el) return;
    el.innerText = this.state.qualPass === 2 ? 'VÒNG LOẠI · LƯỢT 2' : 'VÒNG LOẠI · LƯỢT 1';
  },

  completeQualifying(topN) {
    document.getElementById('modal-round-select').classList.remove('active');
    this.saveCurrentDrafts();
    // Lượt 2 vừa chốt nằm trong raceDraft; đảm bảo qualRun2 cập nhật
    if (this.state.qualPass === 2) {
      this.state.qualRun2 = JSON.parse(JSON.stringify(this.state.raceDraft || {}));
    }
    let results = [];

    this.state.currentCandidates.forEach((c, index) => {
      const t1 = this.draftTotal(this.state.qualRun1[index]);
      const t2 = this.draftTotal(this.state.qualRun2[index]);
      const best = Math.min(t1, t2); // thời gian tốt nhất của 2 lượt
      results.push({ name: c.name, dob: c.dob, province: c.province || '', sbd: c.sbd || '', total: best, rank: 0, originalIndex: index });
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
    this.buildBracketState(topN);

    this.saveToLocal();
    this.apiSaveSessionServer({}); // Xóa session vòng loại cũ khi đã vào bracket
    const roundNames = { 16: 'Vòng 1/16', 8: 'Vòng 1/8', 4: 'Vòng 1/4', 2: 'Chung kết' };
    this.showToast(`Đã chọn Top ${topN}. Tạo Bracket ${roundNames[topN]}...`);
    this.navigate('bracket');
    this.generateBracket();
  },

  // Cặp seed chuẩn single-elimination (trả về rank, không phải object)
  seededPairs(n) {
    if (n <= 2) return [[1, 2]];
    if (n === 4) return [[1, 4], [3, 2]];
    if (n === 8) return [[1, 8], [4, 5], [3, 6], [7, 2]];
    // n === 16
    return [
      [1, 16], [8, 9], [4, 13], [5, 12],
      [3, 14], [6, 11], [7, 10], [2, 15],
    ];
  },

  // Dựng cấu trúc bracket rỗng (slot vòng sau = null/TBD)
  buildBracketState(size) {
    const pairs = this.seededPairs(size);
    // Mỗi trận đấu best-of-5: games = [{t1,t2,winner}], wins1/wins2, winner/loser, done
    const mk = (p1, p2) => ({ p1, p2, games: [], wins1: 0, wins2: 0, t1: 0, t2: 0, winner: null, loser: null, done: false });
    const rounds = [pairs.map(([a, b]) => mk(a, b))];
    let count = pairs.length;            // số trận vòng 0 = size/2
    while (count > 1) {
      count = Math.floor(count / 2);
      const round = [];
      for (let i = 0; i < count; i++) round.push(mk(null, null));
      rounds.push(round);
    }
    this.state.bracket = { size, rounds, third: null, placement: {}, bestOf: 5, winTarget: 3 };
    this.state.currentMatch = null;
  },

  // VĐV theo seed rank (1..size)
  seedAthlete(rank) {
    if (!rank) return null;
    return (this.state.top16 && this.state.top16[rank - 1]) || null;
  },

  generateBracket() {
    const container = document.getElementById('bracket-container');

    // Khôi phục / khởi tạo bracket nếu cần
    if (!this.state.bracket) {
      if (this.state.top16 && this.state.top16.length > 0) {
        this.buildBracketState(this.state.bracketSize || this.state.top16.length);
      } else if (this.state.currentCandidates && this.state.currentCandidates.length > 0) {
        document.getElementById('modal-round-select').classList.add('active');
        return;
      } else {
        container.innerHTML = `<div class="bk-empty">Chưa có dữ liệu vận động viên.<br>Vui lòng Import CSV trước.</div>`;
        return;
      }
    }

    const bk = this.state.bracket;
    const labelByMatches = { 8: 'Vòng 1/16', 4: 'Vòng 1/8', 2: 'Vòng 1/4 (Bán kết)', 1: 'Chung kết' };
    const clsByMatches = { 8: 'bwc-r16', 4: 'bwc-qf', 2: 'bwc-sf', 1: 'bwc-final' };

    const playerRow = (rank, m, side) => {
      const a = this.seedAthlete(rank);
      const name = a ? a.name : 'TBD';
      const wins = side === 1 ? (m.wins1 || 0) : (m.wins2 || 0);
      const isWin = m.done && rank != null && m.winner === rank;
      const isLose = m.done && rank != null && m.loser === rank;
      let cls = 'bk-player';
      if (!a) cls += ' bk-tbd';
      if (isWin) cls += ' bk-win';
      if (isLose) cls += ' bk-lose';
      // Số ván thắng (best-of-5)
      const winBadge = (rank != null) ? `<span class="bk-wins">${wins}</span>` : '';
      const t = side === 1 ? m.t1 : m.t2;
      const tStr = (t > 0) ? `<span class="bk-mtime">${t.toFixed(3)}s</span>` : '';
      return `<div class="${cls}">
        <span class="bk-seed">${rank ? '#' + rank : ''}</span>
        <span class="bk-name" style="display:flex; flex-direction:column;"><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</span>${a && a.dob ? `<span style="font-size:8.5px; color:rgba(150,180,255,0.6); font-weight:500; margin-top:-2px;">${a.dob}</span>` : ''}</span>
        ${winBadge}${tStr}
      </div>`;
    };

    // Lịch sử các ván (xem trực tiếp thời gian từng ván)
    const gamesHtml = (m) => {
      if (!m.games || m.games.length === 0) return '';
      const rows = m.games.map((g, i) => {
        const w1 = g.winner === 1 ? ' bk-g-win' : '';
        const w2 = g.winner === 2 ? ' bk-g-win' : '';
        return `<div class="bk-grow"><span class="bk-gidx">V${i + 1}</span><span class="bk-gt${w1}">${g.t1 ? g.t1.toFixed(3) : '—'}</span><span class="bk-gt${w2}">${g.t2 ? g.t2.toFixed(3) : '—'}</span></div>`;
      }).join('');
      const bestOf = (this.state.bracket.bestOf || 5);
      return `<div class="bk-games"><div class="bk-grow bk-ghead"><span class="bk-gidx">Ván</span><span class="bk-gt">L1</span><span class="bk-gt">L2</span></div>${rows}</div>`;
    };

    const matchBox = (roundArg, idx, m) => {
      const hasBoth = m.p1 != null && m.p2 != null;
      const ready = hasBoth && !m.done;
      let cls = 'bk-match';
      if (m.done) cls += ' bk-done';
      else if (ready) cls += ' bk-ready';
      else cls += ' bk-match-tbd';
      const click = ready
        ? `onclick="app.startBracketMatch('${roundArg}', ${idx})"`
        : (m.done ? '' : `onclick="app.showToast('Chờ vòng đấu trước hoàn thành!')"`);
      // Trạng thái tỉ số
      const bestOf = (this.state.bracket.bestOf || 5);
      let score = '';
      if (hasBoth && (m.games && m.games.length > 0 || m.done)) {
        const tag = m.done ? 'Kết thúc' : `Ván ${m.games.length}/${bestOf}`;
        score = `<div class="bk-score">${tag} · <b>${m.wins1 || 0}-${m.wins2 || 0}</b></div>`;
      } else if (ready) {
        score = `<div class="bk-score">Đấu ${bestOf} ván</div>`;
      }
      return `<div class="${cls}" ${click}>
        ${playerRow(m.p1, m, 1)}
        <div class="bk-sep"></div>
        ${playerRow(m.p2, m, 2)}
        ${score}
        ${gamesHtml(m)}
      </div>`;
    };

    let html = '<div class="bwc-bracket bk-std">';
    bk.rounds.forEach((round, r) => {
      const label = labelByMatches[round.length] || `Vòng (${round.length})`;
      const cls = clsByMatches[round.length] || '';
      html += `<div class="bwc-col ${cls}"><div class="bk-round-label">${label}</div>`;
      for (let g = 0; g < round.length; g += 2) {
        const a = matchBox(r, g, round[g]);
        const b = (g + 1 < round.length) ? matchBox(r, g + 1, round[g + 1]) : '';
        html += `<div class="bwc-group bwc-group-left">${a}${b}</div>`;
      }
      html += '</div>';
    });

    // Cột tranh hạng 3 (nếu có)
    if (bk.third) {
      html += `<div class="bwc-col bwc-third"><div class="bk-round-label">Tranh hạng 3</div>`;
      html += matchBox('third', 0, bk.third);
      html += '</div>';
    }
    html += '</div>';

    // Bảng xếp hạng Nhất / Nhì / Ba / Tư
    const pl = bk.placement || {};
    if (pl[1] || pl[2] || pl[3] || pl[4]) {
      const medals = [
        { r: 1, icon: '🥇', label: 'Nhất', color: '#ffd24a' },
        { r: 2, icon: '🥈', label: 'Nhì', color: '#cfd8e6' },
        { r: 3, icon: '🥉', label: 'Ba', color: '#e0a070' },
        { r: 4, icon: '4️⃣', label: 'Tư', color: '#9fb6e0' },
      ];
      let podium = '<div class="bk-podium"><div class="bk-podium-title">🏆 KẾT QUẢ CHUNG CUỘC</div><div class="bk-podium-grid">';
      for (const m of medals) {
        const a = this.seedAthlete(pl[m.r]);
        podium += `<div class="bk-podium-item" style="border-color:${m.color}44;">
          <span class="bk-podium-icon">${m.icon}</span>
          <span class="bk-podium-rank" style="color:${m.color};">${m.label}</span>
          <span class="bk-podium-name">${a ? a.name : '—'}${a && a.sbd ? ` <small>#${a.sbd}</small>` : ''}</span>
        </div>`;
      }
      podium += '</div></div>';
      html = podium + html;
    }

    container.innerHTML = html;
  },

  // Nhãn kết quả bracket cho 1 VĐV (theo index trong currentCandidates)
  bracketResultOf(candIndex) {
    const bk = this.state.bracket;
    if (!bk || !this.state.top16) return '';
    const seed = this.state.top16.find(x => x.originalIndex === candIndex);
    if (!seed) return '';            // không lọt vào bracket
    const rank = seed.rank;
    const pl = bk.placement || {};
    if (pl[1] === rank) return '🥇 Nhất';
    if (pl[2] === rank) return '🥈 Nhì';
    if (pl[3] === rank) return '🥉 Ba';
    if (pl[4] === rank) return 'Hạng Tư';
    // Tìm vòng sâu nhất bị loại
    const loseLabel = { 8: 'Thua vòng 1/16', 4: 'Thua vòng 1/8', 2: 'Thua bán kết', 1: 'Thua chung kết' };
    for (let r = 0; r < bk.rounds.length; r++) {
      if (bk.rounds[r].some(m => m.done && m.loser === rank)) {
        return loseLabel[bk.rounds[r].length] || 'Bị loại';
      }
    }
    if (bk.third && bk.third.done && bk.third.loser === rank) return 'Hạng Tư';
    return `Vào Top ${bk.size}`;     // còn thi đấu / chưa loại
  },

  // Liệt kê tất cả các ván bracket của 1 VĐV (mọi vòng) → mảng object
  // [{round, game, mine, opp, win}], dùng cho bảng + CSV
  bracketGamesOf(candIndex) {
    const bk = this.state.bracket;
    if (!bk || !this.state.top16) return [];
    const seed = this.state.top16.find(x => x.originalIndex === candIndex);
    if (!seed) return [];
    const rank = seed.rank;
    const roundName = { 8: '1/16', 4: '1/8', 2: 'BK', 1: 'CK' };
    const out = [];
    const scan = (m, label) => {
      if (!m || !m.games || (m.p1 !== rank && m.p2 !== rank)) return;
      const side = (m.p1 === rank) ? 1 : 2;
      m.games.forEach((g, gi) => {
        const mine = side === 1 ? g.t1 : g.t2;
        const opp = side === 1 ? g.t2 : g.t1;
        out.push({ round: label, game: gi + 1, mine, opp, win: g.winner === side });
      });
    };
    bk.rounds.forEach((round) => {
      const label = roundName[round.length] || `V${round.length}`;
      round.forEach(m => scan(m, label));
    });
    if (bk.third) scan(bk.third, 'H3');
    return out;
  },

  // Chuỗi gọn các ván để hiển thị/CSV: "1/16: 12.3|13.1 ✓, ..."
  bracketGamesStr(candIndex) {
    const games = this.bracketGamesOf(candIndex);
    if (!games.length) return '';
    return games.map(g => {
      const mine = g.mine ? g.mine.toFixed(3) : '—';
      const opp = g.opp ? g.opp.toFixed(3) : '—';
      return `${g.round}#${g.game} ${mine}/${opp}${g.win ? '✓' : ''}`;
    }).join('  ');
  },

  // Kiểm tra xem VĐV có tham gia/vào vòng cụ thể không
  hasReachedRound(rank, roundKey) {
    const bk = this.state.bracket;
    if (!bk) return false;
    if (roundKey === '1/16') {
      const r = bk.rounds.find(round => round.length === 8);
      return r ? r.some(m => m.p1 === rank || m.p2 === rank) : false;
    }
    if (roundKey === '1/8') {
      const r = bk.rounds.find(round => round.length === 4);
      return r ? r.some(m => m.p1 === rank || m.p2 === rank) : false;
    }
    if (roundKey === 'BK') {
      const r = bk.rounds.find(round => round.length === 2);
      return r ? r.some(m => m.p1 === rank || m.p2 === rank) : false;
    }
    if (roundKey === 'CK_H3') {
      const r = bk.rounds.find(round => round.length === 1);
      const inCK = r ? r.some(m => m.p1 === rank || m.p2 === rank) : false;
      const inH3 = bk.third ? (bk.third.p1 === rank || bk.third.p2 === rank) : false;
      return inCK || inH3;
    }
    return false;
  },

  // Trả về kết quả thời gian cho game cụ thể trong vòng đấu, '—' nếu bị loại/chưa đấu
  getGameTime(candIndex, roundKey, gameIdx) {
    const bk = this.state.bracket;
    if (!bk || !this.state.top16) return '—';
    const seed = this.state.top16.find(x => x.originalIndex === candIndex);
    if (!seed) return '—';
    const rank = seed.rank;

    if (!this.hasReachedRound(rank, roundKey)) {
      return '—';
    }

    const games = this.bracketGamesOf(candIndex);
    let filtered;
    if (roundKey === 'CK_H3') {
      filtered = games.filter(g => g.round === 'CK' || g.round === 'H3');
    } else {
      filtered = games.filter(g => g.round === roundKey);
    }

    const g = filtered[gameIdx - 1];
    if (!g) {
      return '—';
    }

    if (g.mine === 0) {
      return 'DQ';
    }
    return `${g.mine.toFixed(3)}${g.win ? '✓' : ''}`;
  },

  startBracketMatch(roundArg, idx) {
    const bk = this.state.bracket;
    if (!bk) { this.showToast('Chưa có sơ đồ thi đấu!'); return; }
    const isThird = (roundArg === 'third');
    const match = isThird ? bk.third : bk.rounds[Number(roundArg)][idx];
    if (!match || match.p1 == null || match.p2 == null) {
      this.showToast('Chưa đủ vận động viên cho trận đấu này!');
      return;
    }

    const p1 = this.seedAthlete(match.p1) || { name: '---', dob: '' };
    const p2 = this.seedAthlete(match.p2) || { name: '---', dob: '' };
    const name1 = p1.name;
    const name2 = p2.name;

    // Ghi nhận trận đang đấu để chốt xong biết ghi kết quả vào đâu
    this.state.currentMatch = isThird ? { third: true } : { round: Number(roundArg), idx };

    // Set lanes manually for this specific match without destroying the global array
    this.state.lane1Idx = typeof p1.originalIndex === 'number' ? p1.originalIndex : 0;
    this.state.lane2Idx = typeof p2.originalIndex === 'number' ? p2.originalIndex : 1;

    // Switch to race view
    this.state.raceMode = 'qualifying'; // Reuse qualifying UI
    this.state.layoutMode = 'pk'; // Bracket is always PK mode
    this.state.isBracketMatch = true; // Đánh dấu là đang đấu bracket
    this.state.bracketLaneSwapped = false;
    this.navigate('race-view', 'pro');

    document.querySelector('.rv-lanes-wrap').classList.remove('solo-mode');
    const swapBtn = document.getElementById('btn-swap-lanes');
    if (swapBtn) swapBtn.style.display = 'flex';

    // Reset thời gian làn cho ván mới
    this.state.lane1Elapsed = 0;
    this.state.lane2Elapsed = 0;
    this.state.lane1OriginalElapsed = null;
    this.state.lane2OriginalElapsed = null;
    this.state.lastWinner = 0;

    // Reset display and set names
    ['l1', 'l2'].forEach(id => {
      document.getElementById(`${id}-time`).firstChild.textContent = '0';
      document.getElementById(`${id}-ms`).textContent = '.000s';
      document.getElementById(`${id}-pen`).innerText = '0';
      this.setStatus(id, 'Đang chờ bắt đầu');
    });

    // Tiêu đề: hiện số ván đang đấu (best-of-5)
    const bestOf = bk.bestOf || 5;
    const gameNo = (match.games ? match.games.length : 0) + 1;
    document.getElementById('rv-title').innerText =
      `ĐỐI KHÁNG · Ván ${Math.min(gameNo, bestOf)}/${bestOf} (${match.wins1 || 0}-${match.wins2 || 0})`;
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

    this.renderGameDots(match);
    this.pushDisplayState({ phase: 'idle', includeTimes: false }, true);
    this.showToast(`Bắt đầu trận đấu: ${name1} vs ${name2}`);
  },

  // Định dạng giây -> chuỗi "x.xxx" (rỗng nếu chưa chạy/DQ)
  fmtSec(total) {
    if (!total || total >= 9999) return '';
    return total.toFixed(3);
  },

  getCandidateRankScore(i) {
    const bk = this.state.bracket;
    const t1_draft = this.state.qualRun1[i] || (this.state.qualPass === 1 ? this.state.raceDraft[i] : null);
    const t2_draft = this.state.qualRun2[i] || (this.state.qualPass === 2 ? this.state.raceDraft[i] : null);
    const t1 = this.draftTotal(t1_draft);
    const t2 = this.draftTotal(t2_draft);
    const bestTime = Math.min(t1, t2);

    if (bk && this.state.top16) {
      const seed = this.state.top16.find(x => x.originalIndex === i);
      if (seed) {
        const rank = seed.rank;
        const pl = bk.placement || {};
        if (pl[1] === rank) return 1;
        if (pl[2] === rank) return 2;
        if (pl[3] === rank) return 3;
        if (pl[4] === rank) return 4;

        for (let r = bk.rounds.length - 1; r >= 0; r--) {
          const roundMatches = bk.rounds[r];
          if (roundMatches.some(m => m.done && m.loser === rank)) {
            const matchCount = roundMatches.length;
            const baseRank = matchCount + 1;
            return baseRank + (bestTime / 10000);
          }
        }
        return 4.5;
      }
    }
    return 100 + (bestTime / 10000);
  },

  getSortedLeaderboard() {
    const cands = this.state.currentCandidates;
    const list = cands.map((c, i) => {
      const t1_draft = this.state.qualRun1[i] || (this.state.qualPass === 1 ? this.state.raceDraft[i] : null);
      const t2_draft = this.state.qualRun2[i] || (this.state.qualPass === 2 ? this.state.raceDraft[i] : null);
      const t1 = this.draftTotal(t1_draft);
      const t2 = this.draftTotal(t2_draft);
      const best = Math.min(t1, t2);
      const score = this.getCandidateRankScore(i);
      return {
        candidate: c,
        originalIndex: i,
        t1,
        t2,
        best,
        score
      };
    });
    list.sort((a, b) => a.score - b.score);
    return list;
  },

  // Xuất kết quả vòng loại ra file CSV trên ESP32 (LittleFS)
  async saveResultsCsv(stage) {
    const sortedList = this.getSortedLeaderboard();
    if (!sortedList.length) return;

    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const withBracket = (stage === 'bracket');
    let csv = withBracket
      ? 'Xếp hạng,SBD,Họ và Tên,Ngày sinh,Tỉnh,Lần 1,Lần 2,Tốt nhất,Kết quả,' +
      '1/16-V1,1/16-V2,1/16-V3,1/16-V4,1/16-V5,' +
      '1/8-V1,1/8-V2,1/8-V3,1/8-V4,1/8-V5,' +
      'BK-V1,BK-V2,BK-V3,BK-V4,BK-V5,' +
      'CK-V1,CK-V2,CK-V3,CK-V4,CK-V5\n'
      : 'Xếp hạng,SBD,Họ và Tên,Ngày sinh,Tỉnh,Lần 1,Lần 2,Tốt nhất\n';
    sortedList.forEach((item, i) => {
      const c = item.candidate;
      const row = [
        i + 1, esc(c.sbd || ''), esc(c.name), esc(c.dob), esc(c.province || ''),
        this.fmtSec(item.t1), this.fmtSec(item.t2), this.fmtSec(item.best)
      ];
      if (withBracket) {
        row.push(esc(this.bracketResultOf(item.originalIndex)));
        ['1/16', '1/8', 'BK', 'CK_H3'].forEach(round => {
          for (let g = 1; g <= 5; g++) {
            row.push(esc(this.getGameTime(item.originalIndex, round, g)));
          }
        });
      }
      csv += row.join(',') + '\n';
    });

    const fname = stage === 'luot1' ? 'ket_qua_luot1'
      : stage === 'bracket' ? 'ket_qua_bracket'
        : 'ket_qua_vong_loai';
    try {
      const r = await fetch(`/api/save-csv?name=${encodeURIComponent(fname)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: csv
      });
      if (r.ok) this.showToast(`Đã lưu ${fname}.csv lên thiết bị.`);
      else this.showToast('Lưu CSV thất bại: HTTP ' + r.status);
    } catch (e) {
      this.showToast('Không lưu được CSV: ' + e.message);
    }
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

    // Reset toàn bộ session và bracket cũ trong RAM khi import giải mới
    this.state.currentCandidates = [];
    this.state.top16 = [];
    this.state.bracketSize = 16;
    this.state.bracket = null;
    this.state.currentMatch = null;
    this.state.qualRun1 = {};
    this.state.qualRun2 = {};
    this.state.qualOrder = [];
    this.state.qualPos = 0;
    this.state.qualPass = 1;
    this.state.raceDraft = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length >= 2) {
        this.state.currentCandidates.push({
          name: cols[0].trim(),
          dob: cols[1].trim(),
          province: (cols[2] || '').trim(),
          sbd: (cols[3] || '').trim()
        });
      }
    }

    // Xóa triệt để các session/draft và state cũ trong localStorage để không bị nạp đè lỗi
    localStorage.removeItem('patin_pro_state');
    localStorage.removeItem('qualifying_draft');
    localStorage.removeItem('qualifying_session');

    this.saveToLocal();
    this.apiSaveSessionServer({}); // Xóa session cũ trên server
    this.renderCSVPreview();
  },

  renderCSVPreview() {
    const tbody = document.querySelector('#candidate-table tbody');
    if (!tbody) return;
    const sortedList = this.getSortedLeaderboard();
    tbody.innerHTML = sortedList.map((item, i) => {
      const c = item.candidate;
      const f = (v) => this.fmtSec(v) || '—';
      const kq = this.bracketResultOf(item.originalIndex) || '—';
      const rounds = ['1/16', '1/8', 'BK', 'CK_H3'];
      let roundCells = '';
      rounds.forEach(round => {
        for (let g = 1; g <= 5; g++) {
          const val = this.getGameTime(item.originalIndex, round, g);
          roundCells += `<td style="font-size:11px; color:var(--text-2); text-align:center; white-space:nowrap;">${val}</td>`;
        }
      });
      return `<tr><td><strong>${i + 1}</strong></td><td>${c.sbd || ''}</td><td><strong>${c.name}</strong></td><td>${c.dob}</td><td>${c.province || ''}</td><td>${f(item.t1)}</td><td>${f(item.t2)}</td><td><strong>${f(item.best)}</strong></td><td>${kq}</td>${roundCells}</tr>`;
    }).join('');
    document.getElementById('total-candidates').innerText = this.state.currentCandidates.length;
    if (this.state.tournamentName) {
      document.getElementById('tournament-name').value = this.state.tournamentName;
    }
    document.getElementById('csv-preview').classList.remove('hidden');
  },

  // Tải file CSV kết quả về máy (client-side)
  downloadResultsCsv() {
    const sortedList = this.getSortedLeaderboard();
    if (!sortedList.length) { this.showToast('Chưa có dữ liệu để tải!'); return; }
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let csv = 'Xếp hạng,SBD,Họ và Tên,Ngày sinh,Tỉnh,Lần 1,Lần 2,Tốt nhất,Kết quả,' +
      '1/16-V1,1/16-V2,1/16-V3,1/16-V4,1/16-V5,' +
      '1/8-V1,1/8-V2,1/8-V3,1/8-V4,1/8-V5,' +
      'BK-V1,BK-V2,BK-V3,BK-V4,BK-V5,' +
      'CK-V1,CK-V2,CK-V3,CK-V4,CK-V5\n';
    sortedList.forEach((item, i) => {
      const c = item.candidate;
      const row = [
        i + 1, esc(c.sbd || ''), esc(c.name), esc(c.dob), esc(c.province || ''),
        this.fmtSec(item.t1), this.fmtSec(item.t2), this.fmtSec(item.best),
        esc(this.bracketResultOf(item.originalIndex))
      ];
      ['1/16', '1/8', 'BK', 'CK_H3'].forEach(round => {
        for (let g = 1; g <= 5; g++) {
          row.push(esc(this.getGameTime(item.originalIndex, round, g)));
        }
      });
      csv += row.join(',') + '\n';
    });
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (this.state.tournamentName || 'ket_qua_vong_loai').replace(/[^\w\-]+/g, '_') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast('Đã tải file CSV xếp hạng về máy.');
  },

  // Xóa toàn bộ dữ liệu giải + file CSV trên thiết bị
  async clearTournamentData() {
    if (!confirm('Xóa toàn bộ danh sách VĐV, thời gian và kết quả? Không thể hoàn tác.')) return;
    this.state.currentCandidates = [];
    this.state.top16 = [];
    this.state.bracket = null;
    this.state.currentMatch = null;
    this.state.qualRun1 = {};
    this.state.qualRun2 = {};
    this.state.qualOrder = [];
    try { await fetch('/api/del-csv', { method: 'POST' }); } catch (e) { }
    const tbody = document.querySelector('#candidate-table tbody');
    if (tbody) tbody.innerHTML = '';
    document.getElementById('csv-preview').classList.add('hidden');
    const fileInput = document.getElementById('csv-file');
    if (fileInput) fileInput.value = '';
    this.showToast('Đã xóa dữ liệu giải đấu.');
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
    this.apiSaveSessionServer({}); // Xóa session cũ trên server
    this.showToast('Đã lưu! Bắt đầu Vòng loại...');
    this.openRaceView('qualifying', 'solo');
  },

  async saveSettings() {
    const c1 = document.getElementById('color-slave1').value;
    const c2 = document.getElementById('color-slave2').value;
    try {
      const r = await this.api.post('/api/color', { c1, c2 });
      if (r && r.ok) {
        this.showToast('Đã lưu cấu hình màu hiển thị thành công!');
      } else {
        this.showToast('Lỗi: ESP32 từ chối lưu cấu hình màu!');
      }
    } catch (e) {
      this.showToast('Lỗi kết nối: Không thể gửi cấu hình màu lên ESP32!');
    }
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
