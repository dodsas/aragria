const logEl = document.getElementById('log');
const objectViewEl = document.getElementById('object-view');
const promptForm = document.getElementById('prompt-form');
const promptInput = document.getElementById('prompt');
const equipmentEl = document.getElementById('equipment');
const inventoryEl = document.getElementById('inventory');
const statusName = document.getElementById('status-name');
const connStatus = document.getElementById('conn-status');
const modeGlyph = document.getElementById('mode-glyph');
const modeBadge = document.getElementById('mode-badge');

const EQUIP_SLOTS = [
  ['head', '머리'],
  ['body', '몸통'],
  ['weapon', '무기'],
  ['offhand', '보조'],
  ['feet', '발'],
];

let ws;
let backoff = 500;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    connStatus.textContent = '연결됨';
    connStatus.className = 'on';
    backoff = 500;
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    connStatus.textContent = '연결 끊김 — 재연결 중...';
    connStatus.className = 'off';
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  });

  ws.addEventListener('error', () => ws.close());
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'text':   appendLine(msg.segments ?? msg.text, 'line'); break;
    case 'system': appendLine(msg.text, 'line system'); break;
    case 'status': renderStatus(msg.status); break;
    case 'view':   renderObjectView(msg.view); break;
  }
}

function appendLine(content, cls = 'line') {
  const div = document.createElement('div');
  div.className = cls;
  if (Array.isArray(content)) {
    for (const seg of content) {
      const span = document.createElement('span');
      span.textContent = seg.text;
      if (seg.cls) span.className = seg.cls;
      div.appendChild(span);
    }
  } else {
    div.textContent = content;
  }
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderStatus(status) {
  if (!status) return;
  statusName.textContent = status.name;

  equipmentEl.innerHTML = '';
  for (const [slot, label] of EQUIP_SLOTS) {
    const item = status.equipment?.[slot];
    const li = document.createElement('li');
    if (item) {
      li.innerHTML = `<span class="icon"></span><span class="name"></span><span class="slot"></span>`;
      li.querySelector('.icon').textContent = item.icon || '·';
      li.querySelector('.name').textContent = item.name;
      li.querySelector('.slot').textContent = label;
    } else {
      li.className = 'empty';
      li.innerHTML = `<span class="icon">·</span><span class="name">— 비어 있음 —</span><span class="slot"></span>`;
      li.querySelector('.slot').textContent = label;
    }
    equipmentEl.appendChild(li);
  }

  if (status.roomId) updateMapPlayer(status.roomId);

  inventoryEl.innerHTML = '';
  const items = status.inventory || [];
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '— 비어 있음 —';
    inventoryEl.appendChild(li);
  } else {
    for (const it of items) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="icon"></span><span class="name"></span><span class="qty"></span>`;
      li.querySelector('.icon').textContent = it.icon || '·';
      li.querySelector('.name').textContent = it.name;
      li.querySelector('.qty').textContent = it.qty > 1 ? `×${it.qty}` : '';
      if (it.id) li.dataset.itemId = it.id;
      inventoryEl.appendChild(li);
    }
  }
}

function renderObjectView(view) {
  if (!view) {
    objectViewEl.hidden = true;
    objectViewEl.innerHTML = '';
    logEl.scrollTop = logEl.scrollHeight;
    return;
  }
  objectViewEl.hidden = false;
  objectViewEl.innerHTML = '';

  const icon = document.createElement('div');
  icon.className = 'ov-icon';
  icon.textContent = view.icon || '◇';
  objectViewEl.appendChild(icon);

  const head = document.createElement('div');
  const title = document.createElement('h3');
  title.className = 'ov-title';
  title.textContent = view.title || view.name || '(이름 없음)';
  head.appendChild(title);
  if (view.tags?.length) {
    const tags = document.createElement('div');
    tags.className = 'ov-tags';
    tags.textContent = view.tags.map(t => `[${t}]`).join(' ');
    head.appendChild(tags);
  }
  objectViewEl.appendChild(head);

  if (view.stats?.length) {
    const stats = document.createElement('div');
    stats.className = 'ov-stats';
    for (const s of view.stats) {
      const row = document.createElement('div');
      row.className = 'ov-stat';
      const max = s.max || 100;
      const pct = Math.max(0, Math.min(100, (s.value / max) * 100));
      row.innerHTML = `<span></span><span class="ov-bar"><span></span></span><span></span>`;
      row.children[0].textContent = s.label;
      row.children[1].firstElementChild.style.width = `${pct}%`;
      row.children[2].textContent = `${s.value}/${max}`;
      stats.appendChild(row);
    }
    objectViewEl.appendChild(stats);
  }

  if (view.lore) {
    const lore = document.createElement('div');
    lore.className = 'ov-lore';
    lore.textContent = view.lore;
    objectViewEl.appendChild(lore);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function sendCmd(input) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cmd', input }));
  } else {
    appendLine('서버에 연결되어 있지 않습니다.', 'line error');
  }
}

const cmdHistory = [];
let historyIdx = -1;

promptForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = promptInput.value.trim();
  if (!input) return;
  cmdHistory.unshift(input);
  if (cmdHistory.length > 10) cmdHistory.pop();
  historyIdx = -1;
  appendLine(`> ${input}`, 'line echo');
  sendCmd(input);
  promptInput.value = '';
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cmdHistory.length === 0) return;
    historyIdx = Math.min(historyIdx + 1, cmdHistory.length - 1);
    promptInput.value = cmdHistory[historyIdx];
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    historyIdx = Math.max(historyIdx - 1, -1);
    promptInput.value = historyIdx === -1 ? '' : cmdHistory[historyIdx];
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  }
});

// ── Movement mode ─────────────────────────────────────────
// ESC toggles between TYPING and MOVE.
//   TYPING: input focused, normal command entry.
//   MOVE:   input blurred+disabled, WASD sends directional commands.
// e.code (물리 키 위치) 사용 — e.key는 IME·키보드 레이아웃에 따라 달라짐
const WASD_DIR = { KeyW: 'north', KeyA: 'west', KeyS: 'south', KeyD: 'east' };
let mode = 'typing';

function setMode(next) {
  mode = next;
  document.body.dataset.mode = mode;
  modeBadge.className = `mode-${mode}`;
  modeBadge.textContent = mode === 'move' ? 'MOVE' : 'TYPING';
  modeGlyph.textContent = mode === 'move' ? '✥' : '>';
  if (mode === 'typing') {
    promptInput.disabled = false;
    promptInput.placeholder = '명령 입력 — ESC로 이동 모드 전환';
    promptInput.focus();
  } else {
    promptInput.value = '';
    promptInput.disabled = true;
    promptInput.placeholder = '이동 모드 — WASD로 이동, ESC로 입력 모드';
    promptInput.blur();
    document.body.focus(); // 이동 모드에서 키이벤트가 document까지 확실히 전달되도록
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    setMode(mode === 'typing' ? 'move' : 'typing');
    return;
  }
  if (e.key === 'Enter' && mode === 'move') {
    e.preventDefault();
    setMode('typing');
    return;
  }
  if (mode !== 'move') return;
  // Ignore modifier combos so browser shortcuts still work.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const dir = WASD_DIR[e.code];
  if (!dir) return;
  e.preventDefault();
  appendLine(`> [이동] ${dir}`, 'line echo');
  sendCmd(`go ${dir}`);
});

// ── Map ─────────────────────────────────────────────────
const ROOM_W = 60, ROOM_H = 22, COL_STEP = 96, ROW_STEP = 34;
const VIEWPORT_COLS = 4, VIEWPORT_ROWS = 4;
const FOREST_SIZE = 5;

// MAP_ROOMS holds (col,row) grid + (x,y) pixel position. The forest is a
// FOREST_SIZE × FOREST_SIZE grid placed east of the temple (cols 2..2+SIZE-1,
// rows 1..SIZE).
function buildMapRooms() {
  const rooms = {
    market: { col: 0, row: 0, label: '시장' },
    square: { col: 0, row: 1, label: '광장' },
    temple: { col: 1, row: 1, label: '신전' },
  };
  for (let r = 0; r < FOREST_SIZE; r++) {
    for (let c = 0; c < FOREST_SIZE; c++) {
      rooms[`forest_${c}_${r}`] = {
        col: 2 + c,
        row: 1 + r,
        label: '숲',
        cls: 'forest',
      };
    }
  }
  for (const room of Object.values(rooms)) {
    room.x = room.col * COL_STEP;
    room.y = room.row * ROW_STEP;
  }
  return rooms;
}

function buildMapConns() {
  const conns = [
    ['market', 'square'],
    ['square', 'temple'],
    ['temple', 'forest_0_0'],
  ];
  for (let r = 0; r < FOREST_SIZE; r++) {
    for (let c = 0; c < FOREST_SIZE; c++) {
      const id = `forest_${c}_${r}`;
      if (c < FOREST_SIZE - 1) conns.push([id, `forest_${c + 1}_${r}`]);
      if (r < FOREST_SIZE - 1) conns.push([id, `forest_${c}_${r + 1}`]);
    }
  }
  return conns;
}

const MAP_ROOMS = buildMapRooms();
const MAP_CONNS = buildMapConns();

function buildMap() {
  const canvas = document.getElementById('map-canvas');

  const inner = document.createElement('div');
  inner.id = 'map-inner';
  canvas.appendChild(inner);

  let maxCol = 0, maxRow = 0;
  for (const r of Object.values(MAP_ROOMS)) {
    if (r.col > maxCol) maxCol = r.col;
    if (r.row > maxRow) maxRow = r.row;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', (maxCol + 1) * COL_STEP);
  svg.setAttribute('height', maxRow * ROW_STEP + ROOM_H);
  svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';

  for (const [a, b] of MAP_CONNS) {
    const ra = MAP_ROOMS[a], rb = MAP_ROOMS[b];
    const ax = ra.x + ROOM_W / 2, ay = ra.y + ROOM_H / 2;
    const bx = rb.x + ROOM_W / 2, by = rb.y + ROOM_H / 2;
    let x1, y1, x2, y2;
    if (Math.abs(ax - bx) >= Math.abs(ay - by)) {
      [x1, y1, x2, y2] = ax < bx ? [ra.x + ROOM_W, ay, rb.x, by] : [ra.x, ay, rb.x + ROOM_W, by];
    } else {
      [x1, y1, x2, y2] = ay < by ? [ax, ra.y + ROOM_H, bx, rb.y] : [ax, ra.y, bx, rb.y + ROOM_H];
    }
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', 'var(--border)');
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
  }
  inner.appendChild(svg);

  for (const [id, room] of Object.entries(MAP_ROOMS)) {
    const div = document.createElement('div');
    div.className = 'map-room' + (room.cls ? ` ${room.cls}` : '');
    div.dataset.room = id;
    div.textContent = room.label;
    div.style.left = `${room.x}px`;
    div.style.top = `${room.y}px`;
    inner.appendChild(div);
  }

  const marker = document.createElement('div');
  marker.id = 'map-player';
  inner.appendChild(marker);
}

let mapReady = false;
let camCol = 0, camRow = 0;

// Slide camera so that at least EDGE_BUFFER cells of context stay visible on
// each side of the player. The camera only moves when the player crosses into
// the buffer zone, so connection lines into the off-viewport rooms remain
// partly drawn through that buffer (clipped by overflow:hidden).
function panAxis(pos, cam, viewport, edge) {
  if (pos >= cam + viewport - edge) cam = pos - viewport + 1 + edge;
  else if (pos - edge < cam) cam = pos - edge;
  return Math.max(0, cam);
}

function updateMapPlayer(roomId) {
  const room = MAP_ROOMS[roomId];
  if (!room) return;

  for (const el of document.querySelectorAll('.map-room')) {
    el.classList.toggle('current', el.dataset.room === roomId);
  }

  const EDGE_BUFFER = 1;
  camCol = panAxis(room.col, camCol, VIEWPORT_COLS, EDGE_BUFFER);
  camRow = panAxis(room.row, camRow, VIEWPORT_ROWS, EDGE_BUFFER);

  const marker = document.getElementById('map-player');
  const inner  = document.getElementById('map-inner');
  const mx = room.x + ROOM_W / 2 - 5;
  const my = room.y + ROOM_H / 2 - 5;
  const innerTx = `translate(${-camCol * COL_STEP}px, ${-camRow * ROW_STEP}px)`;

  if (!mapReady) {
    marker.style.transition = 'none';
    inner.style.transition  = 'none';
    marker.style.transform = `translate(${mx}px, ${my}px)`;
    inner.style.transform  = innerTx;
    requestAnimationFrame(() => {
      marker.style.transition = '';
      inner.style.transition  = '';
      mapReady = true;
    });
  } else {
    marker.style.transform = `translate(${mx}px, ${my}px)`;
    inner.style.transform  = innerTx;
  }
}

// ── Inventory click (event delegation) ──────────────────
inventoryEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-item-id]');
  if (!li) return;
  const id = li.dataset.itemId;
  appendLine(`> use ${id}`, 'line echo');
  sendCmd(`use ${id}`);
});

buildMap();
setMode('typing');
connect();
