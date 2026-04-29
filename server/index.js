import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const game = new Game();

wss.on('connection', (socket) => {
  const player = game.addPlayer(socket);

  socket.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg?.type === 'cmd' && typeof msg.input === 'string') {
      try {
        game.handleCommand(player, msg.input);
      } catch (err) {
        console.error('command error', err);
        socket.send(JSON.stringify({ type: 'system', text: '오류가 발생했습니다.' }));
      }
    }
  });

  socket.on('close', () => game.removePlayer(player.id));
  socket.on('error', () => game.removePlayer(player.id));
});

server.listen(PORT, () => {
  console.log(`Aragria server listening on http://localhost:${PORT}`);
});
