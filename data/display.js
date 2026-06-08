(() => {
  let lastRev = 0;

  const $ = (id) => document.getElementById(id);

  function setTime(lane, data) {
    const time = $(`l${lane}-time`);
    const ms = $(`l${lane}-ms`);
    if (!time || !ms) return;
    time.classList.toggle('waiting', !data || data.timeMain === '-');
    time.firstChild.textContent = data && data.timeMain ? data.timeMain : '-';
    ms.textContent = data && data.timeMs ? data.timeMs : '';
    time.style.color = (data && data.timeColor) || '';
  }

  function setResult(lane, data) {
    const el = $(`l${lane}-pen`);
    if (!el) return;
    const result = data && data.result ? data.result.toUpperCase() : '';
    if (result === 'WIN' || result === 'DQ') {
      el.textContent = result;
      el.style.display = 'block';
      el.classList.toggle('dq', result === 'DQ');
      el.style.color = result === 'WIN' ? '#50ffb0' : '#ff4757';
    } else if (data && data.penalty && data.penalty !== '0') {
      el.textContent = data.penalty === 'DQ' ? 'DQ' : `PENALTY ${data.penalty}`;
      el.style.display = 'block';
      el.classList.toggle('dq', data.penalty === 'DQ');
      el.style.color = data.penalty === 'DQ' ? '#ff4757' : '#ffb030';
    } else {
      el.textContent = '';
      el.style.display = 'none';
      el.classList.remove('dq');
    }
  }

  function setDots(lane, dots) {
    const laneEl = $(`lane-${lane}`);
    if (!laneEl) return;
    const els = laneEl.querySelectorAll('.round-dot');
    els.forEach((el, i) => {
      const state = dots && dots[i] ? dots[i] : 'idle';
      el.className = 'round-dot';
      if (state === 'win') el.classList.add('active');
      else if (state === 'lose') el.classList.add('lose');
      else if (state === 'current') el.classList.add('active');
    });
  }

  function setLane(lane, data) {
    const name = $(`l${lane}-name`);
    if (name && data && data.name) name.innerHTML = data.name;
    setTime(lane, data || {});
    setResult(lane, data || {});
  }

  function render(payload) {
    if (!payload) return;
    if (payload.rev) lastRev = payload.rev;

    const title = $('display-title');
    if (title) title.textContent = payload.title || 'KET QUA';

    const lanes = $('lanes-container');
    if (lanes) lanes.classList.toggle('solo-mode', payload.layoutMode === 'solo');

    setLane(1, payload.lane1);
    setLane(2, payload.lane2);
    setDots(1, payload.gameDots && payload.gameDots.lane1);
    setDots(2, payload.gameDots && payload.gameDots.lane2);
  }

  async function poll() {
    try {
      const res = await fetch(`/api/display?rev=${lastRev}`, { cache: 'no-store' });
      if (res.status === 304) return;
      if (!res.ok) return;
      render(await res.json());
    } catch (e) {
      // Keep the last rendered frame on transient WiFi/AP drops.
    }
  }

  poll();
  setInterval(poll, 600);
})();
