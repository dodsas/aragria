// game.js — Game 클래스의 인-프로세스 단위 테스트.
// AGRIA_DATA_DIR 를 격리된 tmp 로 가리킨 뒤 Game 을 동적 import — 모듈 로드
// 시점에 store 가 그 경로를 잡도록.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let Game;
let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agria-game-'));
  process.env.AGRIA_DATA_DIR = tmpDir;
  ({ Game } = await import('../server/game.js'));
});

test('lookupExistingPlayer: sid/auth 모두 비면 null', () => {
  const g = new Game();
  assert.equal(g.lookupExistingPlayer({}), null);
  assert.equal(g.lookupExistingPlayer({ sid: '' }), null);
  assert.equal(g.lookupExistingPlayer({ auth: null }), null);
});

test('lookupExistingPlayer: sid 만 있으면 sidToPlayer 에서 조회', () => {
  const g = new Game();
  const fake = { id: 1, sid: 'aaa' };
  g.sidToPlayer.set('aaa', fake);
  assert.equal(g.lookupExistingPlayer({ sid: 'aaa' }), fake);
  assert.equal(g.lookupExistingPlayer({ sid: 'missing' }), null);
});

test('lookupExistingPlayer: auth.naverId 가 있으면 naverIdToPlayer 가 우선', () => {
  const g = new Game();
  const sidPlayer = { id: 1, sid: 'aaa' };
  const authPlayer = { id: 2, naverId: 'n42' };
  g.sidToPlayer.set('aaa', sidPlayer);
  g.naverIdToPlayer.set('n42', authPlayer);
  // 같은 sid 가 있어도 auth 가 있으면 그쪽이 이긴다 — 같은 계정의 단일성을 우선.
  assert.equal(g.lookupExistingPlayer({ sid: 'aaa', auth: { naverId: 'n42' } }), authPlayer);
  // auth 만 있는 경우 sid 키스페이스 영향 없음.
  assert.equal(g.lookupExistingPlayer({ auth: { naverId: 'n42' } }), authPlayer);
  assert.equal(g.lookupExistingPlayer({ auth: { naverId: 'unknown' } }), null);
});

// _reattachExistingPlayer 의 socket 갈아끼우기 + grace cleanup 동작.
// 실제 ws 객체 대신 readyState/close 를 흉내내는 stub 으로 검증.
test('_reattachExistingPlayer: 살아 있는 옛 socket 은 takeover 정책에 따라 처리', () => {
  const g = new Game();
  const oldSocket = makeSocketStub({ readyState: 1 });
  const newSocket = makeSocketStub({ readyState: 1 });
  const player = baseExistingPlayer({ socket: oldSocket });
  g.players.set(player.id, player);

  // allowTakeover=false → null 반환, 옛 socket 보존.
  const r1 = g._reattachExistingPlayer(player, newSocket, '', false);
  assert.equal(r1, null);
  assert.equal(oldSocket.closed, false);
  assert.equal(player.socket, oldSocket);

  // allowTakeover=true → 옛 socket close(4001), 새 socket 으로 교체.
  const r2 = g._reattachExistingPlayer(player, newSocket, '', true);
  assert.equal(r2, player);
  assert.equal(oldSocket.closed, true);
  assert.equal(oldSocket.closeCode, 4001);
  assert.equal(player.socket, newSocket);
});

test('_reattachExistingPlayer: graceTimer 와 disconnectedAt 정리', () => {
  const g = new Game();
  let timerFired = false;
  const player = baseExistingPlayer({
    socket: null,
    disconnectedAt: Date.now(),
    graceTimer: setTimeout(() => { timerFired = true; }, 5000),
  });
  g.players.set(player.id, player);

  g._reattachExistingPlayer(player, makeSocketStub(), '', true);
  assert.equal(player.disconnectedAt, null);
  assert.equal(player.graceTimer, null);
  // 더 기다려도 timer 는 발화하지 않아야 함.
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(timerFired, false);
      resolve();
    }, 50);
  });
});

test('_reattachExistingPlayer: sid 가 주어지면 sidToPlayer 매핑 갱신', () => {
  const g = new Game();
  const player = baseExistingPlayer({ socket: null, sid: 'old' });
  g.sidToPlayer.set('old', player);
  g.players.set(player.id, player);

  g._reattachExistingPlayer(player, makeSocketStub(), 'new', true);
  assert.equal(player.sid, 'new');
  assert.equal(g.sidToPlayer.get('new'), player);
});

// --- helpers ---

function makeSocketStub({ readyState = 1 } = {}) {
  const sent = [];
  const stub = {
    readyState,
    closed: false,
    closeCode: null,
    sent,
    send(payload) { sent.push(payload); },
    close(code) { stub.closed = true; stub.closeCode = code; stub.readyState = 3; },
  };
  return stub;
}

function baseExistingPlayer(overrides = {}) {
  // attachPlayer 의 reattach 분기가 만지는 필드만 채운 최소 stub. 등록 상태는
  // false 로 두어 welcome 분기로 떨어지게 — describeRoom/pushStatus 같은 무거운
  // 호출을 회피해 테스트가 가벼움.
  return {
    id: 1,
    sid: '',
    socket: null,
    registered: false,
    generating: false,
    name: '',
    spriteSvg: null,
    disconnectedAt: null,
    graceTimer: null,
    ...overrides,
  };
}
