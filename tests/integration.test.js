// HTTP 라우트 + WebSocket 인증 통합 테스트.
// 실제 server/index.js 서브프로세스를 띄우고 (격리된 tmp 데이터 디렉터리, 임의
// 포트, 시드된 사용자), 라우트와 WS attach 동작을 검증한다.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let serverProc;
let baseUrl;
let port;
let dataDir;

// 서버 부팅. 기존 사용자 + 캐릭터 스냅샷을 미리 시드해 hydrate 동작을 검증
// 가능하도록 한다 — registerPlayer 의 sprite generation(LLM) 을 우회.
before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agria-int-'));

  // 시드: token=seed_token_abc... 로 직접 사용자 + 캐릭터 작성.
  // 형상은 store.js 의 UserRec 와 동일 — 직접 파일에 써 넣어 서버 부팅 시
  // initStore 가 그대로 읽도록 한다.
  const seed = {
    byNaverId: {
      'naver_seed': {
        provider: 'naver',
        providerUserId: 'naver_seed',
        nickname: '시드유저',
        sessionToken: 'a'.repeat(64),
        sessionRotatedAt: Date.now(),
        character: {
          name: '시드영웅',
          description: '오랜 모험가',
          klass: 'mage',
          level: 8,
          exp: 1200,
          hp: 100,
          maxHp: 170,
          mp: 30,
          maxMp: 65,
          equipment: { head: null, body: null, weapon: null, offhand: null, feet: null },
          inventory: [],
          roomId: 'square',
          spriteSvg: null,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  };
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify(seed), 'utf8');

  port = 3500 + Math.floor(Math.random() * 500);
  baseUrl = `http://localhost:${port}`;
  await startServer();
});

after(async () => {
  await stopServer();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('GET /env.js: AGRIA_NAVER_LOGIN 플래그가 노출됨', async () => {
  const r = await fetch(`${baseUrl}/env.js`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /window\.AGRIA_DEV\s*=/);
  assert.match(body, /window\.AGRIA_NAVER_LOGIN\s*=/);
  // 시드 케이스는 NAVER_CLIENT_ID 미설정이므로 false.
  assert.match(body, /AGRIA_NAVER_LOGIN\s*=\s*false/);
});

test('GET /auth/me: 쿠키 없으면 401', async () => {
  const r = await fetch(`${baseUrl}/auth/me`);
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.ok, false);
});

test('GET /auth/me: 시드된 sessionToken 쿠키로 200 + 닉네임 반환', async () => {
  const r = await fetch(`${baseUrl}/auth/me`, {
    headers: { Cookie: `agria_session=${'a'.repeat(64)}` },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.nickname, '시드유저');
  assert.equal(j.hasCharacter, true);
});

test('GET /auth/me: 알 수 없는 토큰은 401(다른 디바이스 로그인 후의 옛 쿠키 시뮬레이션)', async () => {
  const r = await fetch(`${baseUrl}/auth/me`, {
    headers: { Cookie: 'agria_session=' + 'b'.repeat(64) },
  });
  assert.equal(r.status, 401);
});

test('GET /auth/naver/login: env 미설정 환경에서 503', async () => {
  const r = await fetch(`${baseUrl}/auth/naver/login`, { redirect: 'manual' });
  assert.equal(r.status, 503);
});

test('POST /auth/logout: 토큰 무효화 + Set-Cookie 로 삭제', async () => {
  // 시드 토큰을 들고 logout — 이후 같은 토큰은 더 이상 인식되면 안 됨.
  const r = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { Cookie: `agria_session=${'a'.repeat(64)}` },
  });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get('set-cookie') || '';
  assert.match(setCookie, /agria_session=/);
  assert.match(setCookie, /Max-Age=0/);

  // logout 후 /auth/me 는 같은 토큰으로 401 — 토큰 회전이 디스크까지 반영됨.
  const me = await fetch(`${baseUrl}/auth/me`, {
    headers: { Cookie: `agria_session=${'a'.repeat(64)}` },
  });
  assert.equal(me.status, 401);
});

test('WS attach: 익명 sid 만으로 들어오면 welcome 모달이 도착', async () => {
  const ws = new WebSocket(`ws://localhost:${port}/ws?sid=${'z'.repeat(32)}`);
  const messages = await collectUntil(ws, (m) => m.type === 'welcome', 3000);
  assert.ok(messages.find(m => m.type === 'welcome'), 'welcome 메시지 도착');
  ws.close();
});

test('WS attach: 인증된 사용자는 저장된 캐릭터로 hydrate (welcome 없이 status)', async () => {
  // 순서가 중요: 서버를 먼저 죽여야 한다. 살아 있는 동안 파일을 덮어써도 SIGTERM
  // 핸들러의 flushNow 가 in-memory(이미 logout 으로 token=null) 상태를 디스크에
  // 다시 써 우리 시드를 지운다.
  await stopServer();
  const fresh = 'c'.repeat(64);
  const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'users.json'), 'utf8'));
  raw.byNaverId.naver_seed.sessionToken = fresh;
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify(raw), 'utf8');
  await startServer();

  const ws = new WebSocket(`ws://localhost:${port}/ws?sid=${'w'.repeat(32)}`, {
    headers: { Cookie: `agria_session=${fresh}` },
  });

  const messages = await collectUntil(ws, (m) => m.type === 'status', 3000);
  // welcome 은 절대 도착하면 안 됨 — hydrate 경로의 핵심.
  assert.ok(!messages.find(m => m.type === 'welcome'), 'welcome 없음');
  const status = messages.find(m => m.type === 'status');
  assert.ok(status, 'status 도착');
  assert.equal(status.status.name, '시드영웅');
  assert.equal(status.status.level, 8);
  assert.equal(status.status.klass, 'mage');
  assert.equal(status.status.roomId, 'square');
  ws.close();
});

// --- helpers ---

function collectUntil(ws, pred, ms) {
  const out = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ws collect timeout — got: ' + out.map(m=>m.type).join(','))), ms);
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(data);
        out.push(m);
        if (pred(m)) {
          clearTimeout(timeout);
          resolve(out);
        }
      } catch {}
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function startServer() {
  serverProc = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      AGRIA_DATA_DIR: dataDir,
      // OAuth 라우트의 비활성 분기를 명시적으로 검증하려고 의도적으로 비움.
      NAVER_CLIENT_ID: '',
      NAVER_CLIENT_SECRET: '',
      DEV: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => reject(new Error('server boot timeout')), 5000);
    serverProc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.includes('Agria server listening')) { clearTimeout(timeout); resolve(); }
    });
    serverProc.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk));
    serverProc.on('exit', (code) => reject(new Error(`server exited ${code} before listening`)));
  });
}

async function stopServer() {
  if (!serverProc || serverProc.killed) return;
  serverProc.kill('SIGTERM');
  await new Promise((r) => serverProc.once('exit', r));
}
