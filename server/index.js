const http = require('http');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'client', 'public');

const TRACK = buildMonzaTrack();
const LOBBIES = new Map();

const COLORS = ['#00e3a9', '#f06292', '#ffd166', '#66ccff', '#ff8f00', '#a569bd', '#4db6ac'];

const TICK_RATE_MS = 100;

function buildMonzaTrack() {
  const points = [
    [0.52, 0.92],
    [0.55, 0.83],
    [0.57, 0.62],
    [0.56, 0.40],
    [0.47, 0.25],
    [0.40, 0.18],
    [0.28, 0.13],
    [0.15, 0.21],
    [0.11, 0.35],
    [0.15, 0.48],
    [0.30, 0.63],
    [0.48, 0.70],
    [0.75, 0.72],
    [0.90, 0.80],
    [0.88, 0.92],
    [0.70, 0.93],
    [0.52, 0.92]
  ];

  const segmentLengths = [];
  let polylineLength = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const len = Math.hypot(dx, dy);
    segmentLengths.push(len);
    polylineLength += len;
  }

  const trackLengthMeters = 5793;

  const drsZones = [
    { start: trackLengthMeters * 0.03, end: trackLengthMeters * 0.20 },
    { start: trackLengthMeters * 0.55, end: trackLengthMeters * 0.77 }
  ];

  return {
    name: 'Monza',
    length: trackLengthMeters,
    points,
    segmentLengths,
    polylineLength,
    drsZones,
    slipstreamRange: 35
  };
}

function mapProgressToPoint(progress) {
  const distance = ((progress % TRACK.length) + TRACK.length) % TRACK.length;
  const target = (distance / TRACK.length) * TRACK.polylineLength;

  let traversed = 0;
  for (let i = 0; i < TRACK.segmentLengths.length; i += 1) {
    const segLen = TRACK.segmentLengths[i];
    if (traversed + segLen >= target) {
      const ratio = (target - traversed) / segLen;
      const [x1, y1] = TRACK.points[i];
      const [x2, y2] = TRACK.points[i + 1];
      const x = x1 + (x2 - x1) * ratio;
      const y = y1 + (y2 - y1) * ratio;
      const heading = Math.atan2(y2 - y1, x2 - x1);
      return { x, y, heading };
    }
    traversed += segLen;
  }

  const [x, y] = TRACK.points[TRACK.points.length - 1];
  return { x, y, heading: 0 };
}

function createLobby(hostName = 'Host', aiCount = 0) {
  const lobbyId = randomUUID();
  const lobby = {
    id: lobbyId,
    createdAt: Date.now(),
    players: new Map(),
    ai: [],
    inputs: new Map(),
    streams: new Set(),
    tick: 0
  };

  const hostId = randomUUID();
  lobby.players.set(hostId, buildCar(hostName, hostId, 'human', 0));

  for (let i = 0; i < aiCount; i += 1) {
    const botId = randomUUID();
    lobby.ai.push(buildCar(`AI-${i + 1}`, botId, 'ai', (i + 1) * 3));
  }

  LOBBIES.set(lobbyId, lobby);
  return { lobby, hostId };
}

function buildCar(name, id, type, offset) {
  return {
    id,
    name,
    type,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    progress: offset * 10,
    velocity: 0,
    energy: 4.0,
    drsActive: false,
    ersActive: false
  };
}

function getLobbyOr404(res, lobbyId) {
  const lobby = LOBBIES.get(lobbyId);
  if (!lobby) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Lobby not found' }));
    return null;
  }
  return lobby;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function drsAvailable(progress) {
  return TRACK.drsZones.some((zone) => progress >= zone.start && progress <= zone.end);
}

function slipstreamBonus(car, others) {
  const targetProgress = car.progress;
  const range = TRACK.slipstreamRange;
  const ahead = others.find((other) => {
    if (other.id === car.id) return false;
    const diff = (other.progress - targetProgress + TRACK.length) % TRACK.length;
    return diff > 0 && diff < range;
  });
  return ahead ? 1.08 : 1.0;
}

function updateLobby(lobby, dt) {
  const humanCars = Array.from(lobby.players.values());
  const aiCars = lobby.ai;
  const allCars = [...humanCars, ...aiCars];

  for (const car of allCars) {
    const input = lobby.inputs.get(car.id) || { throttle: 0, brake: 0, drs: false, ers: false };
    if (car.type === 'ai') {
      input.throttle = 0.88;
      input.brake = 0;
      input.drs = drsAvailable(car.progress);
      input.ers = car.energy > 0.4 && drsAvailable(car.progress);
    }

    const accelBase = 14;
    const maxSpeed = 82;
    const braking = input.brake ? 25 : 0;

    const drsOn = input.drs && drsAvailable(car.progress);
    const ersOn = input.ers && car.energy > 0.05;

    car.drsActive = drsOn;
    car.ersActive = ersOn;

    const slip = slipstreamBonus(car, allCars);

    let accel = accelBase * input.throttle * slip;
    if (drsOn) accel *= 1.05;
    if (ersOn) accel *= 1.12;
    accel -= braking;
    accel -= car.velocity * 0.18;

    car.velocity = Math.max(0, car.velocity + accel * dt);

    let speedCap = maxSpeed;
    if (drsOn) speedCap += 7;
    if (ersOn) speedCap += 10;
    car.velocity = Math.min(car.velocity, speedCap);

    car.progress = (car.progress + car.velocity * dt) % TRACK.length;

    if (ersOn) {
      car.energy = Math.max(0, car.energy - 0.35 * dt);
    } else {
      car.energy = Math.min(4, car.energy + 0.08 * dt);
    }
  }
}

function serializeLobby(lobby) {
  const cars = [
    ...Array.from(lobby.players.values()),
    ...lobby.ai
  ].map((car) => ({
    id: car.id,
    name: car.name,
    type: car.type,
    color: car.color,
    progress: car.progress,
    velocity: car.velocity,
    energy: car.energy,
    drsActive: car.drsActive,
    ersActive: car.ersActive
  }));

  return {
    lobbyId: lobby.id,
    tick: lobby.tick,
    track: { name: TRACK.name, length: TRACK.length },
    cars
  };
}

function streamLobbyState(lobby) {
  const payload = `data: ${JSON.stringify(serializeLobby(lobby))}\n\n`;
  lobby.streams.forEach((res) => res.write(payload));
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = parsed.pathname;
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname } = parsed;

  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/track') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: TRACK.name,
      length: TRACK.length,
      points: TRACK.points,
      segmentLengths: TRACK.segmentLengths,
      polylineLength: TRACK.polylineLength,
      drsZones: TRACK.drsZones
    }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/lobbies') {
    try {
      const body = await parseJsonBody(req);
      const hostName = body.hostName || 'Host';
      const aiCount = Number.isFinite(body.aiCount) ? Math.max(0, Math.min(6, body.aiCount)) : 0;
      const { lobby, hostId } = createLobby(hostName, aiCount);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lobbyId: lobby.id, playerId: hostId }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/lobbies/') && pathname.endsWith('/join')) {
    const lobbyId = pathname.split('/')[3];
    const lobby = getLobbyOr404(res, lobbyId);
    if (!lobby) return;
    try {
      const body = await parseJsonBody(req);
      const name = body.name || 'Driver';
      const playerId = randomUUID();
      lobby.players.set(playerId, buildCar(name, playerId, 'human', lobby.players.size + lobby.ai.length));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lobbyId, playerId }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/lobbies/') && pathname.endsWith('/add-ai')) {
    const lobbyId = pathname.split('/')[3];
    const lobby = getLobbyOr404(res, lobbyId);
    if (!lobby) return;
    const body = await parseJsonBody(req).catch(() => ({}));
    const name = body.name || `AI-${lobby.ai.length + 1}`;
    const botId = randomUUID();
    lobby.ai.push(buildCar(name, botId, 'ai', lobby.ai.length + lobby.players.size));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, aiId: botId }));
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/lobbies/') && pathname.endsWith('/input')) {
    const lobbyId = pathname.split('/')[3];
    const lobby = getLobbyOr404(res, lobbyId);
    if (!lobby) return;
    try {
      const body = await parseJsonBody(req);
      const { playerId, throttle = 0, brake = 0, drs = false, ers = false } = body;
      if (!lobby.players.has(playerId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Player not found' }));
        return;
      }
      lobby.inputs.set(playerId, {
        throttle: Math.min(1, Math.max(0, throttle)),
        brake: Math.min(1, Math.max(0, brake)),
        drs: Boolean(drs),
        ers: Boolean(ers)
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/lobbies/') && pathname.endsWith('/stream')) {
    const lobbyId = pathname.split('/')[3];
    const lobby = getLobbyOr404(res, lobbyId);
    if (!lobby) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('\n');
    lobby.streams.add(res);
    res.on('close', () => lobby.streams.delete(res));
    res.on('error', () => lobby.streams.delete(res));
    res.write(`data: ${JSON.stringify(serializeLobby(lobby))}\n\n`);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/lobbies/')) {
    const lobbyId = pathname.split('/')[3];
    const lobby = getLobbyOr404(res, lobbyId);
    if (!lobby) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(serializeLobby(lobby)));
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

setInterval(() => {
  LOBBIES.forEach((lobby) => {
    lobby.tick += 1;
    updateLobby(lobby, TICK_RATE_MS / 1000);
    streamLobbyState(lobby);
  });
}, TICK_RATE_MS);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Racing server running on http://localhost:${PORT}`);
});
