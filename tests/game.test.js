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

// ── roomMembers 인덱스 (P1.1 최적화 회귀 가드) ─────────────────────

test('roomMembers: _indexInRoom 이 같은 id 를 두 번 add 해도 idempotent', () => {
  const g = new Game();
  const p = { id: 42 };
  g._indexInRoom(p, 'square');
  g._indexInRoom(p, 'square');
  const set = g.roomMembers.get('square');
  assert.ok(set, 'set 존재');
  assert.equal(set.size, 1);
  assert.ok(set.has(42));
});

test('roomMembers: _unindexFromRoom 이 마지막 멤버 제거 시 Set 자체를 정리', () => {
  // Set 잔존이 누적되면 빈 룸 키가 남아 메모리 leak. _roomPlayers 는 빈 set 도
  // 처리하지만 정리해 두는 것이 더 정직.
  const g = new Game();
  const p = { id: 7 };
  g._indexInRoom(p, 'forest_1');
  g._unindexFromRoom(p, 'forest_1');
  assert.equal(g.roomMembers.has('forest_1'), false);
});

test('_roomPlayers: 룸 멤버 player 객체만 yield, 다른 룸은 노출 안 됨', () => {
  const g = new Game();
  const a = { id: 1 };
  const b = { id: 2 };
  const c = { id: 3 };
  g.players.set(1, a); g.players.set(2, b); g.players.set(3, c);
  g._indexInRoom(a, 'square');
  g._indexInRoom(b, 'square');
  g._indexInRoom(c, 'forest_1');

  const sq = [...g._roomPlayers('square')].map(p => p.id).sort();
  assert.deepEqual(sq, [1, 2]);
  const fr = [...g._roomPlayers('forest_1')].map(p => p.id);
  assert.deepEqual(fr, [3]);
  // 미존재 룸은 빈 iteration.
  assert.deepEqual([...g._roomPlayers('nowhere')], []);
});

test('_roomPlayers: roomMembers 의 id 가 this.players 에서 사라졌어도 안전 (yield skip)', () => {
  // 정리 누락 회귀에 대한 방어 — _finalizePlayer 의 Map.delete 와
  // _unindexFromRoom 사이에 race 가 생겨도 broadcastRoom 이 폭주하지 않게.
  const g = new Game();
  g.roomMembers.set('square', new Set([99]));
  // players 에는 등록 안 됨. _roomPlayers 는 그저 skip.
  assert.deepEqual([...g._roomPlayers('square')], []);
});

test('_unindexPlayer: roomMembers 까지 동시에 제거', () => {
  const g = new Game();
  const p = { id: 5, sid: 'sX', naverId: 'nX', roomId: 'square' };
  g.sidToPlayer.set('sX', p);
  g.naverIdToPlayer.set('nX', p);
  g._indexInRoom(p, 'square');
  g._unindexPlayer(p);
  assert.equal(g.sidToPlayer.has('sX'), false);
  assert.equal(g.naverIdToPlayer.has('nX'), false);
  assert.equal(g.roomMembers.has('square'), false);
});

// ── pushStatusDelta (P1.3 최적화 회귀 가드) ───────────────────────

test('pushStatusDelta: status_delta 메시지로 partial 만 송신', () => {
  const g = new Game();
  const sent = [];
  const player = { socket: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } };
  g.pushStatusDelta(player, { mp: 17 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'status_delta');
  assert.deepEqual(sent[0].partial, { mp: 17 });
});

test('pushStatusDelta: partial 이 falsy 면 no-op', () => {
  const g = new Game();
  const sent = [];
  const player = { socket: { readyState: 1, send: (raw) => sent.push(raw) } };
  g.pushStatusDelta(player, null);
  g.pushStatusDelta(player, undefined);
  g.pushStatusDelta(player, 'not an object');
  assert.equal(sent.length, 0);
});
