import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import {
  WS_MAX_PAYLOAD,
  CONN_RATE_WINDOW_MS,
  CONN_RATE_LIMIT,
} from './config.js';
import { initStore, bindShutdownFlush } from './store.js';
import {
  isNaverConfigured,
  handleLoginRedirect,
  handleCallback,
  handleMe,
  handleLogout,
  authenticateWsRequest,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// 프로세스 부팅 시각을 서버 버전으로 사용. 클라가 재연결 후 이 값이 이전과
// 달라지면 배포가 일어났다고 간주하고 새로고침한다.
const SERVER_VERSION = Date.now();
// Dev mode toggles relaxations for local testing — multi-tab session isolation
// (client switches sid storage to sessionStorage so each tab is a distinct
// player) and bypassing the per-IP connection rate so opening many tabs from
// localhost doesn't trip the gate.
const DEV = !!process.env.DEV;

// 같은 sid 의 다른 탭이 살아 있을 때 신규 소켓이 사용자 결정을 기다리는 시간.
// 「duplicate_pending」 으로 안내한 뒤 force_takeover/cancel_connect 가 안 오면
// 서버가 끊는다. 너무 짧으면 모달 읽는 사이에 끊기고, 너무 길면 좀비 소켓.
const DUPLICATE_PENDING_TIMEOUT_MS = 30000;

const app = express();
// Synchronous-loadable env shim. Client reads window.AGRIA_DEV before the
// main bundle decides which Storage to bind sid to. NAVER_LOGIN 은 클라이언트가
// 「네이버로 로그인」 버튼을 보여줄지 결정하는 데 사용 — 비활성 환경에서는
// 버튼을 숨겨 死버튼이 안 뜨도록.
app.get('/env.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.AGRIA_DEV = ${DEV}; window.AGRIA_NAVER_LOGIN = ${isNaverConfigured()};`);
});

// 네이버 OAuth 라우트. express 의 자체 라우팅을 그대로 쓰고, 핸들러는
// vanilla (req, res) — 쿠키/리다이렉트만 다루면 충분해 미들웨어가 필요 없다.
// async 핸들러는 wrapAsyncRoute 로 감싸서 핸들러 내부에서 throw 가 된 경우
// 라우트가 hang 되지 않고 500 으로 수렴하도록 한다.
function wrapAsyncRoute(name, handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error(`[auth] ${name} handler crash:`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  };
}
app.get('/auth/naver/login', handleLoginRedirect);
app.get('/auth/naver/callback', wrapAsyncRoute('callback', handleCallback));
app.get('/auth/me', handleMe);
app.post('/auth/logout', wrapAsyncRoute('logout', handleLogout));

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
// maxPayload caps a single client→server frame. Larger frames cause `ws` to
// emit an error and close the socket — DoS via 100 MiB `say` is killed at the
// wire level before any game logic runs.
//
// perMessageDeflate=false: ws 라이브러리 기본값(true) 은 짧은 JSON(20~600B)
// 페이로드에서 「대역 절감 < CPU/메모리 비용」 영역이고, 1k 동시 연결 시
// deflate 컨텍스트 메모리(연결당 수십 KB) 누적이 큰 부담이 된다. 큰 페이로드
// (예: character_sprite SVG, ~수 KB) 는 자체 stringify 가 cache hit + 룸당 1 회만
// 일어나 압축 ROI 가 낮다.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: WS_MAX_PAYLOAD,
  perMessageDeflate: false,
});
const game = new Game();

// Per-IP sliding-window connection counter. Trades exact precision for memory:
// each IP keeps an array of recent connect timestamps, pruned on access. Sweep
// drops empty entries so unique-IP churn doesn't grow the map unbounded.
const ipConnections = new Map();
function ipRateAllow(ip) {
  const now = Date.now();
  const arr = (ipConnections.get(ip) || []).filter(t => now - t < CONN_RATE_WINDOW_MS);
  if (arr.length >= CONN_RATE_LIMIT) {
    ipConnections.set(ip, arr);
    return false;
  }
  arr.push(now);
  ipConnections.set(ip, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipConnections) {
    const fresh = arr.filter(t => now - t < CONN_RATE_WINDOW_MS);
    if (fresh.length === 0) ipConnections.delete(ip);
    else ipConnections.set(ip, fresh);
  }
}, CONN_RATE_WINDOW_MS).unref();

wss.on('connection', (socket, req) => {
  const ip = req.socket.remoteAddress || '';
  // In dev, skip the per-IP gate entirely — opening many local tabs in quick
  // succession is a normal testing workflow and the limit would block it.
  if (!DEV && !ipRateAllow(ip)) {
    // 4003 = application policy violation. Client retries with backoff.
    try { socket.close(4003, 'rate limit'); } catch {}
    return;
  }

  // sid is a client-generated random string in localStorage; lets a reconnect
  // resume the same player object during RECONNECT_GRACE_MS. No auth — sid is
  // a soft identifier, but combined with the disconnect grace it neutralizes
  // the trivial "close socket to dodge penalty" bypass.
  let sid = '';
  try {
    const url = new URL(req.url, 'http://x');
    sid = (url.searchParams.get('sid') || '').slice(0, 64);
  } catch {}

  // 인증된 사용자라면 sid 대신 naverId 로 player 객체를 키잉. 같은 계정이
  // 다른 디바이스에서 재로그인해 sessionToken 이 회전된 경우는 cookie 의 token
  // 이 더 이상 store 에 없어 auth=null 로 떨어진다 — 이 소켓은 자동으로 익명
  // 분기로 빠져 등록 또는 sid 기반 동작이 되며, 클라이언트 측에서 /auth/me 가
  // 401 을 받아 로그인 모달을 다시 띄운다.
  const auth = authenticateWsRequest(req);

  // Older-wins (production): 같은 sid 의 살아 있는 소켓이 이미 있으면 신규를
  // 즉시 거절하지 않고 「duplicate_pending」 브릿지 페이즈로 사용자 결정을 받음.
  // DEV 는 같은 탭 새로고침 race 를 받아 주기 위해 newer-wins 유지.
  const player = game.attachPlayer(socket, sid, { allowTakeover: DEV, auth });
  if (!player) {
    handleDuplicatePending(socket, sid, auth);
    return;
  }
  bindSession(socket, player);
});

// 정상 attach 된 소켓에 표준 메시지/close/error 핸들러를 건다. duplicate_pending
// → force_takeover 경로에서도 takeover 성공 후 동일하게 호출되도록 분리.
function bindSession(socket, player) {
  try { socket.send(JSON.stringify({ type: 'server_info', version: SERVER_VERSION })); } catch {}

  socket.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    try {
      if (msg?.type === 'cmd' && typeof msg.input === 'string') {
        game.handleCommand(player, msg.input);
      } else if (msg?.type === 'register' && typeof msg.name === 'string' && typeof msg.description === 'string') {
        await game.registerPlayer(player, msg.name, msg.description);
      }
    } catch (err) {
      console.error('message error', err);
      try { socket.send(JSON.stringify({ type: 'system', text: '오류가 발생했습니다.' })); } catch {}
    }
  });

  // Identity guard: a force-takeover (newer-wins) rebound the player to a
  // different socket — this old socket's close belongs to the past and must
  // NOT detach the now-active session. Compare object identity, not id.
  socket.on('close', () => { if (player.socket === socket) game.detachPlayer(player.id); });
  socket.on('error', () => { if (player.socket === socket) game.detachPlayer(player.id); });
}

// 같은 sid 의 살아 있는 소켓이 이미 있을 때 호출. 직전 커밋은 즉시 close(4004)
// 했지만 close 프레임이 종종 1005/1006 으로 mangling 되어 클라이언트가 generic
// auto-reconnect 분기로 떨어지면서 무한 핑퐁이 발생했다. 이번엔 close 에 의존
// 하지 않고 「duplicate_pending」 JSON 으로 브릿지 페이즈를 명시해, 사용자가
// force_takeover/cancel_connect 를 보내야 서버가 행동하도록 바꾼다.
function handleDuplicatePending(socket, sid, auth) {
  try { socket.send(JSON.stringify({ type: 'duplicate_pending' })); } catch {}

  const timeout = setTimeout(() => {
    try { socket.close(4004, 'duplicate session timeout'); } catch {}
  }, DUPLICATE_PENDING_TIMEOUT_MS);
  const cleanup = () => { clearTimeout(timeout); };

  const onMessage = (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg?.type === 'force_takeover') {
      cleanup();
      socket.off('message', onMessage);

      // 기존 탭에 먼저 통보 — close(4001) 이 1006 으로 mangling 되어도 모달이
      // 떠서 재연결 정책이 정해지도록. send 는 close 보다 먼저 큐에 들어간다.
      const existing = game.lookupExistingPlayer({ sid, auth });
      if (existing && existing.socket && existing.socket.readyState === 1) {
        try { existing.socket.send(JSON.stringify({ type: 'kicked_by_other' })); } catch {}
      }

      const taken = game.attachPlayer(socket, sid, { allowTakeover: true, auth });
      if (!taken) {
        try { socket.close(4004, 'takeover failed'); } catch {}
        return;
      }
      bindSession(socket, taken);
      return;
    }

    if (msg?.type === 'cancel_connect') {
      cleanup();
      socket.off('message', onMessage);
      try { socket.close(4004, 'cancelled by user'); } catch {}
    }
  };

  socket.on('message', onMessage);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// 영속 스토어 부팅. JSON 파일 한 개를 통째로 메모리로 올린다 — 미존재면 빈
// 상태로 시작. 모든 라우트/WS 가 이 호출 이후 store API 를 안전하게 호출할 수
// 있도록 listen 직전에 await.
await initStore();
bindShutdownFlush();

server.listen(PORT, () => {
  const tag = DEV ? ' [DEV]' : '';
  const auth = isNaverConfigured() ? ' [NAVER_LOGIN]' : '';
  console.log(`Agria server listening on http://localhost:${PORT}${tag}${auth}`);
});
