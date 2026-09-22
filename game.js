'use strict';

/* ---------- constants ---------- */

const MAX_PLAYERS = 6;
const TOTAL_LAPS = 3;
const CHECKPOINT_COUNT = 6;
const TRACK_WIDTH = 100;
const TRACK_HALF = TRACK_WIDTH / 2;
const COLORS = ['#e0523f', '#36b39a', '#8d6fe0', '#f2b632', '#3fa0e0', '#e0708f'];
const CANVAS_W = 1200, CANVAS_H = 800;
const STATE_HZ = 25;

const CAR = {
  accel: 460,
  reverseAccel: 300,
  brakeDecel: 520,
  friction: 260,
  maxSpeed: 330,
  maxReverse: 130,
  turnRate: 3.0,
  radius: 9,
  wallBounce: 0.5,
  boostSpeedMul: 1.55,
  boostAccelMul: 1.6,
  mudSpeedMul: 0.32,
  mudFrictionMul: 3.0,
};

/* ---------- math helpers ---------- */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => {
  let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function segIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/* ---------- track generation ----------
   Polar closed curve around a center point: every angle maps to exactly
   one radius, so the loop can never self-intersect. */

function buildTrack() {
  const cx = CANVAS_W / 2, cy = CANVAS_H / 2 + 10;
  const N = 240;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const r = 280 + 70 * Math.sin(t * 3) + 40 * Math.cos(t * 5 + 0.6);
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return pts;
}

const TRACK = buildTrack();
const TRACK_N = TRACK.length;

function tangentAt(i) {
  const a = TRACK[(i - 2 + TRACK_N) % TRACK_N];
  const b = TRACK[(i + 2) % TRACK_N];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function buildCheckpoints() {
  const gates = [];
  for (let k = 0; k < CHECKPOINT_COUNT; k++) {
    const idx = Math.floor((k * TRACK_N) / CHECKPOINT_COUNT);
    const p = TRACK[idx];
    const tan = tangentAt(idx);
    const nrm = { x: -tan.y, y: tan.x };
    const span = TRACK_HALF * 1.3;
    gates.push({
      idx,
      a: { x: p.x - nrm.x * span, y: p.y - nrm.y * span },
      b: { x: p.x + nrm.x * span, y: p.y + nrm.y * span },
      mid: p,
    });
  }
  return gates;
}
const CHECKPOINTS = buildCheckpoints();

function nearestTrackPoint(x, y) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < TRACK_N; i++) {
    const d = (TRACK[i].x - x) ** 2 + (TRACK[i].y - y) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  return { index: bi, dist: Math.sqrt(best) };
}

/** Hard boundary: a car can never cross the track edge — it is pushed
 * back to the limit and loses speed, like scraping a guard rail. */
function clampToTrack(car) {
  const { index, dist: d } = nearestTrackPoint(car.x, car.y);
  const limit = TRACK_HALF - CAR.radius;
  if (d > limit) {
    const p = TRACK[index];
    const nx = (car.x - p.x) / (d || 1);
    const ny = (car.y - p.y) / (d || 1);
    car.x = p.x + nx * limit;
    car.y = p.y + ny * limit;
    car.speed *= CAR.wallBounce;
  }
}

function hazardsAt() {
  const boostIdx = [Math.floor(TRACK_N * 0.12), Math.floor(TRACK_N * 0.62)];
  const mudIdx = [Math.floor(TRACK_N * 0.38), Math.floor(TRACK_N * 0.85)];
  return {
    boost: boostIdx.map((i) => ({ x: TRACK[i].x, y: TRACK[i].y, r: 42 })),
    mud: mudIdx.map((i) => ({ x: TRACK[i].x, y: TRACK[i].y, r: 40 })),
  };
}
const HAZARDS = hazardsAt();

function decorations() {
  const cx = CANVAS_W / 2, cy = CANVAS_H / 2 + 10;
  const items = [];
  const golden = 2.399963;
  for (let i = 0; i < 26; i++) {
    const ang = i * golden;
    const r = 470 + (i % 4) * 28;
    items.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), kind: i % 3 === 0 ? 'ruin' : 'tree', s: 0.8 + (i % 5) * 0.1 });
  }
  return items;
}
const DECOR = decorations();

const startIdx = CHECKPOINTS[0].idx;
const startTangent = tangentAt(startIdx);
const startAngle = Math.atan2(startTangent.y, startTangent.x);
const startNormal = { x: -startTangent.y, y: startTangent.x };
const startBase = TRACK[startIdx];

function startPosition(slot) {
  const row = Math.floor(slot / 2);
  const back = 34 + row * 42;
  const side = (slot % 2 === 0 ? -1 : 1) * 22;
  return {
    x: startBase.x - startTangent.x * back + startNormal.x * side,
    y: startBase.y - startTangent.y * back + startNormal.y * side,
  };
}

/* ---------- simulation (host authoritative) ---------- */

function makeCar(name, color, slot) {
  const pos = startPosition(slot);
  return {
    name, color,
    x: pos.x, y: pos.y,
    angle: startAngle,
    speed: 0,
    lap: 0,
    nextCp: 1,
    finished: false,
    finishTime: null,
    input: { up: false, down: false, left: false, right: false },
  };
}

function resetCarToStart(car, slot) {
  const pos = startPosition(slot);
  car.x = pos.x; car.y = pos.y;
  car.angle = startAngle;
  car.speed = 0;
  car.lap = 0;
  car.nextCp = 1;
  car.finished = false;
  car.finishTime = null;
}

function stepCar(car, dt, raceClockFn) {
  let maxSpeed = CAR.maxSpeed;
  let accel = CAR.accel;
  let friction = CAR.friction;

  for (const b of HAZARDS.boost) if (dist(car, b) < b.r) { maxSpeed *= CAR.boostSpeedMul; accel *= CAR.boostAccelMul; }
  for (const m of HAZARDS.mud) if (dist(car, m) < m.r) { maxSpeed *= CAR.mudSpeedMul; friction *= CAR.mudFrictionMul; }

  const input = car.input || {};
  let speed = car.speed;
  if (input.up) speed += accel * dt;
  else if (input.down) speed -= (speed > 0 ? CAR.brakeDecel : CAR.reverseAccel) * dt;
  else speed += (speed > 0 ? -1 : 1) * Math.min(Math.abs(speed), friction * dt);

  speed = clamp(speed, -CAR.maxReverse, maxSpeed);

  const speedFrac = Math.min(1, Math.abs(speed) / CAR.maxSpeed);
  let turnInput = 0;
  if (input.left) turnInput -= 1;
  if (input.right) turnInput += 1;
  const turnDir = speed >= 0 ? 1 : -1;
  car.angle += turnInput * CAR.turnRate * dt * (0.25 + 0.75 * speedFrac) * turnDir;

  const prevX = car.x, prevY = car.y;
  car.x += Math.cos(car.angle) * speed * dt;
  car.y += Math.sin(car.angle) * speed * dt;
  car.speed = speed;
  clampToTrack(car);

  if (!car.finished) {
    const gate = CHECKPOINTS[car.nextCp];
    if (segIntersect({ x: prevX, y: prevY }, { x: car.x, y: car.y }, gate.a, gate.b)) {
      car.nextCp = (car.nextCp + 1) % CHECKPOINTS.length;
      if (car.nextCp === 0) {
        car.lap += 1;
        if (car.lap >= TOTAL_LAPS) {
          car.finished = true;
          car.finishTime = raceClockFn();
        }
      }
    }
  }
}

function compareCars(a, b) {
  if (a.finished && b.finished) return a.finishTime - b.finishTime;
  if (a.finished) return -1;
  if (b.finished) return 1;
  if (a.lap !== b.lap) return b.lap - a.lap;
  if (a.nextCp !== b.nextCp) return b.nextCp - a.nextCp;
  const da = dist(a, CHECKPOINTS[a.nextCp].mid);
  const db = dist(b, CHECKPOINTS[b.nextCp].mid);
  return da - db;
}

/* ---------- shared client state ---------- */

let role = null;          // 'host' | 'guest'
let myId = null;
let myName = '';
let myColor = COLORS[0];
let roomCode = null;

let lobbyPlayers = [];    // [{id,name,color,isHost}]
let raceState = 'menu';   // menu | lobby | countdown | racing | finished
let countdownValue = null;
let raceResults = [];     // [{id,name,color,time,dnf}]
let raceElapsed = 0;

let displayCars = {};     // id -> {x,y,angle,lap,nextCp,finished,name,color}

/* host-only */
let peer = null;
let hostConns = {};       // id -> DataConnection
let hostPlayers = {};     // id -> {id,name,color,conn}
let simCars = {};         // id -> physics car
let raceStartPerf = null;
let stateAccum = 0;

/* guest-only */
let hostConn = null;
let snapPrev = null, snapCur = null, snapPrevT = 0, snapCurT = 0;

/* ---------- peer helpers ---------- */

function roomCodeChars() { return 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; }
function genRoomCode() {
  const chars = roomCodeChars();
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function peerIdFor(code) { return 'ruinsrally-' + code.toLowerCase(); }

/* ---------- UI plumbing ---------- */

const screens = {
  menu: document.getElementById('screen-menu'),
  lobby: document.getElementById('screen-lobby'),
  race: document.getElementById('screen-race'),
  results: document.getElementById('screen-results'),
};

function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle('active', k === name);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(() => t.classList.remove('show'), 2200);
}

function showMenuError(msg) {
  const el = document.getElementById('menu-error');
  el.textContent = msg;
  el.hidden = false;
}
function clearMenuError() {
  document.getElementById('menu-error').hidden = true;
}

/* ---------- lobby rendering ---------- */

function renderLobby() {
  document.getElementById('lobby-code').textContent = roomCode || '-----';
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  for (const p of lobbyPlayers) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = p.color;
    li.appendChild(sw);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    li.appendChild(nameSpan);
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'Host';
      li.appendChild(tag);
    }
    if (p.id === myId) {
      const you = document.createElement('span');
      you.className = 'you-tag';
      you.textContent = 'you';
      li.appendChild(you);
    }
    list.appendChild(li);
  }
  document.getElementById('start-race-btn').hidden = role !== 'host';
  document.getElementById('lobby-wait-hint').hidden = role === 'host';
  document.getElementById('start-race-btn').disabled = lobbyPlayers.length < 1;
}

/* ---------- results rendering ---------- */

function fmtTime(t) {
  if (t == null) return '—';
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function renderResults() {
  const banner = document.getElementById('winner-banner');
  const winner = raceResults[0];
  if (winner && !winner.dnf) {
    const who = winner.id === myId ? 'You won!' : `${winner.name} wins!`;
    banner.innerHTML = `🏆 ${who} <span class="time">— finished in ${fmtTime(winner.time)}</span>`;
  } else {
    banner.textContent = "Time's up — no one finished all 3 laps.";
  }

  const list = document.getElementById('results-list');
  list.innerHTML = '';
  raceResults.forEach((r, i) => {
    const li = document.createElement('li');
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = r.dnf ? '—' : `#${i + 1}`;
    li.appendChild(place);
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = r.color;
    li.appendChild(sw);
    const name = document.createElement('span');
    name.textContent = r.name + (r.id === myId ? ' (you)' : '');
    li.appendChild(name);
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = r.dnf ? 'DNF' : fmtTime(r.time);
    li.appendChild(time);
    list.appendChild(li);
  });
  document.getElementById('again-btn').hidden = role !== 'host';
  document.getElementById('results-wait-hint').hidden = role === 'host';
}

/* ---------- leaderboard (during race) ---------- */

function renderLeaderboard() {
  const order = Object.entries(displayCars).sort((a, b) => compareCars(a[1], b[1]));
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = '';
  order.forEach(([id, c], i) => {
    const li = document.createElement('li');
    if (c.finished) li.classList.add('finished');
    if (id === myId) li.classList.add('you');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(i + 1);
    li.appendChild(rank);
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = c.color;
    li.appendChild(sw);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.name;
    li.appendChild(name);
    list.appendChild(li);
  });

  const mine = displayCars[myId];
  if (mine) document.getElementById('hud-lap').textContent = `${Math.min(mine.lap + 1, TOTAL_LAPS)} / ${TOTAL_LAPS}`;
}

let lastLbUpdate = 0;

/* ---------- 3D rendering (Three.js, third-person chase camera) ---------- */

const WORLD_CX = CANVAS_W / 2;
const WORLD_CZ = CANVAS_H / 2 + 10;
const toWorldPos = (x, y, h) => ({ x: x - WORLD_CX, y: h || 0, z: y - WORLD_CZ });

const mount = document.getElementById('three-mount');
const canvasWrap = document.getElementById('canvas-wrap');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b3d34);
scene.fog = new THREE.Fog(0x384a3a, 520, 1500);

const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.5, 3000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
mount.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xdcead0, 0x25301c, 1.1));
const sunLight = new THREE.DirectionalLight(0xfff0cf, 2.4);
sunLight.position.set(420, 620, 180);
sunLight.target.position.set(0, 0, 0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -520;
sunLight.shadow.camera.right = 520;
sunLight.shadow.camera.top = 520;
sunLight.shadow.camera.bottom = -520;
sunLight.shadow.camera.near = 100;
sunLight.shadow.camera.far = 1400;
sunLight.shadow.bias = -0.0006;
scene.add(sunLight, sunLight.target);

function buildSky() {
  const geo = new THREE.SphereGeometry(2400, 24, 16);
  const top = new THREE.Color(0x1c3a30);
  const horizon = new THREE.Color(0xe8c078);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 2400;
    const t = Math.pow(clamp(1 - (y + 0.05), 0, 1), 1.6);
    const c = top.clone().lerp(horizon, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false });
  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);
}
buildSky();

function makeGrassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#33482a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const shade = Math.random();
    g.fillStyle = shade < 0.5 ? 'rgba(70,98,52,0.55)' : 'rgba(24,36,18,0.45)';
    const w = 1 + Math.random() * 2.4;
    g.fillRect(x, y, w, w);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(160, 160);
  tex.anisotropy = 4;
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeAsphaltTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#57534a';
  g.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * 128, y = Math.random() * 512;
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.1)';
    const w = 1 + Math.random() * 2;
    g.fillRect(x, y, w, w);
  }
  g.fillStyle = '#e6dcc3';
  g.fillRect(6, 0, 6, 512);
  g.fillRect(116, 0, 6, 512);
  g.fillStyle = '#f1c874';
  for (let y = 0; y < 512; y += 46) g.fillRect(59, y, 10, 26);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.anisotropy = 4;
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function resizeThree() {
  const w = canvasWrap.clientWidth || 1;
  const h = canvasWrap.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeThree);

function ribbonGeometry(offsetFn, vRepeatPerStep) {
  const positions = [];
  const uvs = [];
  for (let i = 0; i <= TRACK_N; i++) {
    const idx = i % TRACK_N;
    const [lo, hi] = offsetFn(idx);
    positions.push(lo.x, lo.y, lo.z, hi.x, hi.y, hi.z);
    const v = i * (vRepeatPerStep || 0);
    uvs.push(0, v, 1, v);
  }
  const indices = [];
  for (let i = 0; i < TRACK_N; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildStaticScene() {
  // ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4200, 4200),
    new THREE.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // road ribbon — asphalt texture with lane markings, tiled along its length
  const roadGeo = ribbonGeometry((idx) => {
    const p = TRACK[idx];
    const t = tangentAt(idx);
    const n = { x: -t.y, y: t.x };
    const l = toWorldPos(p.x + n.x * TRACK_HALF, p.y + n.y * TRACK_HALF);
    const r = toWorldPos(p.x - n.x * TRACK_HALF, p.y - n.y * TRACK_HALF);
    return [l, r];
  }, 0.12);
  const road = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({ map: makeAsphaltTexture(), roughness: 0.92, side: THREE.DoubleSide }));
  road.receiveShadow = true;
  scene.add(road);

  // guard-rail walls on both edges — visualizes the hard collision boundary
  for (const sign of [1, -1]) {
    const wallGeo = ribbonGeometry((idx) => {
      const p = TRACK[idx];
      const t = tangentAt(idx);
      const n = { x: -t.y, y: t.x };
      const ex = p.x + n.x * TRACK_HALF * sign, ez = p.y + n.y * TRACK_HALF * sign;
      return [toWorldPos(ex, ez, 0), toWorldPos(ex, ez, 5.5)];
    });
    const wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ color: 0xd9cdb2, roughness: 0.8, side: THREE.DoubleSide }));
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
  }

  // checkpoint gates
  CHECKPOINTS.forEach((g, i) => {
    const isStart = i === 0;
    const mat = new THREE.MeshStandardMaterial({
      color: isStart ? 0xf1c874 : 0xd9a441,
      emissive: isStart ? 0x6b4a12 : 0x000000,
      transparent: !isStart, opacity: isStart ? 1 : 0.55,
    });
    const a = toWorldPos(g.a.x, g.a.y);
    const b = toWorldPos(g.b.x, g.b.y);
    const height = isStart ? 30 : 22;
    const postGeo = new THREE.BoxGeometry(3, height, 3);
    const postA = new THREE.Mesh(postGeo, mat); postA.position.set(a.x, height / 2, a.z);
    const postB = new THREE.Mesh(postGeo, mat); postB.position.set(b.x, height / 2, b.z);
    postA.castShadow = postB.castShadow = true;
    scene.add(postA, postB);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 3, 3), mat);
    beam.position.set((a.x + b.x) / 2, height, (a.z + b.z) / 2);
    beam.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    beam.castShadow = true;
    scene.add(beam);
  });

  // hazards
  for (const b of HAZARDS.boost) {
    const wp = toWorldPos(b.x, b.y, 0.08);
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(b.r, 24),
      new THREE.MeshStandardMaterial({ color: 0xf1c874, emissive: 0x8a6318, emissiveIntensity: 0.7, roughness: 0.35 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(wp.x, wp.y, wp.z);
    pad.receiveShadow = true;
    scene.add(pad);
  }
  for (const m of HAZARDS.mud) {
    const wp = toWorldPos(m.x, m.y, 0.08);
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(m.r, 20),
      new THREE.MeshStandardMaterial({ color: 0x5b4326, roughness: 1 }),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(wp.x, wp.y, wp.z);
    patch.receiveShadow = true;
    scene.add(patch);
  }

  // jungle decorations
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3d2a1a, roughness: 1 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a7d63, roughness: 0.9 });
  const stoneCapMat = new THREE.MeshStandardMaterial({ color: 0xa89873, roughness: 0.9 });
  const leafPalette = [0x3f6b34, 0x4a7a3c, 0x365e2c, 0x527f42];
  for (const d of DECOR) {
    const wp = toWorldPos(d.x, d.y);
    if (d.kind === 'tree') {
      const group = new THREE.Group();
      const leafMat = new THREE.MeshStandardMaterial({ color: leafPalette[Math.floor(Math.abs(Math.sin(d.x * 12.9898 + d.y * 78.233)) * leafPalette.length) % leafPalette.length], roughness: 0.9 });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(1.4 * d.s, 1.8 * d.s, 12 * d.s, 6), trunkMat);
      trunk.position.y = 6 * d.s;
      trunk.castShadow = true;
      group.add(trunk);
      const foliageLow = new THREE.Mesh(new THREE.ConeGeometry(11.5 * d.s, 17 * d.s, 7), leafMat);
      foliageLow.position.y = 16 * d.s;
      foliageLow.castShadow = true;
      group.add(foliageLow);
      const foliageTop = new THREE.Mesh(new THREE.ConeGeometry(8 * d.s, 15 * d.s, 7), leafMat);
      foliageTop.position.y = 26 * d.s;
      foliageTop.castShadow = true;
      group.add(foliageTop);
      group.rotation.y = (d.x * 3.7 + d.y * 1.3) % (Math.PI * 2);
      group.position.set(wp.x, 0, wp.z);
      scene.add(group);
    } else {
      const group = new THREE.Group();
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(11 * d.s, 26 * d.s, 11 * d.s), stoneMat);
      pillar.position.y = 13 * d.s;
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      group.add(pillar);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(14 * d.s, 4 * d.s, 14 * d.s), stoneCapMat);
      cap.position.y = 26 * d.s + 2 * d.s;
      cap.castShadow = true;
      group.add(cap);
      group.position.set(wp.x, 0, wp.z);
      scene.add(group);
    }
  }
}
buildStaticScene();

function buildCarBodyGeometry() {
  // Side profile (X = length, nose at +X; Y = height), extruded along width.
  const shape = new THREE.Shape();
  shape.moveTo(-10, 0);
  shape.lineTo(-10.4, 2.6);
  shape.lineTo(-8.6, 6.8);
  shape.lineTo(-3, 7.6);
  shape.lineTo(-1.8, 10.8);
  shape.lineTo(2.6, 10.8);
  shape.lineTo(5.6, 7.6);
  shape.lineTo(9, 5.4);
  shape.lineTo(10.4, 3.2);
  shape.lineTo(10.1, 0);
  shape.lineTo(-10, 0);
  const depth = 10.4;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.45, bevelSegments: 2, curveSegments: 1 });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}
const CAR_BODY_GEO = buildCarBodyGeometry();

function createCarMesh(color) {
  const group = new THREE.Group();

  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, metalness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  group.add(new THREE.Mesh(CAR_BODY_GEO, paint));

  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0d1a1f, roughness: 0.1, transparent: true, opacity: 0.78 });
  const windows = new THREE.Mesh(new THREE.BoxGeometry(7.2, 3.4, 8.6), glass);
  windows.position.set(0.4, 8.3, 0);
  group.add(windows);

  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff4d6, emissiveIntensity: 1.4, roughness: 0.4 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x8a1c14, emissive: 0x8a1c14, emissiveIntensity: 1.1, roughness: 0.4 });
  const lightGeo = new THREE.BoxGeometry(0.8, 1.2, 2.2);
  for (const z of [3.6, -3.6]) {
    const hl = new THREE.Mesh(lightGeo, headMat); hl.position.set(10.2, 3.4, z); group.add(hl);
    const tl = new THREE.Mesh(lightGeo, tailMat); tl.position.set(-10.3, 3.2, z); group.add(tl);
  }

  const bumperMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.7 });
  const bumperGeo = new THREE.BoxGeometry(1.4, 2.4, 9.4);
  const frontBumper = new THREE.Mesh(bumperGeo, bumperMat); frontBumper.position.set(10, 1.8, 0); group.add(frontBumper);
  const rearBumper = new THREE.Mesh(bumperGeo, bumperMat); rearBumper.position.set(-10.2, 1.8, 0); group.add(rearBumper);

  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xcfcfcf, roughness: 0.35, metalness: 0.6 });
  const tireGeo = new THREE.CylinderGeometry(2.8, 2.8, 2.2, 14);
  const rimGeo = new THREE.CylinderGeometry(1.5, 1.5, 2.3, 10);
  for (const [x, z] of [[6.8, 5.4], [6.8, -5.4], [-6.8, 5.4], [-6.8, -5.4]]) {
    const tire = new THREE.Mesh(tireGeo, tireMat); tire.rotation.x = Math.PI / 2; tire.position.set(x, 2.6, z); group.add(tire);
    const rim = new THREE.Mesh(rimGeo, rimMat); rim.rotation.x = Math.PI / 2; rim.position.set(x, 2.6, z); group.add(rim);
  }

  const wingMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 });
  const strutGeo = new THREE.BoxGeometry(0.6, 2.2, 0.6);
  for (const z of [3.4, -3.4]) {
    const strut = new THREE.Mesh(strutGeo, wingMat); strut.position.set(-9, 10.4, z); group.add(strut);
  }
  const wing = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 9.4), wingMat);
  wing.position.set(-9.2, 11.5, 0);
  group.add(wing);

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(11, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.04;
  shadow.castShadow = false;
  shadow.receiveShadow = false;
  group.add(shadow);

  return group;
}

const carMeshMap = {};
function syncCarMeshes() {
  const activeIds = Object.keys(displayCars);
  for (const id of activeIds) {
    const c = displayCars[id];
    let group = carMeshMap[id];
    if (!group) {
      group = createCarMesh(c.color);
      carMeshMap[id] = group;
      scene.add(group);
    }
    const wp = toWorldPos(c.x, c.y);
    group.position.set(wp.x, 0, wp.z);
    group.rotation.y = -c.angle;
  }
  for (const id in carMeshMap) {
    if (!displayCars[id]) { scene.remove(carMeshMap[id]); delete carMeshMap[id]; }
  }
}

let cameraReady = false;
function updateChaseCamera() {
  const my = displayCars[myId];
  if (!my) return;
  const wp = toWorldPos(my.x, my.y);
  const fwdX = Math.cos(my.angle), fwdZ = Math.sin(my.angle);
  const desired = new THREE.Vector3(wp.x - fwdX * 46, 22, wp.z - fwdZ * 46);
  const lookAt = new THREE.Vector3(wp.x + fwdX * 22, 8, wp.z + fwdZ * 22);
  if (!cameraReady) { camera.position.copy(desired); cameraReady = true; }
  else camera.position.lerp(desired, 0.12);
  camera.lookAt(lookAt);
}

function renderThreeFrame() {
  syncCarMeshes();
  updateChaseCamera();
  renderer.render(scene, camera);
}

/* ---------- countdown overlay ---------- */

function showCountdownOverlay(n) {
  const overlay = document.getElementById('countdown-overlay');
  const num = document.getElementById('countdown-num');
  if (n === null) { overlay.hidden = true; return; }
  overlay.hidden = false;
  num.textContent = n === 0 ? 'GO!' : String(n);
  num.style.animation = 'none';
  void num.offsetWidth;
  num.style.animation = '';
}

/* ---------- host: message broadcasting ---------- */

function hostBroadcast(msg) {
  const json = JSON.stringify(msg);
  for (const id in hostConns) {
    const conn = hostConns[id];
    if (conn && conn.open) conn.send(json);
  }
}

function hostBroadcastLobby() {
  lobbyPlayers = Object.values(hostPlayers).map((p) => ({ id: p.id, name: p.name, color: p.color, isHost: p.id === myId }));
  hostBroadcast({ t: 'lobby', players: lobbyPlayers, raceState });
  if (screens.lobby.classList.contains('active')) renderLobby();
}

function raceClock() {
  return raceStartPerf ? (performance.now() - raceStartPerf) / 1000 : 0;
}

function hostSyncDisplayFromSim() {
  const out = {};
  for (const id in simCars) {
    const c = simCars[id];
    out[id] = { x: c.x, y: c.y, angle: c.angle, lap: c.lap, nextCp: c.nextCp, finished: c.finished, name: c.name, color: c.color };
  }
  displayCars = out;
}

function hostStartCountdown() {
  const ids = Object.keys(hostPlayers);
  ids.forEach((id, i) => {
    if (!simCars[id]) simCars[id] = makeCar(hostPlayers[id].name, hostPlayers[id].color, i);
    else resetCarToStart(simCars[id], i);
    simCars[id].name = hostPlayers[id].name;
    simCars[id].color = hostPlayers[id].color;
  });
  // drop cars for players who left
  for (const id in simCars) if (!hostPlayers[id]) delete simCars[id];

  raceState = 'countdown';
  raceStartPerf = null;
  hostSyncDisplayFromSim();
  showScreen('race');
  requestAnimationFrame(resizeThree);
  hostBroadcast({ t: 'lobby', players: lobbyPlayers, raceState });
  hostBroadcast({ t: 'goToRace' });
  showCountdownOverlay(3);

  let n = 3;
  const step = () => {
    hostBroadcast({ t: 'countdown', n });
    showCountdownOverlay(n);
    if (n === 0) {
      raceState = 'racing';
      raceStartPerf = performance.now();
      setTimeout(() => showCountdownOverlay(null), 700);
      return;
    }
    n -= 1;
    setTimeout(step, 1000);
  };
  setTimeout(step, 1000);
}

function hostCheckFinishAndMaybeEnd() {
  const cars = Object.values(simCars);
  const someoneWon = cars.some((c) => c.finished);
  const timeUp = raceStartPerf && raceClock() > 240; // 4 min safety cap
  if (raceState === 'racing' && (someoneWon || timeUp)) {
    raceState = 'finished';
    const list = Object.entries(simCars)
      .sort((a, b) => compareCars(a[1], b[1]))
      .map(([id, c]) => ({ id, name: c.name, color: c.color, time: c.finishTime, dnf: !c.finished }));
    raceResults = list;
    hostBroadcast({ t: 'results', list });
    showResultsScreen();
  }
}

function hostTick(now) {
  if (!hostTick.last) hostTick.last = now;
  const dt = Math.min(0.05, (now - hostTick.last) / 1000);
  hostTick.last = now;

  if (raceState === 'racing') {
    for (const id in simCars) stepCar(simCars[id], dt, raceClock);
    hostSyncDisplayFromSim();
    hostCheckFinishAndMaybeEnd();
  }

  if (screens.race.classList.contains('active')) {
    renderThreeFrame();
    document.getElementById('hud-timer').textContent = fmtTime(raceState === 'racing' || raceState === 'finished' ? raceClock() : 0);
    if (now - lastLbUpdate > 150) { renderLeaderboard(); lastLbUpdate = now; }
  }

  stateAccum += dt;
  if (raceState === 'racing' && stateAccum >= 1 / STATE_HZ) {
    stateAccum = 0;
    const carsOut = {};
    for (const id in simCars) {
      const c = simCars[id];
      carsOut[id] = { x: c.x, y: c.y, angle: c.angle, lap: c.lap, nextCp: c.nextCp, finished: c.finished, name: c.name, color: c.color };
    }
    hostBroadcast({ t: 'state', cars: carsOut, elapsed: raceClock() });
  }

  requestAnimationFrame(hostTick);
}

/* ---------- host: connection handling ---------- */

function hostSetupConnection(conn) {
  conn.on('data', (raw) => {
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }

    if (data.t === 'hello') {
      if (Object.keys(hostPlayers).length >= MAX_PLAYERS) {
        conn.send(JSON.stringify({ t: 'full' }));
        setTimeout(() => conn.close(), 200);
        return;
      }
      const idx = Object.keys(hostPlayers).length;
      const color = COLORS[idx % COLORS.length];
      const name = String(data.name || '').slice(0, 16).trim() || `Racer ${idx + 1}`;
      hostPlayers[conn.peer] = { id: conn.peer, name, color, conn };
      hostConns[conn.peer] = conn;
      conn.send(JSON.stringify({ t: 'welcome', id: conn.peer, color, raceState }));
      hostBroadcastLobby();
      showToast(`${name} joined the race`);
    } else if (data.t === 'input') {
      const c = simCars[conn.peer];
      if (c) c.input = { up: !!data.up, down: !!data.down, left: !!data.left, right: !!data.right };
    }
  });

  conn.on('close', () => {
    const p = hostPlayers[conn.peer];
    const name = p ? p.name : 'A player';
    delete hostPlayers[conn.peer];
    delete hostConns[conn.peer];
    delete simCars[conn.peer];
    if (raceState !== 'menu') hostBroadcastLobby();
    showToast(`${name} left the race`);
  });
}

// STUN alone only gets peers through "easy" NATs — on the same wifi that's
// enough, but two different networks (different cities, mobile data,
// stricter routers) often need a relay, or the connection silently never
// comes up. TURN credentials are fetched fresh from Metered so they can't
// go stale; a hardcoded free public relay is not reliable enough to ship.
const TURN_CREDENTIALS_URL = 'https://ruins-rally.metered.live/api/v1/turn/credentials?apiKey=af10cb2116294ea3d803f9dfe142ee79ba31';
const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
let iceServersPromise = null;

function getIceServers() {
  if (!iceServersPromise) {
    iceServersPromise = fetch(TURN_CREDENTIALS_URL)
      .then((res) => { if (!res.ok) throw new Error('bad status ' + res.status); return res.json(); })
      .then((servers) => (Array.isArray(servers) && servers.length ? servers : FALLBACK_ICE_SERVERS))
      .catch(() => FALLBACK_ICE_SERVERS);
  }
  return iceServersPromise;
}
getIceServers(); // pre-warm on page load so it's usually already cached by the time someone clicks Host/Join

function startHosting() {
  clearMenuError();
  myName = document.getElementById('name-input').value.trim().slice(0, 16) || 'Host';
  myColor = COLORS[0];
  role = 'host';

  const tryCreate = async (attemptsLeft) => {
    roomCode = genRoomCode();
    const iceServers = await getIceServers();
    peer = new Peer(peerIdFor(roomCode), { config: { iceServers } });
    peer.on('open', (id) => {
      myId = id;
      hostPlayers[id] = { id, name: myName, color: myColor, conn: null };
      hostBroadcastLobby();
      showScreen('lobby');
      renderLobby();
      requestAnimationFrame(hostTick);
    });
    peer.on('connection', (conn) => hostSetupConnection(conn));
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attemptsLeft > 0) {
        peer.destroy();
        tryCreate(attemptsLeft - 1);
      } else {
        showMenuError('Could not start a room: ' + err.type);
      }
    });
  };
  tryCreate(3);
}

/* ---------- guest ---------- */

function guestEnterRace() {
  showScreen('race');
  requestAnimationFrame(() => { resizeThree(); guestRenderLoop(performance.now()); });
}

function applyIncoming(data) {
  if (data.t === 'welcome') {
    myId = data.id;
    myColor = data.color;
    raceState = data.raceState || 'lobby';
    if (raceState === 'racing' || raceState === 'countdown') guestEnterRace();
    else showScreen('lobby');
  } else if (data.t === 'full') {
    showMenuError('That room is already full (6 players).');
    if (peer) peer.destroy();
  } else if (data.t === 'lobby') {
    lobbyPlayers = data.players;
    raceState = data.raceState;
    if (screens.lobby.classList.contains('active') || screens.menu.classList.contains('active')) {
      if (screens.menu.classList.contains('active')) showScreen('lobby');
      renderLobby();
    }
  } else if (data.t === 'goToRace') {
    guestEnterRace();
  } else if (data.t === 'countdown') {
    countdownValue = data.n;
    showCountdownOverlay(data.n);
    if (data.n === 0) {
      raceState = 'racing';
      raceStartPerf = performance.now();
      setTimeout(() => showCountdownOverlay(null), 700);
    } else {
      raceState = 'countdown';
    }
  } else if (data.t === 'state') {
    snapPrev = snapCur;
    snapPrevT = snapCurT;
    snapCur = data.cars;
    snapCurT = performance.now();
    raceElapsed = data.elapsed;
  } else if (data.t === 'results') {
    raceState = 'finished';
    raceResults = data.list;
    showResultsScreen();
  } else if (data.t === 'backToLobby') {
    raceState = 'lobby';
    showScreen('lobby');
    renderLobby();
  }
}

async function joinGame() {
  clearMenuError();
  myName = document.getElementById('name-input').value.trim().slice(0, 16) || 'Racer';
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (code.length < 3) { showMenuError('Enter the 5-character room code.'); return; }
  role = 'guest';
  roomCode = code;

  const iceServers = await getIceServers();
  peer = new Peer({ config: { iceServers } });
  peer.on('open', () => {
    const conn = peer.connect(peerIdFor(code), { reliable: true });
    hostConn = conn;

    let opened = false;
    let failed = false;
    const failToConnect = () => {
      if (opened || failed) return;
      failed = true;
      clearTimeout(connectTimeout);
      showMenuError("Found the room but couldn't connect — this can happen across different networks. Try again, or switch off a VPN/restrictive wifi if either of you is on one.");
      try { conn.close(); } catch {}
    };
    const connectTimeout = setTimeout(failToConnect, 15000);

    conn.on('open', () => {
      opened = true;
      clearTimeout(connectTimeout);
      conn.send(JSON.stringify({ t: 'hello', name: myName }));
    });
    conn.on('data', (raw) => {
      let data;
      try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
      applyIncoming(data);
    });
    conn.on('close', () => {
      if (!opened) { failToConnect(); return; }
      showToast('The host ended the race.');
      backToMenu();
    });
    conn.on('error', failToConnect);
  });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') showMenuError('No race found with that code — double check it with your host.');
    else showMenuError('Connection error: ' + err.type);
  });
}

function sendInput(input) {
  if (role === 'host') {
    if (simCars[myId]) simCars[myId].input = input;
  } else if (hostConn && hostConn.open) {
    hostConn.send(JSON.stringify({ t: 'input', ...input }));
  }
}

function guestRenderLoop(now) {
  if (role !== 'guest') return;
  if (!screens.race.classList.contains('active')) return;

  if (snapCur) {
    const span = Math.max(1, snapCurT - snapPrevT);
    const alpha = clamp((performance.now() - snapCurT) / span + 1, 0, 1);
    const out = {};
    for (const id in snapCur) {
      const cur = snapCur[id];
      const prev = snapPrev && snapPrev[id] ? snapPrev[id] : cur;
      out[id] = {
        x: lerp(prev.x, cur.x, alpha),
        y: lerp(prev.y, cur.y, alpha),
        angle: lerpAngle(prev.angle, cur.angle, alpha),
        lap: cur.lap, nextCp: cur.nextCp, finished: cur.finished,
        name: cur.name, color: cur.color,
      };
    }
    displayCars = out;
  }

  renderThreeFrame();
  document.getElementById('hud-timer').textContent = fmtTime(raceElapsed);
  if (now - lastLbUpdate > 150) { renderLeaderboard(); lastLbUpdate = now; }

  requestAnimationFrame(guestRenderLoop);
}

/* ---------- shared flow ---------- */

function showResultsScreen() {
  showScreen('results');
  renderResults();
}

function backToMenu() {
  role = null;
  if (peer) { try { peer.destroy(); } catch {} }
  peer = null; hostConn = null; hostConns = {}; hostPlayers = {}; simCars = {};
  displayCars = {}; lobbyPlayers = []; raceResults = [];
  raceState = 'menu'; roomCode = null; myId = null;
  snapPrev = null; snapCur = null;
  showScreen('menu');
}

/* ---------- input ---------- */

const keyState = { up: false, down: false, left: false, right: false };
function keyToAction(e) {
  switch (e.code) {
    case 'ArrowUp': case 'KeyW': return 'up';
    case 'ArrowDown': case 'KeyS': return 'down';
    case 'ArrowLeft': case 'KeyA': return 'left';
    case 'ArrowRight': case 'KeyD': return 'right';
    default: return null;
  }
}
window.addEventListener('keydown', (e) => {
  if (!screens.race.classList.contains('active')) return;
  const a = keyToAction(e);
  if (!a) return;
  e.preventDefault();
  if (!keyState[a]) { keyState[a] = true; sendInput(keyState); }
});
window.addEventListener('keyup', (e) => {
  if (!screens.race.classList.contains('active')) return;
  const a = keyToAction(e);
  if (!a) return;
  if (keyState[a]) { keyState[a] = false; sendInput(keyState); }
});

/* ---------- wiring ---------- */

document.getElementById('host-btn').addEventListener('click', startHosting);
document.getElementById('join-btn').addEventListener('click', joinGame);
document.getElementById('join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });
document.getElementById('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startHosting(); });

document.getElementById('start-race-btn').addEventListener('click', () => {
  if (role === 'host') hostStartCountdown();
});

document.getElementById('lobby-leave-btn').addEventListener('click', backToMenu);
document.getElementById('results-leave-btn').addEventListener('click', backToMenu);

document.getElementById('again-btn').addEventListener('click', () => {
  if (role === 'host') {
    raceState = 'lobby';
    showScreen('lobby');
    renderLobby();
    hostBroadcastLobby();
    hostBroadcast({ t: 'backToLobby' });
  }
});

document.getElementById('copy-link-btn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('Invite link copied!');
  } catch {
    showToast(url);
  }
});

const params = new URLSearchParams(location.search);
const roomFromLink = (params.get('room') || '').toUpperCase();
if (roomFromLink) document.getElementById('join-code-input').value = roomFromLink;

showScreen('menu');
