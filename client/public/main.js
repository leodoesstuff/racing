const state = {
  track: null,
  lobbyId: null,
  playerId: null,
  driverName: null,
  stream: null,
  cars: [],
  inputs: { throttle: 0, brake: 0, drs: false, ers: false }
};

const canvas = document.querySelector('#track');
const ctx = canvas.getContext('2d');
const hud = document.querySelector('#hud');
const lobbyMeta = document.querySelector('#lobby-meta');
const addAiButton = document.querySelector('#add-ai');
const board = document.querySelector('#board');

const submitJSON = (url, payload) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then((r) => r.json());

async function bootstrap() {
  const track = await fetch('/api/track').then((r) => r.json());
  state.track = track;
  attachForms();
  attachInputHandlers();
  renderLoop();
}

function attachForms() {
  document.querySelector('#create-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target));
    const res = await submitJSON('/api/lobbies', {
      hostName: data.hostName || 'Host',
      aiCount: Number(data.aiCount) || 0
    });
    connectToLobby(res.lobbyId, res.playerId, data.hostName || 'Host');
  });

  document.querySelector('#join-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target));
    const res = await submitJSON(`/api/lobbies/${data.lobbyId}/join`, {
      name: data.driverName || 'Driver'
    });
    connectToLobby(res.lobbyId, res.playerId, data.driverName || 'Driver');
  });

  addAiButton.addEventListener('click', async () => {
    if (!state.lobbyId) return;
    await submitJSON(`/api/lobbies/${state.lobbyId}/add-ai`, {});
  });
}

function connectToLobby(lobbyId, playerId, driverName) {
  state.lobbyId = lobbyId;
  state.playerId = playerId;
  state.driverName = driverName;
  lobbyMeta.textContent = `Lobby ${lobbyId} • You are ${driverName}`;
  addAiButton.disabled = false;

  if (state.stream) state.stream.close();
  const stream = new EventSource(`/api/lobbies/${lobbyId}/stream`);
  stream.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    state.cars = data.cars;
    state.tick = data.tick;
  };
  stream.onerror = () => {
    stream.close();
  };
  state.stream = stream;
}

function attachInputHandlers() {
  const keys = new Set();
  const updateInputs = () => {
    state.inputs.throttle = keys.has('ArrowUp') ? 1 : 0;
    state.inputs.brake = keys.has('ArrowDown') ? 1 : 0;
    state.inputs.drs = keys.has('KeyD');
    state.inputs.ers = keys.has('ShiftLeft') || keys.has('ShiftRight');
  };

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    updateInputs();
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    updateInputs();
  });

  setInterval(() => {
    if (!state.lobbyId || !state.playerId) return;
    submitJSON(`/api/lobbies/${state.lobbyId}/input`, {
      playerId: state.playerId,
      ...state.inputs
    });
  }, 120);
}

function drawTrack() {
  const { points } = state.track;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w * 0.05, h * 0.05);
  ctx.scale(w * 0.9, h * 0.9);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const grd = ctx.createLinearGradient(0, 0, 1, 1);
  grd.addColorStop(0, '#082032');
  grd.addColorStop(1, '#04070f');
  ctx.fillStyle = grd;
  ctx.fillRect(-0.05, -0.05, 1.1, 1.1);

  ctx.strokeStyle = '#0ef0c7';
  ctx.lineWidth = 0.028;
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.strokeStyle = '#17213a';
  ctx.lineWidth = 0.04;
  ctx.setLineDash([0.02, 0.02]);
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = '#30e0a1';
  ctx.lineWidth = 0.007;
  state.track.drsZones.forEach((zone) => {
    const ratioStart = zone.start / state.track.length;
    const ratioEnd = zone.end / state.track.length;
    const { x: sx, y: sy } = pointAtRatio(ratioStart);
    const { x: ex, y: ey } = pointAtRatio(ratioEnd);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  });

  ctx.restore();
}

function pointAtRatio(ratio) {
  const target = state.track.polylineLength * ratio;
  let traversed = 0;
  for (let i = 0; i < state.track.segmentLengths.length; i += 1) {
    const len = state.track.segmentLengths[i];
    if (traversed + len >= target) {
      const frac = (target - traversed) / len;
      const [x1, y1] = state.track.points[i];
      const [x2, y2] = state.track.points[i + 1];
      return { x: x1 + (x2 - x1) * frac, y: y1 + (y2 - y1) * frac };
    }
    traversed += len;
  }
  const [x, y] = state.track.points[state.track.points.length - 1];
  return { x, y };
}

function mapProgress(progress) {
  const ratio =
    (((progress % state.track.length) + state.track.length) % state.track.length) /
    state.track.length;
  return pointAtRatio(ratio);
}

function drawCars() {
  if (!state.cars || !state.track) return;
  const w = canvas.width;
  const h = canvas.height;

  ctx.save();
  ctx.translate(w * 0.05, h * 0.05);
  ctx.scale(w * 0.9, h * 0.9);

  state.cars.forEach((car) => {
    const pos = car.x !== undefined ? { x: car.x, y: car.y } : mapProgress(car.progress);
    const angle = car.heading || 0;
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(angle);
    ctx.fillStyle = car.color;
    ctx.beginPath();
    ctx.moveTo(0.018, 0);
    ctx.lineTo(-0.014, 0.012);
    ctx.lineTo(-0.014, -0.012);
    ctx.closePath();
    ctx.fill();

    if (car.drsActive) {
      ctx.strokeStyle = '#30e0a1';
      ctx.lineWidth = 0.003;
      ctx.strokeRect(-0.02, -0.016, 0.04, 0.032);
    }
    if (car.ersActive) {
      ctx.strokeStyle = '#ffcf44';
      ctx.lineWidth = 0.003;
      ctx.beginPath();
      ctx.arc(0, 0, 0.022, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  });

  ctx.restore();
}

function updateHud() {
  if (!state.playerId) {
    hud.innerHTML = '<span class="chip">Not in lobby</span>';
    return;
  }
  const me = state.cars.find((c) => c.id === state.playerId);
  if (!me) return;
  hud.innerHTML = `
    <span class="chip">Velocity <strong>${me.velocity.toFixed(1)} m/s</strong></span>
    <span class="chip">ERS <strong>${(me.energy * 25).toFixed(0)}%</strong></span>
    <span class="chip">DRS <strong>${me.drsActive ? 'OPEN' : 'closed'}</strong></span>
  `;
}

function updateBoard() {
  if (!state.cars) return;
  const sorted = [...state.cars].sort((a, b) => b.progress - a.progress);
  board.innerHTML = sorted
    .map(
      (car, idx) => `
      <div class="row">
        <div><span>#${idx + 1}</span> <strong style="color:${car.color}">${car.name}</strong></div>
        <div><span>${car.velocity.toFixed(1)} m/s</span></div>
      </div>
    `
    )
    .join('');
}

function renderLoop() {
  if (state.track) {
    drawTrack();
    drawCars();
    updateHud();
    updateBoard();
  }
  requestAnimationFrame(renderLoop);
}

bootstrap();
