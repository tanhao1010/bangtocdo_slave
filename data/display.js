/**
 * Màn chiếu — poll rất chậm, ưu tiên bảng điều khiển.
 * GET /api/display?rev=N → 304 nếu chưa đổi (không đọc file).
 */
let lastRev = 0;
let pollTimer = null;
let currentPhase = 'idle';
const POLL_FAST_MS = 250;
const POLL_IDLE_MS = 250;
const POLL_DONE_MS = 1000;

function updateLane(laneId, laneData, phase) {
  if (!laneData) return;

  const nameEl = document.getElementById(`${laneId}-name`);
  if (nameEl) nameEl.innerHTML = laneData.name || '---';

  const timeEl = document.getElementById(`${laneId}-time`);
  const msEl = document.getElementById(`${laneId}-ms`);
  const showTimes = phase === 'done' || (laneData.timeMain && laneData.timeMain !== '-');

  if (timeEl) {
    const main = showTimes ? laneData.timeMain : '—';
    if (timeEl.firstChild) timeEl.firstChild.textContent = main;
    else timeEl.textContent = main;
    timeEl.classList.toggle('waiting', !showTimes);
  }
  if (msEl) msEl.textContent = showTimes ? (laneData.timeMs || '') : '';

  const penEl = document.getElementById(`${laneId}-pen`);
  if (penEl) {
    const pen = laneData.penalty != null ? String(laneData.penalty) : '0';
    penEl.innerText = pen === '0' ? '' : pen;
    penEl.classList.toggle('dq', pen === 'DQ');
    penEl.style.display = pen && pen !== '0' ? 'block' : 'none';
  }
}

function updateGameDots(laneId, dots) {
  const lane = document.getElementById(laneId === 'l1' ? 'lane-1' : 'lane-2');
  if (!lane) return;
  const dotEls = lane.querySelectorAll('.round-dot');
  dotEls.forEach((dot, idx) => {
    const state = dots && dots[idx] ? dots[idx] : 'idle';
    dot.classList.toggle('active', state === 'win');
    dot.classList.toggle('lose', state === 'lose');
  });
}

function updateDisplay(state) {
  if (!state) return;

  const title = document.getElementById('display-title');
  if (title) title.innerText = state.title || 'KẾT QUẢ';

  const lanesWrap = document.getElementById('lanes-container');
  const solo = state.layoutMode === 'solo';
  lanesWrap.classList.toggle('solo-mode', solo);

  const phase = state.phase || 'idle';
  currentPhase = phase;
  const hint = document.getElementById('display-phase-hint');
  if (hint) hint.style.display = phase === 'running' ? 'block' : 'none';

  updateLane('l1', state.lane1, phase);
  if (!solo) updateLane('l2', state.lane2, phase);

  const dots = state.gameDots || {};
  updateGameDots('l1', dots.lane1 || []);
  updateGameDots('l2', dots.lane2 || []);

  localStorage.setItem('patin_display_state', JSON.stringify(state));
}

let displayFetchBusy = false;

async function fetchDisplaySnapshot() {
  if (displayFetchBusy) return;
  displayFetchBusy = true;
  try {
    const url = lastRev > 0 ? `/api/display?rev=${lastRev}` : '/api/display';
    const r = await fetch(url);
    if (r.status === 304) return;
    if (!r.ok) return;
    const state = await r.json();
    if (!state || state.rev == null) return;
    if (state.rev === lastRev) return;
    lastRev = state.rev;
    updateDisplay(state);
  } catch (e) { }
  finally {
    displayFetchBusy = false;
  }
}

function startDisplayPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const tick = async () => {
    await fetchDisplaySnapshot();
    const delay = currentPhase === 'running'
      ? POLL_FAST_MS
      : (currentPhase === 'done' ? POLL_DONE_MS : POLL_IDLE_MS);
    pollTimer = setTimeout(tick, delay);
  };
  tick();
}

document.addEventListener('DOMContentLoaded', () => {
  const cached = localStorage.getItem('patin_display_state');
  if (cached) {
    try {
      const s = JSON.parse(cached);
      lastRev = s.rev || 0;
      updateDisplay(s);
    } catch (e) { }
  }
  startDisplayPoll();
});
