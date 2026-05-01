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
// main bundle decides which Storage to bind sid to.
app.get('/env.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.AGRIA_DEV = ${DEV};`);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
// maxPayload caps a single client→server frame. Larger frames cause `ws` to
// emit an error and close the socket — DoS via 100 MiB `say` is killed at the
// wire level before any game logic runs.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: WS_MAX_PAYLOAD });
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

  // Older-wins (production): 같은 sid 의 살아 있는 소켓이 이미 있으면 신규를
  // 즉시 거절하지 않고 「duplicate_pending」 브릿지 페이즈로 사용자 결정을 받음.
  // DEV 는 같은 탭 새로고침 race 를 받아 주기 위해 newer-wins 유지.
  const player = game.attachPlayer(socket, sid, { allowTakeover: DEV });
  if (!player) {
    handleDuplicatePending(socket, sid);
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
function handleDuplicatePending(socket, sid) {
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
      const existing = game.sidToPlayer.get(sid);
      if (existing && existing.socket && existing.socket.readyState === 1) {
        try { existing.socket.send(JSON.stringify({ type: 'kicked_by_other' })); } catch {}
      }

      const taken = game.attachPlayer(socket, sid, { allowTakeover: true });
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

server.listen(PORT, () => {
  const tag = DEV ? ' [DEV]' : '';
  console.log(`Agria server listening on http://localhost:${PORT}${tag}`);
});
