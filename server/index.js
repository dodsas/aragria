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
// Dev mode toggles relaxations for local testing — multi-tab session isolation
// (client switches sid storage to sessionStorage so each tab is a distinct
// player) and bypassing the per-IP connection rate so opening many tabs from
// localhost doesn't trip the gate.
const DEV = !!process.env.DEV;

const app = express();
// Synchronous-loadable env shim. Client reads window.ARAGRIA_DEV before the
// main bundle decides which Storage to bind sid to.
app.get('/env.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.ARAGRIA_DEV = ${DEV};`);
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

  const player = game.attachPlayer(socket, sid);
  if (!player) return; // duplicate active session — game already closed the socket

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
});

server.listen(PORT, () => {
  const tag = DEV ? ' [DEV]' : '';
  console.log(`Aragria server listening on http://localhost:${PORT}${tag}`);
});
