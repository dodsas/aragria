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
    case 'text':   appendLine(msg.text, 'line'); break;
    case 'system': appendLine(msg.text, 'line system'); break;
    case 'status': renderStatus(msg.status); break;
    case 'view':   renderObjectView(msg.view); break;
  }
}

function appendLine(text, cls = 'line') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
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
      inventoryEl.appendChild(li);
    }
  }
}

function renderObjectView(view) {
  if (!view) {
    objectViewEl.hidden = true;
    objectViewEl.innerHTML = '';
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
}

function sendCmd(input) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cmd', input }));
  } else {
    appendLine('서버에 연결되어 있지 않습니다.', 'line error');
  }
}

promptForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = promptInput.value.trim();
  if (!input) return;
  appendLine(`> ${input}`, 'line echo');
  sendCmd(input);
  promptInput.value = '';
});

// ── Movement mode ─────────────────────────────────────────
// ESC toggles between TYPING and MOVE.
//   TYPING: input focused, normal command entry.
//   MOVE:   input blurred+disabled, WASD sends directional commands.
const WASD_DIR = { w: 'north', a: 'west', s: 'south', d: 'east' };
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
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    setMode(mode === 'typing' ? 'move' : 'typing');
    return;
  }
  if (mode !== 'move') return;
  // Ignore modifier combos so browser shortcuts still work.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const dir = WASD_DIR[e.key.toLowerCase()];
  if (!dir) return;
  e.preventDefault();
  appendLine(`> [이동] ${dir}`, 'line echo');
  sendCmd(`go ${dir}`);
});

setMode('typing');
connect();
