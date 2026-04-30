const logEl = document.getElementById('log');
const objectViewEl = document.getElementById('object-view');
const combatViewEl = document.getElementById('combat-view');
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
    case 'combat': renderCombat(msg.combat); break;
  }
}

let combatDismissTimer = null;
function renderCombat(combat) {
  if (combatDismissTimer) {
    clearTimeout(combatDismissTimer);
    combatDismissTimer = null;
  }
  if (!combat) {
    combatViewEl.hidden = true;
    combatViewEl.innerHTML = '';
    combatViewEl.classList.remove('fading');
    return;
  }
  combatViewEl.hidden = false;
  combatViewEl.innerHTML = '';
  combatViewEl.classList.remove('fading');

  const fallen = combat.fallen || null;
  const sideMe = makeCombatSide(combat.player, false, fallen === 'player');
  const sideFoe = makeCombatSide(combat.monster, true, fallen === 'monster');
  const vs = document.createElement('div');
  vs.className = 'cv-vs';
  vs.textContent = fallen ? '💥' : 'VS';

  combatViewEl.appendChild(sideMe);
  combatViewEl.appendChild(vs);
  combatViewEl.appendChild(sideFoe);

  if (fallen) {
    // Linger for a beat so the player sees the defeat, then fade out.
    combatDismissTimer = setTimeout(() => {
      combatViewEl.classList.add('fading');
      combatDismissTimer = setTimeout(() => renderCombat(null), 400);
    }, 1800);
  }
}

function makeCombatSide(actor, isFoe, isFallen) {
  const root = document.createElement('div');
  root.className = 'cv-side' + (isFoe ? ' cv-foe' : '') + (isFallen ? ' cv-fallen' : '');

  const icon = document.createElement('div');
  icon.className = 'cv-icon';
  icon.textContent = isFallen ? '✝' : (actor.icon || (isFoe ? '👾' : '🧙'));

  const info = document.createElement('div');
  info.className = 'cv-info';
  const name = document.createElement('div');
  name.className = 'cv-name';
  name.textContent = actor.name || '?';
  const track = document.createElement('div');
  track.className = 'cv-hp-track';
  const fill = document.createElement('div');
  const max = actor.maxHp || 1;
  const pct = Math.max(0, Math.min(100, (actor.hp / max) * 100));
  fill.className = 'cv-hp-fill' + (pct < 25 ? ' crit' : pct < 50 ? ' low' : '');
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  const num = document.createElement('div');
  num.className = 'cv-hp-num';
  num.textContent = `HP ${actor.hp}/${actor.maxHp}`;

  info.appendChild(name);
  info.appendChild(track);
  info.appendChild(num);

  if (isFoe) {
    root.appendChild(info);
    root.appendChild(icon);
  } else {
    root.appendChild(icon);
    root.appendChild(info);
  }
  return root;
}

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function highlightText(raw) {
  // Order matters: run quote-wrapping FIRST (before any <span ...> tags exist),
  // otherwise the regex catches attribute quotes like class="tx-room".
  let out = escapeHtml(raw);
  out = out.replace(/("[^"\n]+")/g, '\x00QSTART\x00$1\x00QEND\x00');
  out = out.replace(/(──\s+[^─\n]+?\s+──)/g, '<span class="tx-room">$1</span>');
  out = out.replace(/(보이는 것|출구|이곳에 있는 사람|적|체력|명령)(:)/g, '<span class="tx-label">$1</span>$2');
  out = out.replace(/(\d+)(\s*\/\s*)(\d+)/g, '<span class="tx-hp">$1$2$3</span>');
  out = out.replace(/(\d+)(의\s*피해)/g, '<span class="tx-dmg">$1</span>$2');
  out = out.replace(/\b(north|south|east|west)\b/gi, '<span class="tx-dir">$1</span>');
  out = out.replace(/(북쪽|남쪽|동쪽|서쪽)/g, '<span class="tx-dir">$1</span>');
  out = out.replace(/(여행자\d+)/g, '<span class="tx-player">$1</span>');
  out = out.replaceAll('\x00QSTART\x00', '<span class="tx-quote">').replaceAll('\x00QEND\x00', '</span>');
  return out;
}

function appendLine(content, cls = 'line') {
  const div = document.createElement('div');
  div.className = cls;
  if (Array.isArray(content)) {
    for (const seg of content) {
      const span = document.createElement('span');
      if (seg.cls) span.className = seg.cls;
      // Highlight inside un-classed segments too so HP/damage numbers pop.
      if (!seg.cls) {
        span.innerHTML = highlightText(seg.text);
      } else {
        span.textContent = seg.text;
      }
      div.appendChild(span);
    }
  } else if (cls.includes('echo') || cls.includes('error')) {
    div.textContent = content;
  } else {
    div.innerHTML = highlightText(content);
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
  // Cells are centered inside their (COL_STEP × ROW_STEP) slot so that when
  // the canvas width shrinks to N×COL_STEP (fewer visible cols), the visible
  // cells remain symmetrically padded inside the canvas.
  const xPad = (COL_STEP - ROOM_W) / 2;
  const yPad = (ROW_STEP - ROOM_H) / 2;
  for (const room of Object.values(rooms)) {
    room.x = room.col * COL_STEP + xPad;
    room.y = room.row * ROW_STEP + yPad;
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

// Per-room set of exit directions, derived from MAP_CONNS. Used to render a
// short stub on the room cell for each direction, so the player can see where
// paths leave a cell even when the adjacent cell is off-viewport.
function buildMapExits() {
  const exits = {};
  for (const [a, b] of MAP_CONNS) {
    const ra = MAP_ROOMS[a], rb = MAP_ROOMS[b];
    if (!exits[a]) exits[a] = new Set();
    if (!exits[b]) exits[b] = new Set();
    if (ra.col < rb.col)      { exits[a].add('e'); exits[b].add('w'); }
    else if (ra.col > rb.col) { exits[a].add('w'); exits[b].add('e'); }
    else if (ra.row < rb.row) { exits[a].add('s'); exits[b].add('n'); }
    else                      { exits[a].add('n'); exits[b].add('s'); }
  }
  return exits;
}

const MAP_ROOMS = buildMapRooms();
const MAP_CONNS = buildMapConns();
const MAP_EXITS = buildMapExits();

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
    for (const dir of MAP_EXITS[id] || []) {
      const stub = document.createElement('span');
      stub.className = `stub stub-${dir}`;
      div.appendChild(stub);
    }
    inner.appendChild(div);
  }

  const marker = document.createElement('div');
  marker.id = 'map-player';
  inner.appendChild(marker);
}

let mapReady = false;
let camCol = 0, camRow = 0;
let viewCols = VIEWPORT_COLS;
let viewRows = VIEWPORT_ROWS;
let lastRoomId = null;

// Slide camera so that EDGE_BUFFER cells of context stay visible on each side
// of the player. The camera only moves when the player crosses into the buffer
// zone, so connection lines into off-viewport rooms remain partly drawn
// through that buffer (clipped by overflow:hidden). When viewport is too tight
// to honor the buffer (e.g. only 1–2 cells visible), edge is scaled down so
// the player never falls outside the viewport.
function panAxis(pos, cam, viewport, edge) {
  edge = Math.max(0, Math.min(edge, Math.floor((viewport - 1) / 2)));
  if (pos >= cam + viewport - edge) cam = pos - viewport + 1 + edge;
  else if (pos - edge < cam) cam = pos - edge;
  return Math.max(0, cam);
}

function updateMapPlayer(roomId) {
  const room = MAP_ROOMS[roomId];
  if (!room) return;
  lastRoomId = roomId;

  for (const el of document.querySelectorAll('.map-room')) {
    el.classList.toggle('current', el.dataset.room === roomId);
  }

  const EDGE_BUFFER = 1;
  camCol = panAxis(room.col, camCol, viewCols, EDGE_BUFFER);
  camRow = panAxis(room.row, camRow, viewRows, EDGE_BUFFER);

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

// Compute how many whole columns fit in the available width inside the map's
// parent (`.status-block`) and resize the canvas to exactly that many slots.
// Cells that would be partially clipped never render — overflow:hidden clips
// them and panAxis keeps the player inside the visible window. The canvas is
// `margin: 0 auto`, so shrinking the canvas centers it within the sidebar.
function recomputeMapViewport() {
  const canvas = document.getElementById('map-canvas');
  if (!canvas) return;
  const parent = canvas.parentElement;
  const cs = getComputedStyle(parent);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const available = Math.max(0, parent.clientWidth - padL - padR);

  let totalCols = 0;
  for (const r of Object.values(MAP_ROOMS)) {
    if (r.col + 1 > totalCols) totalCols = r.col + 1;
  }
  const fits = Math.floor(available / COL_STEP);
  viewCols = Math.max(1, Math.min(fits, totalCols));
  canvas.style.width = `${viewCols * COL_STEP}px`;

  if (lastRoomId) updateMapPlayer(lastRoomId);
}

function setupSidebarResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  if (!resizer || !app || !sidebar) return;

  const RESIZER_W = 6;
  const MIN_SIDEBAR = 200;
  const MIN_VIEWPORT = 240;
  const STORAGE_KEY = 'aragria.sidebarWidth';

  const clampW = (w) => {
    const maxW = window.innerWidth - MIN_VIEWPORT - RESIZER_W;
    return Math.max(MIN_SIDEBAR, Math.min(maxW, w));
  };
  const applyW = (w) => {
    app.style.gridTemplateColumns = `${clampW(w)}px ${RESIZER_W}px 1fr`;
  };

  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(saved) && saved > 0) applyW(saved);

  let dragging = false, startX = 0, startW = 0;
  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applyW(startW + (e.clientX - startX));
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    if (e.pointerId != null) resizer.releasePointerCapture(e.pointerId);
    resizer.classList.remove('dragging');
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(sidebar.getBoundingClientRect().width)));
    } catch {}
  };
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);
}

// ── Inventory click (event delegation) ──────────────────
inventoryEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-item-id]');
  if (!li) return;
  const id = li.dataset.itemId;
  appendLine(`> use ${id}`, 'line echo');
  sendCmd(`use ${id}`);
});

function setupMobileSidebar() {
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!toggle || !backdrop) return;
  const setOpen = (open) => {
    document.body.dataset.sidebar = open ? 'open' : '';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    backdrop.hidden = !open;
  };
  toggle.addEventListener('click', () => setOpen(document.body.dataset.sidebar !== 'open'));
  backdrop.addEventListener('click', () => setOpen(false));
}

buildMap();
setupSidebarResizer();
setupMobileSidebar();
recomputeMapViewport();
new ResizeObserver(() => recomputeMapViewport()).observe(document.getElementById('sidebar'));
setMode('typing');
connect();
