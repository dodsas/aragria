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

// #log shares vertical space with sibling panels (#combat-view, #object-view)
// inside #viewport's flex column. When those panels show/hide, #log's
// clientHeight changes and a previously-set scrollTop is no longer at the
// bottom. Defer the snap to the next frame so layout has settled first.
function scrollLogToBottom() {
  requestAnimationFrame(() => {
    logEl.scrollTop = logEl.scrollHeight;
  });
}

let combatDismissTimer = null;
let lastCombat = { playerHp: null, foeHp: null };
function renderCombat(combat) {
  if (combatDismissTimer) {
    clearTimeout(combatDismissTimer);
    combatDismissTimer = null;
  }
  if (!combat) {
    combatViewEl.hidden = true;
    combatViewEl.innerHTML = '';
    combatViewEl.classList.remove('fading');
    lastCombat = { playerHp: null, foeHp: null };
    scrollLogToBottom();
    return;
  }
  combatViewEl.hidden = false;
  combatViewEl.innerHTML = '';
  combatViewEl.classList.remove('fading');

  const fallen = combat.fallen || null;
  const playerHurt = lastCombat.playerHp != null && combat.player.hp < lastCombat.playerHp;
  const foeHurt = lastCombat.foeHp != null && combat.foe.hp < lastCombat.foeHp;

  const stage = document.createElement('div');
  stage.className = 'cv-stage';

  const actorMe = makeCombatActor(combat.player, false, fallen === 'me', playerHurt, null, 'player');
  const actorFoe = makeCombatActor(combat.foe, true, fallen === 'foe', foeHurt, combat.killerName, combat.foe.kind || 'monster');
  const vs = document.createElement('div');
  vs.className = 'cv-vs';
  vs.textContent = fallen ? '💥' : '⚔';

  stage.appendChild(actorMe);
  stage.appendChild(vs);
  stage.appendChild(actorFoe);

  combatViewEl.appendChild(stage);

  lastCombat = { playerHp: combat.player.hp, foeHp: combat.foe.hp };

  // Showing the combat panel shrinks #log; re-pin the latest line.
  scrollLogToBottom();

  if (fallen) {
    // Total auto-dismiss = 4s (3600ms hold + 400ms fade).
    combatDismissTimer = setTimeout(() => {
      combatViewEl.classList.add('fading');
      combatDismissTimer = setTimeout(() => renderCombat(null), 400);
    }, 3600);
  }
}

const MONSTER_SPRITES = {
  goblin: () => goblinSpriteSvg(),
  skeleton: () => skeletonSpriteSvg(),
};

function makeCombatActor(actor, isFoe, isFallen, isHurt, killerName = null, kind = 'monster') {
  const root = document.createElement('div');
  root.className = 'cv-actor' + (isFoe ? ' cv-foe' : ' cv-me')
    + (isFallen ? ' cv-fallen' : '') + (isHurt ? ' cv-hurt' : '');

  const sprite = document.createElement('div');
  sprite.className = 'cv-sprite';
  const monsterSvg = isFoe && !isFallen && kind === 'monster' && MONSTER_SPRITES[actor.defId];
  if (!isFallen && kind === 'player') {
    sprite.classList.add('cv-sprite-svg');
    sprite.innerHTML = playerSpriteSvg();
  } else if (monsterSvg) {
    sprite.classList.add('cv-sprite-svg');
    sprite.innerHTML = monsterSvg();
  } else {
    const icon = document.createElement('div');
    icon.className = 'cv-icon';
    icon.textContent = isFallen ? '✝' : (actor.icon || (isFoe ? '👾' : '🧙'));
    sprite.appendChild(icon);
  }

  const shadow = document.createElement('div');
  shadow.className = 'cv-shadow';

  const nameRow = document.createElement('div');
  nameRow.className = 'cv-name-row';
  const name = document.createElement('div');
  name.className = 'cv-name';
  name.textContent = actor.name || '?';
  nameRow.appendChild(name);
  if (isFoe && isFallen && killerName) {
    const by = document.createElement('div');
    by.className = 'cv-killed-by';
    by.textContent = `killed by ${killerName}`;
    nameRow.appendChild(by);
  }

  root.appendChild(sprite);
  root.appendChild(shadow);
  root.appendChild(nameRow);
  root.appendChild(makeCombatBar(actor, isFoe, isFallen));
  return root;
}

function makeCombatBar(actor, isFoe, isFallen) {
  const row = document.createElement('div');
  row.className = 'cv-bar-row' + (isFoe ? ' cv-foe' : ' cv-me') + (isFallen ? ' cv-fallen' : '');

  const max = actor.maxHp || 1;
  const hp = Math.max(0, actor.hp);
  const cells = 12;
  const filled = Math.round((hp / max) * cells);
  const blocks = '█'.repeat(filled) + '░'.repeat(cells - filled);

  const line = document.createElement('div');
  line.className = 'cv-bar-line';
  const open = document.createElement('span');
  open.className = 'cv-bar-bracket';
  open.textContent = '[';
  const fill = document.createElement('span');
  fill.className = 'cv-bar-blocks';
  fill.textContent = blocks;
  const close = document.createElement('span');
  close.className = 'cv-bar-bracket';
  close.textContent = ']';
  line.appendChild(open);
  line.appendChild(fill);
  line.appendChild(close);

  const num = document.createElement('div');
  num.className = 'cv-bar-num';
  num.textContent = `${hp} / ${actor.maxHp}`;

  row.appendChild(line);
  row.appendChild(num);
  return row;
}

function playerSpriteSvg() {
  return `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="pcRobe" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#fbf6ea"/>
        <stop offset="100%" stop-color="#cfc1a1"/>
      </linearGradient>
      <linearGradient id="pcHat" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#dccfb1"/>
      </linearGradient>
    </defs>
    <g>
      <line x1="80" y1="22" x2="92" y2="135" stroke="#a55a2a" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M76,16 L82,8 L86,18 L80,24 Z" fill="#7ec9ff" stroke="#2d5a8f" stroke-width="0.6"/>
      <path d="M82,8 L86,18 L88,10 Z" fill="#a8dcff"/>
      <path d="M82,22 Q88,28 84,36 Q80,30 82,22 Z" fill="#e08a3c"/>
    </g>
    <path d="M34,35 Q28,55 32,90 Q34,108 36,120 L44,118 Q40,90 42,60 Z" fill="#5a3a22"/>
    <path d="M66,35 Q72,55 70,80 Q72,100 68,118 L60,118 Q62,90 60,60 Z" fill="#5a3a22"/>
    <path d="M28,72 Q22,105 22,135 L78,135 Q78,105 72,72 Q60,76 50,76 Q40,76 28,72 Z"
          fill="url(#pcRobe)" stroke="#8c7a55" stroke-width="0.7"/>
    <path d="M30,128 Q40,124 50,128 Q60,124 70,128 L70,135 L30,135 Z" fill="#e08a3c"/>
    <path d="M40,55 Q40,68 38,76 Q50,80 62,76 Q60,68 60,55 Z" fill="#fbf6ea" stroke="#8c7a55" stroke-width="0.6"/>
    <path d="M36,72 Q50,77 64,72 L64,80 Q50,85 36,80 Z" fill="#d97a32"/>
    <circle cx="50" cy="76" r="2" fill="#7ec9ff" stroke="#2d5a8f" stroke-width="0.4"/>
    <path d="M34,76 L28,92 L32,92 Z" fill="#d97a32"/>
    <path d="M66,76 L72,92 L68,92 Z" fill="#d97a32"/>
    <rect x="46" y="46" width="8" height="10" fill="#f0d5b0"/>
    <ellipse cx="50" cy="38" rx="11" ry="13" fill="#f5dfbe"/>
    <ellipse cx="45.5" cy="40" rx="1.2" ry="2" fill="#3a2418"/>
    <ellipse cx="54.5" cy="40" rx="1.2" ry="2" fill="#3a2418"/>
    <circle cx="46" cy="39.5" r="0.4" fill="#fff"/>
    <circle cx="55" cy="39.5" r="0.4" fill="#fff"/>
    <ellipse cx="42" cy="44" rx="1.5" ry="1" fill="#f0a890" opacity="0.6"/>
    <ellipse cx="58" cy="44" rx="1.5" ry="1" fill="#f0a890" opacity="0.6"/>
    <path d="M48,46.5 Q50,48 52,46.5" fill="none" stroke="#a04030" stroke-width="0.8" stroke-linecap="round"/>
    <path d="M40,28 Q44,38 42,46 L48,42 Q46,32 46,26 Z" fill="#5a3a22"/>
    <path d="M60,28 Q56,38 58,46 L52,42 Q54,32 54,26 Z" fill="#5a3a22"/>
    <path d="M46,26 Q50,30 54,26 L52,32 Q50,33 48,32 Z" fill="#5a3a22"/>
    <ellipse cx="50" cy="24" rx="26" ry="6" fill="url(#pcHat)" stroke="#8c7a55" stroke-width="0.7"/>
    <path d="M38,24 Q40,8 50,6 Q60,8 62,24 Z" fill="url(#pcHat)" stroke="#8c7a55" stroke-width="0.7"/>
    <path d="M38,24 Q50,28 62,24" fill="none" stroke="#d97a32" stroke-width="2.2"/>
    <circle cx="40" cy="25" r="2" fill="#e3a13a"/>
    <circle cx="40" cy="25" r="0.8" fill="#fbeac0"/>
    <path d="M58,10 Q70,2 80,2 Q72,12 64,18" fill="#fbf6ea" stroke="#a89770" stroke-width="0.5"/>
    <path d="M62,8 Q72,4 80,2" fill="none" stroke="#a89770" stroke-width="0.4"/>
    <path d="M62,60 Q72,56 80,52" fill="none" stroke="#fbf6ea" stroke-width="6" stroke-linecap="round"/>
    <circle cx="80" cy="52" r="3" fill="#f5dfbe"/>
    <path d="M40,60 Q34,40 38,28" fill="none" stroke="#fbf6ea" stroke-width="5.5" stroke-linecap="round"/>
    <circle cx="38" cy="28" r="2.5" fill="#f5dfbe"/>
  </svg>`;
}

function goblinSpriteSvg() {
  return `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M40,113 L38,135 L46,135 L46,113 Z" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.7"/>
    <path d="M54,113 L54,135 L62,135 L60,113 Z" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.7"/>
    <path d="M35,90 L65,90 L70,118 L30,118 Z" fill="#5a3a1f" stroke="#2a1a10" stroke-width="0.7"/>
    <path d="M40,95 L46,108 L42,108 Z" fill="#3a2410"/>
    <path d="M58,93 L62,107 L56,108 Z" fill="#3a2410"/>
    <path d="M28,55 Q26,80 34,95 L66,95 Q74,80 72,55 Q60,52 50,52 Q40,52 28,55 Z"
          fill="#7ba84a" stroke="#2a1a10" stroke-width="0.8"/>
    <path d="M40,75 Q50,80 60,75 L60,90 Q50,86 40,90 Z" fill="#5a8035" opacity="0.55"/>
    <path d="M44,68 L48,72 M52,72 L56,68 M48,80 L52,80" stroke="#3a2410" stroke-width="0.6" fill="none"/>
    <path d="M68,60 Q80,68 84,90" fill="none" stroke="#7ba84a" stroke-width="6" stroke-linecap="round"/>
    <circle cx="84" cy="90" r="3.5" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.5"/>
    <line x1="84" y1="86" x2="93" y2="62" stroke="#bfc6cf" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="86" y1="64" x2="92" y2="60" stroke="#8a3d22" stroke-width="0.8"/>
    <line x1="78" y1="86" x2="88" y2="86" stroke="#3a2410" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M32,60 Q22,72 22,92" fill="none" stroke="#7ba84a" stroke-width="6" stroke-linecap="round"/>
    <circle cx="22" cy="92" r="3.5" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.5"/>
    <rect x="44" y="42" width="12" height="11" fill="#7ba84a"/>
    <ellipse cx="50" cy="32" rx="16" ry="14" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.8"/>
    <path d="M34,30 L18,16 L28,34 Z" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.6"/>
    <path d="M66,30 L82,16 L72,34 Z" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.6"/>
    <path d="M28,28 L23,21 L27,32 Z" fill="#5a8035"/>
    <path d="M72,28 L77,21 L73,32 Z" fill="#5a8035"/>
    <path d="M38,24 Q44,28 48,29" stroke="#3a2410" stroke-width="1.6" stroke-linecap="round" fill="none"/>
    <path d="M62,24 Q56,28 52,29" stroke="#3a2410" stroke-width="1.6" stroke-linecap="round" fill="none"/>
    <ellipse cx="44" cy="33" rx="2.6" ry="3" fill="#fff8e0"/>
    <ellipse cx="56" cy="33" rx="2.6" ry="3" fill="#fff8e0"/>
    <circle cx="44" cy="33.5" r="1.4" fill="#e84020"/>
    <circle cx="56" cy="33.5" r="1.4" fill="#e84020"/>
    <circle cx="43.5" cy="33" r="0.4" fill="#000"/>
    <circle cx="55.5" cy="33" r="0.4" fill="#000"/>
    <path d="M48,37 L52,37 L50,41 Z" fill="#5a8035"/>
    <path d="M42,43 L58,43 L56,46 L52,48 L48,48 L44,46 Z" fill="#3a2410"/>
    <path d="M44,43 L46,46 M48,43 L48,47 M52,43 L52,47 M56,43 L54,46" stroke="#fff8e0" stroke-width="0.8"/>
  </svg>`;
}

function skeletonSpriteSvg() {
  return `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <radialGradient id="skEye" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffd060"/>
        <stop offset="60%" stop-color="#ff5020"/>
        <stop offset="100%" stop-color="#5a0a00"/>
      </radialGradient>
    </defs>
    <path d="M26,55 L18,132 L32,130 L36,60 Z" fill="#3a1a1a" stroke="#1a0a0a" stroke-width="0.6"/>
    <path d="M74,55 L82,132 L68,130 L64,60 Z" fill="#3a1a1a" stroke="#1a0a0a" stroke-width="0.6"/>
    <line x1="80" y1="58" x2="94" y2="14" stroke="#bfc6cf" stroke-width="3" stroke-linecap="round"/>
    <path d="M91,12 L97,16 L94,18 Z" fill="#bfc6cf"/>
    <line x1="74" y1="60" x2="86" y2="56" stroke="#5a3a1f" stroke-width="3" stroke-linecap="round"/>
    <circle cx="72" cy="62" r="2.5" fill="#c87a3a" stroke="#3a2410" stroke-width="0.5"/>
    <rect x="42" y="100" width="6" height="35" fill="#e5e0d0" stroke="#2a2520" stroke-width="0.7"/>
    <rect x="52" y="100" width="6" height="35" fill="#e5e0d0" stroke="#2a2520" stroke-width="0.7"/>
    <circle cx="45" cy="115" r="2.6" fill="#e5e0d0" stroke="#2a2520" stroke-width="0.5"/>
    <circle cx="55" cy="115" r="2.6" fill="#e5e0d0" stroke="#2a2520" stroke-width="0.5"/>
    <path d="M36,92 L64,92 L62,103 L38,103 Z" fill="#5a3a1f" stroke="#2a2520" stroke-width="0.7"/>
    <rect x="46" y="95" width="8" height="5" fill="#c87a3a"/>
    <path d="M36,55 Q34,80 38,92 L62,92 Q66,80 64,55 Z" fill="#e5e0d0" stroke="#2a2520" stroke-width="0.7"/>
    <path d="M40,62 Q50,66 60,62" fill="none" stroke="#8a7a55" stroke-width="0.8"/>
    <path d="M40,70 Q50,74 60,70" fill="none" stroke="#8a7a55" stroke-width="0.8"/>
    <path d="M40,78 Q50,82 60,78" fill="none" stroke="#8a7a55" stroke-width="0.8"/>
    <line x1="50" y1="58" x2="50" y2="88" stroke="#8a7a55" stroke-width="0.8"/>
    <path d="M28,52 Q28,60 36,62 L42,55 Q40,46 32,46 Z" fill="#3a3a44" stroke="#1a1a22" stroke-width="0.7"/>
    <path d="M72,52 Q72,60 64,62 L58,55 Q60,46 68,46 Z" fill="#3a3a44" stroke="#1a1a22" stroke-width="0.7"/>
    <path d="M30,46 L26,38 L33,44 Z" fill="#5a5a64" stroke="#1a1a22" stroke-width="0.5"/>
    <path d="M70,46 L74,38 L67,44 Z" fill="#5a5a64" stroke="#1a1a22" stroke-width="0.5"/>
    <path d="M64,58 Q70,62 72,62" fill="none" stroke="#e5e0d0" stroke-width="5" stroke-linecap="round"/>
    <path d="M36,58 Q30,75 28,90" fill="none" stroke="#e5e0d0" stroke-width="5" stroke-linecap="round"/>
    <circle cx="28" cy="90" r="3" fill="#e5e0d0" stroke="#2a2520" stroke-width="0.5"/>
    <ellipse cx="50" cy="30" rx="14" ry="16" fill="#f0eadc" stroke="#2a2520" stroke-width="0.8"/>
    <path d="M40,40 Q50,46 60,40 L60,46 Q50,50 40,46 Z" fill="#d4cdb8"/>
    <ellipse cx="44" cy="30" rx="3.2" ry="4" fill="#1a0a0a"/>
    <ellipse cx="56" cy="30" rx="3.2" ry="4" fill="#1a0a0a"/>
    <circle cx="44" cy="30" r="2" fill="url(#skEye)"/>
    <circle cx="56" cy="30" r="2" fill="url(#skEye)"/>
    <path d="M48,36 L52,36 L50,40 Z" fill="#1a0a0a"/>
    <path d="M40,42 L60,42 L58,47 L42,47 Z" fill="#f0eadc" stroke="#2a2520" stroke-width="0.4"/>
    <line x1="44" y1="42" x2="44" y2="47" stroke="#2a2520" stroke-width="0.6"/>
    <line x1="48" y1="42" x2="48" y2="47" stroke="#2a2520" stroke-width="0.6"/>
    <line x1="52" y1="42" x2="52" y2="47" stroke="#2a2520" stroke-width="0.6"/>
    <line x1="56" y1="42" x2="56" y2="47" stroke="#2a2520" stroke-width="0.6"/>
    <path d="M34,22 Q50,10 66,22 L66,28 Q50,20 34,28 Z" fill="#2a2a32" stroke="#1a1a22" stroke-width="0.6"/>
    <path d="M36,22 Q32,12 28,10 Q32,18 36,22 Z" fill="#4a3a2a" stroke="#1a1a22" stroke-width="0.4"/>
    <path d="M64,22 Q68,12 72,10 Q68,18 64,22 Z" fill="#4a3a2a" stroke="#1a1a22" stroke-width="0.4"/>
    <path d="M48,22 L50,18 L52,22 Z" fill="#5a5a64"/>
  </svg>`;
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
  scrollLogToBottom();
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
    scrollLogToBottom();
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
  scrollLogToBottom();
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
