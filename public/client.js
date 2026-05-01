import { makeThrottle } from './throttle.js';

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
const welcomeOverlay = document.getElementById('welcome-overlay');
const welcomeForm = document.getElementById('welcome-form');
const welcomeName = document.getElementById('welcome-name');
const welcomeDesc = document.getElementById('welcome-desc');
const welcomeError = document.getElementById('welcome-error');
const welcomeButton = welcomeForm?.querySelector('button[type=submit]');
const welcomeAuthEl = document.getElementById('welcome-auth');
const welcomeNaverBtn = document.getElementById('welcome-naver-login');
const welcomeAuthStatus = document.getElementById('welcome-auth-status');
const settingsAccountGroup = document.getElementById('settings-account-group');
const settingsAccountName = document.getElementById('settings-account-name');
const settingsLogoutBtn = document.getElementById('settings-logout');

// /auth/me 결과 캐시. null = 비인증, {nickname} = 인증. 첫 페이지 로드와 logout
// 직후에 갱신된다. 다른 디바이스 로그인으로 세션이 회전돼 WS 가 끊기면 재연결
// 직전에 다시 fetch 해 UI 상태를 일치시킨다.
let authState = null;
async function refreshAuthState() {
  try {
    const r = await fetch('/auth/me', { credentials: 'same-origin' });
    if (r.ok) authState = await r.json();
    else authState = null;
  } catch {
    authState = null;
  }
  applyAuthUi();
}
function applyAuthUi() {
  // 환경 자체가 네이버 로그인을 끈 경우(NAVER_CLIENT_ID 미설정) — 등록 모달의
  // 로그인 영역을 숨겨 死버튼이 안 뜨도록.
  const naverEnabled = !!window.AGRIA_NAVER_LOGIN;
  if (welcomeAuthEl) welcomeAuthEl.hidden = !naverEnabled;
  if (!naverEnabled) {
    if (settingsAccountGroup) settingsAccountGroup.hidden = true;
    return;
  }
  if (authState && authState.ok) {
    if (welcomeNaverBtn) welcomeNaverBtn.hidden = true;
    if (welcomeAuthStatus) {
      welcomeAuthStatus.hidden = false;
      welcomeAuthStatus.textContent = `${authState.nickname || '계정'} 으로 로그인됨`;
    }
    if (settingsAccountGroup) {
      settingsAccountGroup.hidden = false;
      if (settingsAccountName) settingsAccountName.textContent = authState.nickname || '계정';
    }
  } else {
    if (welcomeNaverBtn) welcomeNaverBtn.hidden = false;
    if (welcomeAuthStatus) welcomeAuthStatus.hidden = true;
    if (settingsAccountGroup) settingsAccountGroup.hidden = true;
  }
}

if (settingsLogoutBtn) {
  settingsLogoutBtn.addEventListener('click', async () => {
    settingsLogoutBtn.disabled = true;
    settingsLogoutBtn.textContent = '로그아웃 중…';
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    // 로그아웃은 세션 토큰을 무효화 — WS 가 익명으로 재연결되도록 페이지 리로드.
    location.reload();
  });
}

refreshAuthState();

// Cache of per-player AI-generated sprite SVGs, keyed by player id. Server
// pushes via `character_sprite` messages on registration completion and on
// room entry. Combat panel looks up by id; absent → falls back to default.
const PLAYER_SPRITES = new Map();
let myPlayerId = null;

const EQUIP_SLOTS = [
  ['head', '머리'],
  ['body', '몸통'],
  ['weapon', '무기'],
  ['offhand', '보조'],
  ['feet', '발'],
];

let ws;
let backoff = 500;
// duplicate_pending / kicked_by_other 모달이 떠 있을 때 따라오는 close 가 generic
// auto-reconnect 분기로 빠지면 핑퐁 무한 루프가 된다. 두 경로에서 true 로 올려
// 현재 socket 의 close 핸들러가 재연결을 건너뛰도록 한다. connect() 마다 reset.
let suppressReconnect = false;
// 신규 탭이 force_takeover 를 보낸 뒤 takeover 성공의 신호로 server_info 를 받기
// 직전까지 true. 모달을 자동으로 정리하는 트리거.
let awaitingTakeover = false;

// 클라 → 서버 메시지의 최소 송신 간격 게이트. 정책·구현은 throttle.js 단일
// 진실원이며 이 파일은 ws 변수 한 개만 주입한다. closure 변수라 재연결로 ws 가
// 바뀌어도 같은 sender 가 새 소켓을 본다(getSocket 콜백이 매 호출마다 ws 를 다시
// 읽음). 100ms 이내 연쇄 송신은 silent drop — 키 auto-repeat / 버튼 연타가
// 서버 token bucket 에 도달하기 전에 잘려 나가도록.
const sendWS = makeThrottle({ getSocket: () => ws });

// Persistent session id. Lets a refresh / brief disconnect resume the same
// in-world player object (HP, kill-steal block, room) within the server's
// reconnect grace. In production we use localStorage so all tabs share one
// identity (newer-wins force-takeover keeps single-character semantics). In
// dev (window.AGRIA_DEV) we use sessionStorage so each tab gets its own sid
// — needed to drive multiple players from one machine for testing.
function getSid() {
  const KEY = 'agria.sid';
  const store = window.AGRIA_DEV ? sessionStorage : localStorage;
  let sid = '';
  try { sid = store.getItem(KEY) || ''; } catch {}
  if (!sid) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    sid = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
    try { store.setItem(KEY, sid); } catch {}
  }
  return sid;
}

function connect() {
  // 새 connect 마다 두 플래그 초기화. 직전 connect 가 cancel/kick 으로 끝났더라도
  // 새 시도는 깨끗한 상태에서 시작.
  suppressReconnect = false;
  awaitingTakeover = false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?sid=${encodeURIComponent(getSid())}`);

  ws.addEventListener('open', () => {
    connStatus.textContent = '연결됨';
    connStatus.className = 'on';
    backoff = 500;
    // duplicate_pending 가 곧 도착할 수 있으므로 오버레이는 자동 정리하지 않는다.
    // 정상 attach 였다면 server_info → status/welcome 가 자연 흐름으로 진행되고
    // 오버레이는 force_takeover 성공 분기에서 정리된다.
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', (ev) => {
    const code = ev.code;
    const reason = ev.reason || '';
    connStatus.className = 'off';

    if (suppressReconnect) {
      // duplicate_pending / kicked_by_other 가 이미 모달로 안내 중. 사용자 결정
      // 전에 close(혹은 1005/1006 mangling)이 와도 generic auto-reconnect 로
      // 빠지면 두 탭 핑퐁 루프가 되므로 여기서 종결.
      connStatus.textContent = '연결 끊김';
      return;
    }

    if (code === 4001 || code === 4004) {
      // 안전망: kicked_by_other / duplicate_pending JSON 이 어떤 이유로 누락된
      // 채 close 만 도착한 경우. 자동 재연결 금지하고 단일 버튼 안내만 표시.
      connStatus.textContent = '다른 탭에서 접속됨 — 이 탭은 종료됨';
      showPolicyOverlay({
        glyph: '⛔',
        title: '중복 접속 차단',
        msg: '다른 탭(또는 창)에서 접속이 감지되어<br/>이 탭의 연결이 종료되었습니다.',
        sub: '이 탭에서 계속하려면 아래 버튼을 누르세요. 다른 탭의 연결이 끊어집니다.',
        action: '이 탭에서 다시 시작',
        onAction: () => { hidePolicyOverlay(); connect(); },
      });
      return;
    }
    if (code === 4003) {
      // Per-IP connection rate limit on server. 10초 sliding window 안에서
      // 7번째 소켓이 거절됨 — 보통 새로고침 폭주/자동화 스크립트. 한 줄
      // 토스트만 바뀌면 사용자가 "왜 안 들어가지" 하므로 풀스크린 안내로
      // 명확히 보여주고, 카운트다운 후 자동 재시도하되 즉시 재시도 버튼도
      // 제공한다.
      connStatus.textContent = '접속 빈도 제한 — 약 10초 후 자동 재시도';
      backoff = 500;
      startRateLimitOverlay();
      return;
    }
    if (code === 4002) {
      // Legacy reject path (kept for forward compat). Treat as transient.
      connStatus.textContent = '세션 충돌 — 재연결 중';
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
      return;
    }
    // Generic disconnect (network blip, server restart, etc.).
    const why = reason ? ` (${reason})` : code ? ` (코드 ${code})` : '';
    connStatus.textContent = `연결 끊김 — 재연결 중...${why}`;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  });

  ws.addEventListener('error', () => ws.close());
}

// 서버 부팅 시각. 첫 연결에서 받아두고, 이후 재연결에서 다른 값이 오면
// 배포가 일어난 것으로 간주해 페이지를 새로고침한다.
let serverVersion = null;
let serverUpdateTriggered = false;

function handleMessage(msg) {
  // 중복 접속 브릿지 페이즈는 일반 라우팅보다 앞에서 가로챈다 — 사용자에게
  // 결정 모달을 띄우고 close 핸들러의 재연결 정책을 바꾸기 위해.
  if (msg?.type === 'duplicate_pending') {
    suppressReconnect = true;
    showDuplicatePendingOverlay();
    return;
  }
  if (msg?.type === 'kicked_by_other') {
    suppressReconnect = true;
    showKickedOverlay();
    return;
  }
  // force_takeover 후 서버가 정상 attach 했음을 알리는 server_info 도착 시
  // 모달 정리 + 재연결 정책 정상화. 일반 첫 연결의 server_info 는
  // awaitingTakeover=false 라 이 분기를 타지 않는다.
  if (awaitingTakeover && msg?.type === 'server_info') {
    awaitingTakeover = false;
    suppressReconnect = false;
    hidePolicyOverlay();
  }

  switch (msg.type) {
    case 'text':    appendLine(msg.segments ?? msg.text, 'line'); break;
    case 'system':  appendLine(msg.text, 'line system'); break;
    case 'status':  renderStatus(msg.status); hideWelcome(); break;
    case 'view':    renderObjectView(msg.view); break;
    case 'combat':  renderCombat(msg.combat); break;
    case 'room_monsters': renderRoomMonsters(msg); break;
    case 'welcome': showWelcome(); break;
    case 'register_progress': showRegisterProgress(msg.text || '캐릭터를 그리는 중입니다…'); break;
    case 'register_error': showRegisterError(msg.text || '등록할 수 없습니다.'); break;
    case 'character_sprite':
      if (msg.svg && typeof msg.playerId === 'number') {
        PLAYER_SPRITES.set(msg.playerId, msg.svg);
      }
      break;
    case 'server_info': handleServerInfo(msg.version); break;
  }
}

// 신규 탭에서 「이미 다른 탭에서 접속 중」 브릿지 페이즈 모달. 사용자가 「이전
// 접속 끊고 계속」 을 누르면 force_takeover 를 보내 기존 탭을 끊고 이 탭이
// 활성. 「취소」 면 cancel_connect 후 이 탭의 접속만 종료.
function showDuplicatePendingOverlay() {
  connStatus.textContent = '이미 다른 탭에서 접속 중 — 결정 대기';
  showPolicyOverlay({
    glyph: '⚠',
    title: '이미 접속 중',
    msg: '같은 PC의 다른 탭(또는 창)에서 이미 접속 중입니다.<br/>이전 접속을 끊고 이 탭에서 계속하시겠습니까?',
    sub: '「이전 접속 끊고 계속」 을 누르면 다른 탭의 연결이 종료되고 이 탭이 활성 탭이 됩니다. 「취소」 를 누르면 이 탭의 접속만 종료됩니다.',
    action: '이전 접속 끊고 계속',
    onAction: () => {
      awaitingTakeover = true;
      sendWS({ type: 'force_takeover' });
      // 모달은 server_info 도착 시 자동 정리. 사용자에게 진행 중임을 보여줌.
      const btn = document.getElementById('policy-action');
      const secBtn = document.getElementById('policy-action-secondary');
      if (btn) { btn.disabled = true; btn.textContent = '연결 정리 중…'; }
      if (secBtn) secBtn.disabled = true;
    },
    secondary: '취소',
    onSecondary: () => {
      sendWS({ type: 'cancel_connect' });
      // suppressReconnect 는 이미 true. close 가 따라와도 close 핸들러에서 무시.
      // 사용자에게 종료 상태 + 재시도 옵션을 갈아끼운다.
      showPolicyOverlay({
        glyph: '⛔',
        title: '접속 취소됨',
        msg: '이 탭의 접속을 취소했습니다.<br/>다른 탭에서 계속 플레이하세요.',
        sub: '이 탭에서 다시 접속하려면 아래 버튼을 누르세요.',
        action: '이 탭에서 다시 시도',
        onAction: () => { hidePolicyOverlay(); connect(); },
      });
    },
  });
}

// 기존 탭이 다른 탭의 force_takeover 로 끊겼을 때의 모달. 「이 탭에서 계속하기」
// 를 누르면 connect() — 이번엔 기존 탭 입장에서 다시 duplicate_pending 모달이
// 떠 force_takeover 를 보내면 반대 방향으로 회복. 「닫기」 면 그대로 종료.
function showKickedOverlay() {
  connStatus.textContent = '다른 탭에서 접속됨 — 이 탭은 종료됨';
  showPolicyOverlay({
    glyph: '⛔',
    title: '다른 탭에서 접속됨',
    msg: '같은 계정으로 다른 탭(또는 창)에서 새 접속이 시작되어<br/>이 탭의 연결이 종료되었습니다.',
    sub: '이 탭으로 돌아오려면 「이 탭에서 계속하기」 를 누르세요. 다른 탭의 연결이 끊어집니다.',
    action: '이 탭에서 계속하기',
    onAction: () => { hidePolicyOverlay(); connect(); },
    secondary: '닫기',
    onSecondary: () => { hidePolicyOverlay(); },
  });
}

function handleServerInfo(version) {
  if (typeof version !== 'number') return;
  if (serverVersion == null) {
    serverVersion = version;
    return;
  }
  if (version === serverVersion || serverUpdateTriggered) return;
  serverUpdateTriggered = true;
  appendLine('서버 업데이트가 감지되었습니다. 확인을 눌러 새로고침하세요.', 'line system');
  if (promptInput) promptInput.disabled = true;
  showServerUpdateModal();
}

// 서버 부팅 시각이 바뀌면 모달을 띄우고 사용자가 명시적으로 확인을 눌러야
// reload 한다. 자동 타이머 reload 는 시스템 라인이 너무 빨리 사라져 무엇이
//일어났는지 모르는 경우가 많아 폐기. 모달은 ESC/배경 클릭으로 닫히지 않는다.
function showServerUpdateModal() {
  const overlay = document.getElementById('server-update-overlay');
  const confirmBtn = document.getElementById('server-update-confirm');
  if (!overlay || !confirmBtn) {
    // 모달 요소가 없으면 안전하게 즉시 reload — 안내가 없는 채로 멈추는
    // 것보다는 새 빌드로 넘어가는 편이 낫다.
    location.reload();
    return;
  }
  overlay.hidden = false;
  confirmBtn.focus();
  confirmBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '새로고침 중…';
    location.reload();
  }, { once: true });
}

// 접속 차단(중복 접속·IP rate limit) 안내 오버레이. 사이드바 푸터의 한 줄
// `#conn-status` 만으로는 본문 로그가 그대로 멈춰 있어 차단을 인지하기 어렵다.
// 풀스크린으로 띄워 「왜 차단됐고 무엇을 하면 풀리는지」를 1차 메시지로 노출.
let policyActionHandler = null;
let policySecondaryHandler = null;
let policyTimer = null;
function showPolicyOverlay({ glyph, title, msg, sub, action, onAction, secondary, onSecondary }) {
  const overlay = document.getElementById('policy-overlay');
  const glyphEl = document.getElementById('policy-glyph');
  const titleEl = document.getElementById('policy-title');
  const msgEl = document.getElementById('policy-msg');
  const subEl = document.getElementById('policy-sub');
  const btn = document.getElementById('policy-action');
  const secBtn = document.getElementById('policy-action-secondary');
  if (!overlay || !btn) return;
  if (glyphEl) glyphEl.textContent = glyph || '⛔';
  if (titleEl) titleEl.textContent = title || '접속 차단';
  if (msgEl) msgEl.innerHTML = msg || '';
  if (subEl) {
    if (sub) { subEl.innerHTML = sub; subEl.hidden = false; }
    else { subEl.textContent = ''; subEl.hidden = true; }
  }
  btn.textContent = action || '확인';
  btn.disabled = false;
  if (policyActionHandler) btn.removeEventListener('click', policyActionHandler);
  policyActionHandler = onAction || (() => hidePolicyOverlay());
  btn.addEventListener('click', policyActionHandler);

  if (secBtn) {
    if (policySecondaryHandler) secBtn.removeEventListener('click', policySecondaryHandler);
    if (secondary) {
      secBtn.textContent = secondary;
      secBtn.disabled = false;
      secBtn.hidden = false;
      policySecondaryHandler = onSecondary || (() => hidePolicyOverlay());
      secBtn.addEventListener('click', policySecondaryHandler);
    } else {
      secBtn.hidden = true;
      policySecondaryHandler = null;
    }
  }

  overlay.hidden = false;
  setTimeout(() => btn.focus(), 0);
}
function hidePolicyOverlay() {
  const overlay = document.getElementById('policy-overlay');
  if (overlay) overlay.hidden = true;
  if (policyTimer) { clearInterval(policyTimer); policyTimer = null; }
}

// 4003(per-IP rate limit) 전용. 10초 카운트다운을 보여주면서 끝나면 자동
// 재연결, 사용자가 「지금 재시도」를 누르면 즉시 connect(). 카운트다운 텍스트
// 가 매초 갱신되도록 setInterval 로 정책 메시지 전체를 다시 그린다.
function startRateLimitOverlay() {
  let remaining = 10;
  const render = () => {
    showPolicyOverlay({
      glyph: '⏳',
      title: '접속 빈도 제한',
      msg: `짧은 시간에 너무 많은 연결이 감지되어<br/>이 PC의 접속이 일시적으로 차단되었습니다.`,
      sub: `약 <strong>${remaining}</strong>초 후 자동으로 다시 시도합니다. 새로고침을 반복하지 말고 잠시만 기다려 주세요.`,
      action: '지금 재시도',
      onAction: () => { hidePolicyOverlay(); connect(); },
    });
  };
  render();
  if (policyTimer) clearInterval(policyTimer);
  policyTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(policyTimer); policyTimer = null;
      hidePolicyOverlay();
      connect();
      return;
    }
    render();
  }, 1000);
}

function showWelcome() {
  if (!welcomeOverlay) return;
  welcomeOverlay.hidden = false;
  if (welcomeButton) welcomeButton.disabled = false;
  if (welcomeError) {
    welcomeError.classList.remove('welcome-info');
    welcomeError.hidden = true;
  }
  // Defer focus until after the show transition; iOS Safari ignores focus()
  // on a just-unhidden element otherwise.
  setTimeout(() => welcomeName?.focus(), 50);
}
function hideWelcome() {
  if (!welcomeOverlay) return;
  welcomeOverlay.hidden = true;
}

// Server rejected the registration. Keep the modal up, re-enable submit, and
// surface the reason inline (otherwise the user just sees the button re-enable
// with no clue why). Distinct from showWelcome so we don't wipe the error the
// way a fresh prompt does.
function showRegisterError(text) {
  if (!welcomeOverlay) return;
  welcomeOverlay.hidden = false;
  if (welcomeButton) welcomeButton.disabled = false;
  if (welcomeError) {
    welcomeError.classList.remove('welcome-info');
    welcomeError.textContent = text;
    welcomeError.hidden = false;
  }
}

// Server is generating the per-character sprite (~30s). Keep the modal up
// with the button disabled and switch the feedback row into an info-styled
// progress message — without this the user sees a frozen disabled button
// for the entire AI call and assumes the page hung.
function showRegisterProgress(text) {
  if (!welcomeOverlay) return;
  welcomeOverlay.hidden = false;
  if (welcomeButton) welcomeButton.disabled = true;
  if (welcomeError) {
    welcomeError.classList.add('welcome-info');
    welcomeError.textContent = text;
    welcomeError.hidden = false;
  }
}

if (welcomeForm) {
  welcomeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = (welcomeName.value || '').trim();
    const description = (welcomeDesc.value || '').trim();
    if (name.length < 1 || description.length < 5) {
      if (welcomeError) {
        welcomeError.textContent = '이름은 1자 이상, 특징은 5자 이상이어야 합니다.';
        welcomeError.hidden = false;
      }
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (welcomeButton) welcomeButton.disabled = true;
      if (welcomeError) welcomeError.hidden = true;
      ws.send(JSON.stringify({ type: 'register', name, description }));
    } else {
      // Without this branch the button would stay disabled forever after a
      // dropped connection and the user has no recovery path.
      showRegisterError('서버 연결이 끊어졌습니다. 잠시 후 다시 시도하세요.');
    }
  });
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
let inCombat = false;
// 모바일 액션 패드의 「선택지 없이 바로 시전」 단축경로용 — 현재 교전 중인
// foe 의 식별자를 캐싱한다. 서버 권위 원본이 아니라(서버는 별도 brodcast 안 함)
// combat 메시지의 foe 페이로드를 그대로 쓰는 거울. fallen='foe' 또는 panel
// 종료 시 null 로 비워 다음 액션 패드 렌더가 일반 타깃 리스트로 떨어지게.
let currentCombatFoe = null;

// 마법 시전 시 띄울 발사체 글리프(element 별). 색은 CSS .cv-elem-<element>
// 의 drop-shadow 가 담당 — 글리프 자체는 element 정체성만 표현.
const SPELL_GLYPH = {
  fire: '🔥',
  ice: '❄',
  lightning: '⚡',
  dark: '💀',
  meteor: '☄',
};

// cv-stage 위에 absolute 로 떠 캐스터→타겟 방향으로 날아가 폭발 모션으로
// 사라지는 일회성 overlay. CSS keyframe(`cv-spell-fly` / `cv-spell-meteor-fall`)
// 종료 시 스스로 정리하고, animationend 가 어쩌다 누락되어도 1.5s safety
// timeout 으로 강제 제거. 다음 combat 메시지가 stage 를 교체해도 overlay 는
// 살아남도록 renderCombat 이 stage 만 선택적으로 교체한다.
function spawnSpellEffect(effect) {
  if (!effect || !combatViewEl) return;
  const element = effect.element || 'fire';
  const wrap = document.createElement('div');
  wrap.className = `cv-spell cv-elem-${element}`;
  const proj = document.createElement('span');
  proj.className = 'cv-spell-projectile';
  proj.textContent = SPELL_GLYPH[element] || '✦';
  wrap.appendChild(proj);
  combatViewEl.appendChild(wrap);
  proj.addEventListener('animationend', () => {
    if (wrap.parentNode) wrap.remove();
  }, { once: true });
  setTimeout(() => { if (wrap.parentNode) wrap.remove(); }, 1500);
}

function renderCombat(combat) {
  if (combatDismissTimer) {
    clearTimeout(combatDismissTimer);
    combatDismissTimer = null;
  }
  if (!combat) {
    combatViewEl.hidden = true;
    // 패널을 닫을 때만 모든 자식(stage + in-flight overlay) 일괄 청소.
    combatViewEl.innerHTML = '';
    combatViewEl.classList.remove('fading');
    lastCombat = { playerHp: null, foeHp: null };
    inCombat = false;
    currentCombatFoe = null;
    scrollLogToBottom();
    if (typeof renderActionPad === 'function') renderActionPad();
    return;
  }
  inCombat = true;
  // foe 가 살아 있는 동안 캐시. fallen='foe'/'me' 모두 교전 종료로 보고 비운다
  // (foe 가 죽었거나 내가 죽어 광장으로 튕긴 상황 — 다음 액션은 새 타깃 선택).
  if (combat.foe && !combat.fallen) {
    currentCombatFoe = {
      name: combat.foe.name,
      kind: combat.foe.kind || 'monster',
    };
  } else if (combat.fallen) {
    currentCombatFoe = null;
  }
  combatViewEl.hidden = false;
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

  // stage 만 선택적으로 교체 — innerHTML='' 로 전체 비우면 in-flight 마법
  // overlay 가 사라진다(시전 직후 도착하는 counter-attack 메시지에 휘말려).
  const oldStage = combatViewEl.querySelector('.cv-stage');
  if (oldStage) oldStage.remove();
  combatViewEl.appendChild(stage);

  // effect 페이로드가 실려 있으면 overlay 발사. 같은 cast 사이클에서 두 번
  // 이상 메시지가 도착해도(예: caster 자신의 spell 메시지 + 같은 방 onlooker
  // 가 본인 캐릭터로도 받은 메시지) 매번 새 overlay 가 추가될 수 있으므로
  // 직전에 띄운 것이 아직 살아 있으면 한 번만 띄우도록 가드.
  if (combat.effect?.kind === 'spell') {
    const existing = combatViewEl.querySelector('.cv-spell');
    if (!existing) spawnSpellEffect(combat.effect);
  }

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

// 액션 패드 타깃 소스. 서버 `room_monsters`는 monsters/objects/players 세
// 리스트를 함께 싣고 들어온다 — 모바일 액션 패드 서브메뉴에 그대로 채운다.
function renderRoomMonsters(msg) {
  const monsters = msg?.monsters || [];
  currentRoomTargets = {
    monsters: monsters.map(m => ({ id: m.id, name: m.name })),
    objects: msg?.objects || [],
    players: msg?.players || [],
  };
  renderActionPad();
}

const MONSTER_SPRITES = {
  goblin: () => goblinSpriteSvg(),
  skeleton: () => skeletonSpriteSvg(),
  dragon: () => dragonSpriteSvg(),
  red_dragon: () => redDragonSpriteSvg(),
};

function makeCombatActor(actor, isFoe, isFallen, isHurt, killerName = null, kind = 'monster') {
  const root = document.createElement('div');
  root.className = 'cv-actor' + (isFoe ? ' cv-foe' : ' cv-me')
    + (isFallen ? ' cv-fallen' : '') + (isHurt ? ' cv-hurt' : '');

  const sprite = document.createElement('div');
  sprite.className = 'cv-sprite';
  const monsterSvg = isFoe && !isFallen && kind === 'monster' && MONSTER_SPRITES[actor.defId];
  // Per-character custom sprite delivered by the server (AI-generated from
  // the player's description at registration). Indexed by player id; falls
  // back to the default playerSpriteSvg() when unavailable (no API key,
  // generation failed, or sprite not yet delivered).
  const customPlayerSvg = !isFallen && kind === 'player' && typeof actor.id === 'number'
    ? PLAYER_SPRITES.get(actor.id) : null;
  if (!isFallen && kind === 'player') {
    sprite.classList.add('cv-sprite-svg');
    sprite.innerHTML = customPlayerSvg || playerSpriteSvg();
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
  root.appendChild(makeCombatBar({ cur: actor.hp, max: actor.maxHp, isFoe, isFallen, kind: 'hp' }));
  // MP 바는 본인(me) 쪽에만, 그것도 maxMp > 0 인 직업(mage 한정) 일 때만.
  // novice 는 maxMp=0 이라 자동 숨김 — UI 잡음 차단. foe(몬스터/PvP) 는 MP
  // 정보가 전술 의사결정에 직접 도움 안 돼 의도적으로 노출하지 않는다.
  if (!isFoe && (actor.maxMp || 0) > 0) {
    root.appendChild(makeCombatBar({ cur: actor.mp, max: actor.maxMp, isFoe: false, isFallen, kind: 'mp' }));
  }
  return root;
}

// HP/MP 공용 한 줄 바. kind 가 row 클래스(`cv-bar-hp`/`cv-bar-mp`) 로 흘러들어
// CSS 가 색을 분기한다 — me/foe 분기는 그대로 유지.
function makeCombatBar({ cur, max, isFoe, isFallen, kind }) {
  const row = document.createElement('div');
  row.className = 'cv-bar-row'
    + (isFoe ? ' cv-foe' : ' cv-me')
    + (isFallen ? ' cv-fallen' : '')
    + ` cv-bar-${kind}`;

  const total = max || 1;
  const value = Math.max(0, cur || 0);
  const cells = 12;
  const filled = Math.round((value / total) * cells);

  const line = document.createElement('div');
  line.className = 'cv-bar-line';
  const open = document.createElement('span');
  open.className = 'cv-bar-bracket';
  open.textContent = '[';
  const fill = document.createElement('span');
  fill.className = 'cv-bar-blocks cv-bar-fill';
  fill.textContent = '█'.repeat(filled);
  const empty = document.createElement('span');
  empty.className = 'cv-bar-blocks cv-bar-empty';
  empty.textContent = '█'.repeat(cells - filled);
  const close = document.createElement('span');
  close.className = 'cv-bar-bracket';
  close.textContent = ']';
  line.appendChild(open);
  line.appendChild(fill);
  line.appendChild(empty);
  line.appendChild(close);

  const num = document.createElement('div');
  num.className = 'cv-bar-num';
  num.textContent = `${value} / ${max || 0}`;

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

function dragonSpriteSvg() {
  return `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <radialGradient id="dragonEye" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fff080"/>
        <stop offset="55%" stop-color="#ffa020"/>
        <stop offset="100%" stop-color="#3a1000"/>
      </radialGradient>
    </defs>
    <path d="M30,55 Q4,42 6,82 Q22,76 32,82 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.7"/>
    <path d="M70,55 Q96,42 94,82 Q78,76 68,82 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.7"/>
    <path d="M14,52 Q12,68 12,80 M22,52 Q22,70 24,80" fill="none" stroke="#0a0500" stroke-width="0.5"/>
    <path d="M86,52 Q88,68 88,80 M78,52 Q78,70 76,80" fill="none" stroke="#0a0500" stroke-width="0.5"/>
    <path d="M62,108 Q88,118 92,134 L82,134 Q80,122 60,116 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.7"/>
    <path d="M88,128 L94,132 L86,134 Z" fill="#1a1010" stroke="#0a0500" stroke-width="0.5"/>
    <path d="M38,98 Q34,118 36,134 L46,134 L46,100 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.7"/>
    <path d="M62,98 Q66,118 64,134 L54,134 L54,100 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.7"/>
    <path d="M36,134 L34,138 L37,135 M40,134 L38,138 L41,135 M44,134 L42,138 L45,135" fill="none" stroke="#bfc6cf" stroke-width="0.7"/>
    <path d="M56,134 L54,138 L57,135 M60,134 L58,138 L61,135 M64,134 L62,138 L65,135" fill="none" stroke="#bfc6cf" stroke-width="0.7"/>
    <path d="M32,55 Q26,90 36,108 L64,108 Q74,90 68,55 Q60,52 50,52 Q40,52 32,55 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.8"/>
    <path d="M40,62 Q42,88 44,104 L56,104 Q58,88 60,62 Q55,68 50,68 Q45,68 40,62 Z" fill="#5a3a22" opacity="0.75"/>
    <path d="M44,72 Q50,76 56,72 M44,82 Q50,86 56,82 M44,92 Q50,96 56,92" fill="none" stroke="#3a1a10" stroke-width="0.5" opacity="0.6"/>
    <path d="M50,55 L48,58 L52,58 Z M50,64 L48,67 L52,67 Z M50,73 L48,76 L52,76 Z M50,84 L48,87 L52,87 Z M50,95 L48,98 L52,98 Z" fill="#0a0500"/>
    <path d="M44,40 L42,55 L58,55 L56,40 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.7"/>
    <ellipse cx="50" cy="32" rx="16" ry="13" fill="#2a2520" stroke="#0a0500" stroke-width="0.8"/>
    <path d="M34,32 Q30,40 36,44 L52,44 Q56,38 50,30 Z" fill="#2a2520" stroke="#0a0500" stroke-width="0.8"/>
    <ellipse cx="36" cy="38" rx="0.9" ry="1.1" fill="#0a0500"/>
    <path d="M34,42 L52,42" stroke="#0a0500" stroke-width="0.7"/>
    <path d="M37,42 L37,44 M41,42 L41,44.5 M45,42 L45,44 M49,42 L49,44.5" stroke="#fff8e0" stroke-width="0.5"/>
    <ellipse cx="46" cy="28" rx="3.4" ry="2.8" fill="#0a0500"/>
    <ellipse cx="58" cy="28" rx="3.4" ry="2.8" fill="#0a0500"/>
    <circle cx="46" cy="28" r="1.7" fill="url(#dragonEye)"/>
    <circle cx="58" cy="28" r="1.7" fill="url(#dragonEye)"/>
    <path d="M44,26 Q47,22 50,25 M56,25 Q53,22 50,25" stroke="#0a0500" stroke-width="1" fill="none"/>
    <path d="M40,22 Q34,12 28,6 Q34,12 44,22 Z" fill="#1a1010" stroke="#0a0500" stroke-width="0.5"/>
    <path d="M60,22 Q66,12 72,6 Q66,12 56,22 Z" fill="#1a1010" stroke="#0a0500" stroke-width="0.5"/>
    <path d="M64,30 Q70,28 74,32" stroke="#1a1010" stroke-width="0.6" fill="none"/>
    <path d="M36,30 Q30,28 26,32" stroke="#1a1010" stroke-width="0.6" fill="none"/>
    <path d="M64,72 Q78,80 82,98" fill="none" stroke="#2a2520" stroke-width="6" stroke-linecap="round"/>
    <circle cx="82" cy="98" r="3.6" fill="#2a2520" stroke="#0a0500" stroke-width="0.5"/>
    <path d="M78,100 L76,104 M82,102 L82,107 M86,100 L88,104" stroke="#bfc6cf" stroke-width="0.9" stroke-linecap="round"/>
    <path d="M36,72 Q22,80 18,98" fill="none" stroke="#2a2520" stroke-width="6" stroke-linecap="round"/>
    <circle cx="18" cy="98" r="3.6" fill="#2a2520" stroke="#0a0500" stroke-width="0.5"/>
    <path d="M14,100 L12,104 M18,102 L18,107 M22,100 L24,104" stroke="#bfc6cf" stroke-width="0.9" stroke-linecap="round"/>
  </svg>`;
}

function redDragonSpriteSvg() {
  return `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <radialGradient id="redDragonEye" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fff4a0"/>
        <stop offset="55%" stop-color="#ffb030"/>
        <stop offset="100%" stop-color="#3a0500"/>
      </radialGradient>
      <radialGradient id="redDragonBreath" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffd060" stop-opacity="0.9"/>
        <stop offset="60%" stop-color="#e84020" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#3a0500" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path d="M30,55 Q4,42 6,82 Q22,76 32,82 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.7"/>
    <path d="M70,55 Q96,42 94,82 Q78,76 68,82 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.7"/>
    <path d="M14,52 Q12,68 12,80 M22,52 Q22,70 24,80" fill="none" stroke="#2a0500" stroke-width="0.5"/>
    <path d="M86,52 Q88,68 88,80 M78,52 Q78,70 76,80" fill="none" stroke="#2a0500" stroke-width="0.5"/>
    <path d="M62,108 Q88,118 92,134 L82,134 Q80,122 60,116 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.7"/>
    <path d="M88,128 L94,132 L86,134 Z" fill="#c84a20" stroke="#2a0500" stroke-width="0.5"/>
    <path d="M38,98 Q34,118 36,134 L46,134 L46,100 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.7"/>
    <path d="M62,98 Q66,118 64,134 L54,134 L54,100 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.7"/>
    <path d="M36,134 L34,138 L37,135 M40,134 L38,138 L41,135 M44,134 L42,138 L45,135" fill="none" stroke="#fff8e0" stroke-width="0.7"/>
    <path d="M56,134 L54,138 L57,135 M60,134 L58,138 L61,135 M64,134 L62,138 L65,135" fill="none" stroke="#fff8e0" stroke-width="0.7"/>
    <path d="M32,55 Q26,90 36,108 L64,108 Q74,90 68,55 Q60,52 50,52 Q40,52 32,55 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.8"/>
    <path d="M40,62 Q42,88 44,104 L56,104 Q58,88 60,62 Q55,68 50,68 Q45,68 40,62 Z" fill="#c87a3a" opacity="0.85"/>
    <path d="M44,72 Q50,76 56,72 M44,82 Q50,86 56,82 M44,92 Q50,96 56,92" fill="none" stroke="#5a1a05" stroke-width="0.5" opacity="0.7"/>
    <path d="M50,55 L48,58 L52,58 Z M50,64 L48,67 L52,67 Z M50,73 L48,76 L52,76 Z M50,84 L48,87 L52,87 Z M50,95 L48,98 L52,98 Z" fill="#c84a20"/>
    <path d="M44,40 L42,55 L58,55 L56,40 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.7"/>
    <ellipse cx="50" cy="32" rx="16" ry="13" fill="#7a1a10" stroke="#2a0500" stroke-width="0.8"/>
    <path d="M34,32 Q30,40 36,44 L52,44 Q56,38 50,30 Z" fill="#7a1a10" stroke="#2a0500" stroke-width="0.8"/>
    <ellipse cx="36" cy="38" rx="0.9" ry="1.1" fill="#2a0500"/>
    <ellipse cx="34" cy="40" rx="3" ry="1.6" fill="url(#redDragonBreath)"/>
    <path d="M34,42 L52,42" stroke="#2a0500" stroke-width="0.7"/>
    <path d="M37,42 L37,44 M41,42 L41,44.5 M45,42 L45,44 M49,42 L49,44.5" stroke="#fff8e0" stroke-width="0.5"/>
    <ellipse cx="46" cy="28" rx="3.4" ry="2.8" fill="#2a0500"/>
    <ellipse cx="58" cy="28" rx="3.4" ry="2.8" fill="#2a0500"/>
    <circle cx="46" cy="28" r="1.7" fill="url(#redDragonEye)"/>
    <circle cx="58" cy="28" r="1.7" fill="url(#redDragonEye)"/>
    <path d="M44,26 Q47,22 50,25 M56,25 Q53,22 50,25" stroke="#2a0500" stroke-width="1" fill="none"/>
    <path d="M40,22 Q34,12 28,6 Q34,12 44,22 Z" fill="#3a0a00" stroke="#1a0500" stroke-width="0.5"/>
    <path d="M60,22 Q66,12 72,6 Q66,12 56,22 Z" fill="#3a0a00" stroke="#1a0500" stroke-width="0.5"/>
    <path d="M64,30 Q70,28 74,32" stroke="#3a0a00" stroke-width="0.6" fill="none"/>
    <path d="M36,30 Q30,28 26,32" stroke="#3a0a00" stroke-width="0.6" fill="none"/>
    <path d="M64,72 Q78,80 82,98" fill="none" stroke="#7a1a10" stroke-width="6" stroke-linecap="round"/>
    <circle cx="82" cy="98" r="3.6" fill="#7a1a10" stroke="#2a0500" stroke-width="0.5"/>
    <path d="M78,100 L76,104 M82,102 L82,107 M86,100 L88,104" stroke="#fff8e0" stroke-width="0.9" stroke-linecap="round"/>
    <path d="M36,72 Q22,80 18,98" fill="none" stroke="#7a1a10" stroke-width="6" stroke-linecap="round"/>
    <circle cx="18" cy="98" r="3.6" fill="#7a1a10" stroke="#2a0500" stroke-width="0.5"/>
    <path d="M14,100 L12,104 M18,102 L18,107 M22,100 L24,104" stroke="#fff8e0" stroke-width="0.9" stroke-linecap="round"/>
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

// 마법 메뉴(모바일 액션 패드)에서 사용할 가장 최근 spell 목록과 현재 MP.
// 서버 status 가 권위적이며, renderStatus 가 매번 갱신한다. magicSpells()
// 가 currentMp 로 mpCost 를 필터링해 「당장 시전 못 하는」 마법은 패드에
// 노출되지 않는다 — 패드가 자연스럽게 짧아지고 오탭 후 「MP 부족」 도 사라진다.
let currentSpells = [];
let currentMp = 0;

function setBar(fillEl, numEl, cur, max) {
  if (!fillEl || !numEl) return;
  const total = Math.max(1, max || 0);
  const pct = Math.max(0, Math.min(100, (cur / total) * 100));
  fillEl.style.width = `${pct}%`;
  numEl.textContent = `${cur}/${max || 0}`;
}

function renderStatus(status) {
  if (!status) return;
  statusName.textContent = status.name;

  // 캐릭터 스탯 블록. 서버가 hp/mp/level/exp/klassName 을 권위로 보낸다.
  // mp 가 0 이하인 직업(novice)은 마나 행 자체를 숨겨 시각적 노이즈를 줄임.
  const classEl = document.getElementById('stat-class');
  const levelEl = document.getElementById('stat-level');
  const hpRow = document.getElementById('stat-hp-row');
  const mpRow = document.getElementById('stat-mp-row');
  const expRow = document.getElementById('stat-exp-row');
  const classHint = document.getElementById('stat-class-hint');
  if (classEl) classEl.textContent = status.klassName || '-';
  if (levelEl) levelEl.textContent = `Lv. ${status.level || 1}`;
  if (hpRow) {
    setBar(document.getElementById('stat-hp-fill'), document.getElementById('stat-hp-num'),
           status.hp ?? 0, status.maxHp ?? 0);
  }
  if (mpRow) {
    if ((status.maxMp || 0) > 0) {
      mpRow.hidden = false;
      setBar(document.getElementById('stat-mp-fill'), document.getElementById('stat-mp-num'),
             status.mp ?? 0, status.maxMp ?? 0);
    } else {
      mpRow.hidden = true;
    }
  }
  if (expRow) {
    if ((status.expNext || 0) > 0) {
      expRow.hidden = false;
      setBar(document.getElementById('stat-exp-fill'), document.getElementById('stat-exp-num'),
             status.exp ?? 0, status.expNext ?? 0);
    } else {
      // 만렙 — exp 행을 'MAX' 로 고정 표시.
      expRow.hidden = false;
      const fill = document.getElementById('stat-exp-fill');
      const num = document.getElementById('stat-exp-num');
      if (fill) fill.style.width = '100%';
      if (num) num.textContent = 'MAX';
    }
  }
  if (classHint) classHint.hidden = !status.canChangeClass;

  // 모바일 마법 메뉴를 채울 spell 목록 캐싱. 서버 status 가 클라 권위 원본.
  currentSpells = Array.isArray(status.spells) ? status.spells : [];
  currentMp = Number(status.mp) || 0;
  // 액션 패드가 떠 있는 동안 새 마법이 해금되거나 mp 가 변하면 즉시 반영.
  if (typeof renderActionPad === 'function') renderActionPad();

  equipmentEl.innerHTML = '';
  for (const [slot, label] of EQUIP_SLOTS) {
    const item = status.equipment?.[slot];
    const li = document.createElement('li');
    if (item) {
      // 능력치는 이름 옆에 같이 붙여 한 줄에 다 보이게 — 별도 컬럼을 두면
      // 좁은 사이드바에서 가독성이 떨어진다. 슬롯 라벨은 오른쪽에 그대로.
      li.innerHTML = `<span class="icon"></span><span class="name"></span><span class="slot"></span>`;
      li.querySelector('.icon').textContent = item.icon || '·';
      li.querySelector('.name').textContent = `${item.name}${formatItemStat(item, ' ')}`;
      li.querySelector('.slot').textContent = label;
      li.dataset.slot = slot;
      li.title = '클릭해서 해제';
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
      // 장비는 능력치를 이름 옆에, 소비/잡템은 수량을 우측에. 한 줄 그리드를
      // 보존하면서도 무엇을 보고 있는지 즉시 파악되게.
      li.querySelector('.name').textContent = `${it.name}${formatItemStat(it, ' ')}`;
      li.querySelector('.qty').textContent = it.kind === 'equip'
        ? (it.qty > 1 ? `×${it.qty}` : '')
        : (it.qty > 1 ? `×${it.qty}` : '');
      if (it.id) li.dataset.itemId = it.id;
      if (it.kind) li.dataset.kind = it.kind;
      li.title = it.kind === 'equip' ? '클릭해서 장착' : '클릭해서 사용';
      inventoryEl.appendChild(li);
    }
  }
}

// 아이템의 attack/defense 보너스를 「+5⚔」 / 「+3🛡」 형식으로 한 토큰화.
// stat 가 없는 소비 아이템은 빈 문자열 — sep 인자로 prefix 공백 제어.
function formatItemStat(item, sep = '') {
  const parts = [];
  if (item?.attack) parts.push(`+${item.attack}⚔`);
  if (item?.defense) parts.push(`+${item.defense}🛡`);
  return parts.length ? `${sep}${parts.join(' ')}` : '';
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
  if (!(ws && ws.readyState === WebSocket.OPEN)) {
    appendLine('서버에 연결되어 있지 않습니다.', 'line error');
    return false;
  }
  // 실제 송신 + throttle 은 sendWS 가 담당. 100ms 이내 연쇄면 false.
  return sendWS({ type: 'cmd', input });
}

// 명령 송신 + echo 라인을 묶는 헬퍼. throttle 또는 disconnected 로 송신이
// 실패하면 echo 도 함께 생략 — 로그엔 보이지만 서버엔 도착 안 한 「유령 명령」
// 을 차단한다(WASD auto-repeat 가 가장 빈번한 케이스). echoLabel 미지정 시
// input 을 그대로 사용 — `sendCmdEcho('use potion')` 처럼 한 인자로 끝나는
// 케이스가 다수. 반환값 = 송신 성공 여부.
function sendCmdEcho(input, echoLabel = input) {
  if (!sendCmd(input)) return false;
  appendLine(`> ${echoLabel}`, 'line echo');
  return true;
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
  sendCmdEcho(input);
  promptInput.value = '';
  // 모바일에서는 엔터 후 키보드를 내려 채팅 영역을 다시 노출. 데스크톱은
  // 포커스를 유지해 연속 입력이 끊기지 않게 한다.
  if (window.matchMedia('(max-width: 768px)').matches) promptInput.blur();
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
  if (e.key === 'Enter') {
    // Move mode: Enter exits to typing. Typing mode: if focus drifted to the
    // map / sidebar / body, pull it back to the prompt so the user can resume
    // typing without an extra click. When the prompt is already focused, fall
    // through and let the form's submit handler run normally.
    if (mode === 'move') {
      e.preventDefault();
      setMode('typing');
      return;
    }
    if (document.activeElement !== promptInput) {
      e.preventDefault();
      promptInput.focus();
      return;
    }
  }
  if (mode !== 'move') return;
  // Ignore modifier combos so browser shortcuts still work.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const dir = WASD_DIR[e.code];
  if (!dir) return;
  e.preventDefault();
  sendCmdEcho(`go ${dir}`, `[이동] ${dir}`);
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
    line.setAttribute('stroke', '#4a505c');
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
  const MOBILE_BP = 768; // style.css 의 @media (max-width: 768px) 와 동기.
  const STORAGE_KEY = 'agria.sidebarWidth';

  // 사용자가 의도한 사이드바 폭(드래그로 정한 값 또는 저장값). resize 시
  // 매번 다시 적용하지만, 사용자의 원래 의도는 그대로 보존해 창을 다시
  // 넓히면 그대로 펼쳐진다.
  let desiredW = (() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 0; // 0 = CSS 기본값(416px) 사용
  })();

  const clampW = (w) => {
    const maxW = window.innerWidth - MIN_VIEWPORT - RESIZER_W;
    return Math.max(MIN_SIDEBAR, Math.min(maxW, w));
  };
  const applyW = (w) => {
    app.style.gridTemplateColumns = `${clampW(w)}px ${RESIZER_W}px 1fr`;
  };

  // 모바일/데스크톱 모드 분기. 모바일 폭에서는 인라인 grid-template-columns
  // 를 **반드시 제거**해야 @media 의 단일 컬럼 레이아웃이 살아난다 — 인라인
  // 스타일이 미디어 쿼리보다 우선이라, 인라인을 두면 사이드바가 fixed 로
  // 빠져도 1번 컬럼이 416px 를 그대로 점유해 viewport(프롬프트 영역)가
  // 짜부라지는 게 이전 버그의 진짜 원인이었다.
  const refresh = () => {
    if (window.innerWidth <= MOBILE_BP) {
      app.style.removeProperty('grid-template-columns');
      return;
    }
    if (desiredW > 0) applyW(desiredW);
    else app.style.removeProperty('grid-template-columns'); // 원래 CSS 기본
  };
  refresh();

  window.addEventListener('resize', refresh);

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
    desiredW = sidebar.getBoundingClientRect().width;
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(desiredW)));
    } catch {}
  };
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);
}

// ── Inventory click (event delegation) ──────────────────
// 장비는 「장착」 으로, 소비/잡템은 「사용」 으로 라우팅. 서버의 useItem 도
// equip-kind 가 들어오면 자동으로 equip 으로 넘기지만, 클라가 미리 갈래를
// 정해 두면 echo 라인이 의도와 일치해(「> 장착 …」) 사용자가 헷갈리지 않음.
inventoryEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-item-id]');
  if (!li) return;
  const id = li.dataset.itemId;
  const kind = li.dataset.kind;
  if (kind === 'equip') {
    sendCmdEcho(`equip ${id}`, `장착 ${id}`);
  } else {
    sendCmdEcho(`use ${id}`);
  }
});

// ── Equipment slot click → unequip ─────────────────────
// 슬롯에 장착된 아이템을 한 번 탭/클릭으로 해제해 인벤토리로 돌려놓는다.
// 빈 슬롯 li(.empty)에는 data-slot 이 안 붙어 있어 매칭되지 않음 — 빈 칸을
// 눌러도 무반응.
equipmentEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-slot]');
  if (!li) return;
  const slot = li.dataset.slot;
  sendCmdEcho(`unequip ${slot}`, `해제 ${slot}`);
});

function setupDpad() {
  const dpad = document.getElementById('dpad');
  if (!dpad) return;
  dpad.addEventListener('click', (e) => {
    const btn = e.target.closest('.dpad-btn');
    if (!btn) return;
    const dir = btn.dataset.dir;
    if (!dir) return;
    sendCmdEcho(`go ${dir}`, `[이동] ${dir}`);
  });
}

// Hierarchical action pad. Root level shows category buttons (공격 / 봐 / 마법)
// only for categories with at least one valid action in the current room.
// 'attack'/'look' descend one level into target selection. 'magic' descends
// two levels — first the spell list (filtered to spells the player has and
// can afford), then the target list. Tapping a leaf fires the command and
// returns to root. The back button (↩) returns one step.
let currentRoomTargets = { monsters: [], objects: [], players: [] };
let actionPadLevel = 'root'; // 'root' | 'attack' | 'look' | 'magic-spells' | 'magic-targets'
let selectedSpell = null;    // { id, name, mpCost, ... } when in magic-targets

function attackableTargets() {
  // Players are technically valid attack targets server-side, but we
  // intentionally don't surface them in the touch UI to avoid one-tap PvP.
  return currentRoomTargets.monsters || [];
}

function lookableTargets() {
  return [
    ...(currentRoomTargets.monsters || []),
    ...(currentRoomTargets.objects || []),
    ...(currentRoomTargets.players || []),
  ];
}

// 마법 시전 가능한 대상은 몬스터로 한정 — PvP 마법은 의도적으로 모바일 메뉴에서
// 노출하지 않는다(공격 카테고리와 동일한 안전장치).
function magicTargets() {
  return currentRoomTargets.monsters || [];
}

// 「이미 교전 중이면 타깃 선택 단계를 건너뛴다」 단축경로 헬퍼.
// 현재 교전 foe 가 같은 방의 몬스터 리스트에 그대로 있을 때만 직접 명령
// 가능 — 이미 죽었거나 다른 방으로 가 버렸다면 null 을 돌려줘 액션 패드가
// 정상적으로 타깃 리스트로 떨어지게 한다. 이름 일치로 매칭(서버 resolver
// 가 받는 키와 동일).
function combatFoeInRoom() {
  if (!currentCombatFoe) return null;
  if (currentCombatFoe.kind !== 'monster') return null;
  const monsters = currentRoomTargets.monsters || [];
  return monsters.find(m => m.name === currentCombatFoe.name) || null;
}

// 메뉴 노출용. spells 배열은 server status 가 권위. spell.element 를 그대로
// 버튼 클래스로 끌어오면 자동으로 element 색이 입혀진다(action-spell-fire 등).
// MP 부족한 마법은 제외 — 「누르면 실패」를 원천 차단하고 패드 길이도 줄인다.
// MP 가 다시 차오르면 status push 가 renderActionPad 를 호출해 자동 복원.
function magicSpells() {
  if (!Array.isArray(currentSpells)) return [];
  return currentSpells.filter(s => Number(s.mpCost) <= currentMp);
}

function makeActionBtn(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action-btn' + (cls ? ' ' + cls : '');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// 마법 전용 버튼 — 본문(이름)과 우상단 MP superscript 로 시각 위계 분리.
// 일반 makeActionBtn 과 달리 MP 가 본문 폭을 잡아먹지 않게 absolute 로 띄운다.
function makeSpellBtn(name, mpCost, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action-btn' + (cls ? ' ' + cls : '');
  const nameEl = document.createElement('span');
  nameEl.className = 'spell-name';
  nameEl.textContent = name;
  const mpEl = document.createElement('span');
  mpEl.className = 'spell-mp';
  mpEl.textContent = mpCost;
  btn.append(nameEl, mpEl);
  btn.addEventListener('click', onClick);
  return btn;
}

function renderActionPad() {
  const pad = document.getElementById('action-pad');
  if (!pad) return;
  pad.innerHTML = '';
  // 어떤 분기로 빠지더라도 한 번만 — 가로 스크롤이 우측 끝(↩/최신 카테고리)
  // 으로 맞춰지도록. rAF 가 같은 tick 의 appendChild 끝난 뒤에 실행되므로
  // scrollWidth 가 정확하게 잡힌다. 분기마다 return 직전에 부르는 것보다 안전.
  scrollActionPadToEnd();
  // If current sub-level lost all its targets (last monster died, etc.),
  // gracefully fall back to root rather than rendering an empty pane.
  if (actionPadLevel === 'attack' && attackableTargets().length === 0) actionPadLevel = 'root';
  if (actionPadLevel === 'look' && lookableTargets().length === 0) actionPadLevel = 'root';
  if (actionPadLevel === 'magic-spells' && magicSpells().length === 0) actionPadLevel = 'root';
  if (actionPadLevel === 'magic-targets' && magicTargets().length === 0) {
    actionPadLevel = 'magic-spells';
    if (magicSpells().length === 0) actionPadLevel = 'root';
  }

  if (actionPadLevel === 'root') {
    if (attackableTargets().length > 0) {
      // 교전 중이면 타깃 리스트로 내려가지 않고 현재 foe 에게 즉시 공격.
      pad.appendChild(makeActionBtn('공격', 'action-cat', () => {
        const foe = combatFoeInRoom();
        if (foe) {
          sendCmdEcho(`attack ${foe.name}`, `공격 ${foe.name}`);
          return;
        }
        actionPadLevel = 'attack';
        renderActionPad();
      }));
    }
    if (lookableTargets().length > 0) {
      pad.appendChild(makeActionBtn('봐', 'action-cat', () => {
        actionPadLevel = 'look';
        renderActionPad();
      }));
    }
    if (magicSpells().length > 0 && magicTargets().length > 0) {
      pad.appendChild(makeActionBtn('마법', 'action-cat action-cat-magic', () => {
        actionPadLevel = 'magic-spells';
        renderActionPad();
      }));
    }
    return;
  }

  if (actionPadLevel === 'magic-spells') {
    // 마법 선택 시 — 교전 중이면 곧바로 시전, 아니면 평소대로 타깃 선택으로.
    // 라벨: 본문은 마법 이름만, MP 비용은 우상단 작은 superscript 로 분리.
    // 「N MP」를 본문에서 떼어내 평균 버튼 폭을 30~40% 줄인다.
    for (const s of magicSpells()) {
      const cls = `action-target action-spell action-spell-${s.element}`;
      pad.appendChild(makeSpellBtn(s.name, s.mpCost, cls, () => {
        const foe = combatFoeInRoom();
        if (foe) {
          sendCmdEcho(`${s.name} ${foe.name}`);
          actionPadLevel = 'root';
          selectedSpell = null;
          return;
        }
        selectedSpell = s;
        actionPadLevel = 'magic-targets';
        renderActionPad();
      }));
    }
    pad.appendChild(makeActionBtn('↩', 'action-back', () => {
      actionPadLevel = 'root';
      renderActionPad();
    }));
    return;
  }

  if (actionPadLevel === 'magic-targets') {
    const spell = selectedSpell;
    for (const t of magicTargets()) {
      pad.appendChild(makeActionBtn(t.name, `action-target action-spell-${spell?.element || 'fire'}`, () => {
        sendCmdEcho(`${spell.name} ${t.name}`);
        actionPadLevel = 'root';
        selectedSpell = null;
        renderActionPad();
      }));
    }
    pad.appendChild(makeActionBtn('↩', 'action-back', () => {
      actionPadLevel = 'magic-spells';
      renderActionPad();
    }));
    return;
  }

  const targets = actionPadLevel === 'attack' ? attackableTargets() : lookableTargets();
  const verbLabel = actionPadLevel === 'attack' ? '공격' : '봐';
  const verbCmd = actionPadLevel === 'attack' ? 'attack' : 'look';
  for (const t of targets) {
    pad.appendChild(makeActionBtn(t.name, 'action-target', () => {
      sendCmdEcho(`${verbCmd} ${t.name}`, `${verbLabel} ${t.name}`);
      actionPadLevel = 'root';
      renderActionPad();
    }));
  }
  pad.appendChild(makeActionBtn('↩', 'action-back', () => {
    actionPadLevel = 'root';
    renderActionPad();
  }));
}

// 가로 스크롤 패드 — 매 렌더 직후 우측 끝(가장 최근 추가된 카테고리/백 버튼)
// 이 보이도록 스크롤 위치를 맞춘다. 컨테이너가 비거나 폭에 다 들어가면 no-op.
function scrollActionPadToEnd() {
  const pad = document.getElementById('action-pad');
  if (!pad) return;
  // rAF — DOM 추가 직후엔 layout 계산이 안 끝나 scrollWidth 가 0 일 수 있다.
  requestAnimationFrame(() => { pad.scrollLeft = pad.scrollWidth; });
}

function setupActionPad() {
  // Pad is rendered dynamically on every state change; nothing to do at init
  // beyond clearing the static placeholder buttons declared in index.html.
  renderActionPad();
}

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

// 모바일에서 prompt 입력창이 포커스를 받으면 form을 layout viewport 상단으로
// 띄워 키보드 크기와 무관하게 항상 노출. blur(엔터 후 자동 호출 또는 외부
// 터치)되면 data-prompt-focused 플래그가 풀려 원래 viewport 하단으로 복귀.
// visualViewport.height를 추적하는 기존 방식보다 단순하고 robust — predictive
// bar, 자동완성, iOS 버전에 따른 visual viewport 동작 차이에 영향받지 않음.
function setupPromptFocusFloat() {
  if (!promptInput) return;
  promptInput.addEventListener('focus', () => {
    document.body.dataset.promptFocused = '1';
  });
  promptInput.addEventListener('blur', () => {
    delete document.body.dataset.promptFocused;
  });
}

// ── Settings: theme picker ─────────────────────────────────
// 테마 정의는 클라이언트의 단일 진실원. id 는 themes/<id>.css 파일 + html
// data-theme 값과 일치. 새 테마 추가 시: (1) themes/<id>.css 작성 →
// (2) index.html 에 <link> 추가 → (3) 아래 THEMES 배열에 한 줄 추가.
// swatch 는 설정 모달에서 한눈에 팔레트를 비교하기 위한 작은 색 견본.
const THEMES = [
  {
    id: 'default',
    name: '기본',
    desc: '양피지 다크',
    swatch: ['#0e0f12', '#c9a14a', '#6db3c4', '#e07b8c'],
  },
  {
    id: 'dracula',
    name: 'Dracula',
    desc: 'IntelliJ Dracula',
    swatch: ['#282a36', '#bd93f9', '#8be9fd', '#ff79c6'],
  },
  {
    id: 'pctongsin',
    name: 'PC통신',
    desc: '천리안·나우누리',
    swatch: ['#000000', '#000080', '#ffff55', '#55ffff'],
  },
  {
    id: 'nmon',
    name: 'nmon',
    desc: 'AIX/Linux 모니터',
    swatch: ['#000000', '#00ff00', '#00ffff', '#ffff00'],
  },
];
const DEFAULT_THEME = 'default';
const THEME_KEY = 'agria.theme';

function getSavedTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch {}
  return DEFAULT_THEME;
}
function applyTheme(id) {
  const valid = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = valid;
  try { localStorage.setItem(THEME_KEY, valid); } catch {}
  // 모달이 열려 있으면 선택 표시도 동기화
  const list = document.getElementById('theme-options');
  if (list) {
    list.querySelectorAll('.theme-option').forEach((el) => {
      const isMe = el.dataset.themeId === valid;
      el.classList.toggle('selected', isMe);
      const radio = el.querySelector('input[type="radio"]');
      if (radio) radio.checked = isMe;
    });
  }
}

function renderThemeOptions(current) {
  const list = document.getElementById('theme-options');
  if (!list) return;
  list.innerHTML = '';
  for (const t of THEMES) {
    const label = document.createElement('label');
    label.className = 'theme-option' + (t.id === current ? ' selected' : '');
    label.dataset.themeId = t.id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'theme';
    radio.value = t.id;
    radio.checked = t.id === current;
    radio.addEventListener('change', () => {
      if (radio.checked) applyTheme(t.id);
    });
    label.appendChild(radio);

    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = t.name;
    label.appendChild(name);

    if (Array.isArray(t.swatch) && t.swatch.length) {
      const swatch = document.createElement('span');
      swatch.className = 'theme-swatch';
      for (const c of t.swatch) {
        const chip = document.createElement('span');
        chip.style.background = c;
        swatch.appendChild(chip);
      }
      label.appendChild(swatch);
    }

    const desc = document.createElement('span');
    desc.className = 'theme-desc';
    desc.textContent = t.desc || '';
    label.appendChild(desc);

    list.appendChild(label);
  }
}

let settingsOpen = false;
function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;
  renderThemeOptions(document.documentElement.dataset.theme || DEFAULT_THEME);
  overlay.hidden = false;
  settingsOpen = true;
}
function closeSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  settingsOpen = false;
}

function setupSettings() {
  applyTheme(getSavedTheme());
  const openBtn = document.getElementById('settings-open');
  const closeBtn = document.getElementById('settings-close');
  const overlay = document.getElementById('settings-overlay');
  openBtn?.addEventListener('click', openSettings);
  closeBtn?.addEventListener('click', closeSettings);
  // 배경(카드 바깥) 클릭 시 닫기
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });
}

// 설정 모달이 열려 있을 때 ESC 는 모드 토글이 아닌 모달 닫기로 가로챈다.
// capture 단계에서 받아 기존 keydown 핸들러보다 먼저 실행한다.
document.addEventListener('keydown', (e) => {
  if (settingsOpen && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSettings();
  }
}, true);

buildMap();
setupSidebarResizer();
setupMobileSidebar();
setupDpad();
setupActionPad();
setupPromptFocusFloat();
setupSettings();
recomputeMapViewport();
new ResizeObserver(() => recomputeMapViewport()).observe(document.getElementById('sidebar'));
setMode('typing');
connect();
