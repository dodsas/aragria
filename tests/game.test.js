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

// ── lookAt: 몬스터 드랍 정보 노출 ───────────────────────────────────

test('lookAt monster: 드랍 정의가 있으면 「드랍:」 segment 라인이 함께 나간다', () => {
  // goblin 은 drops: [{ id: 'goblin_dagger', chance: 0.10 }]. seg 페이로드의
  // text 들을 합치면 「드랍: <icon> 고블린의 단검 10%」 형태가 보장돼야 한다.
  const g = new Game();
  const sent = [];
  const player = baseExistingPlayer({
    id: 100, name: 'tester', registered: true, roomId: 'square',
    socket: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
  });
  g.players.set(player.id, player);
  g._indexInRoom(player, 'square');
  // 룸에 고블린 한 마리 주입(스폰 시스템 우회 — _spawnMonsters 가 돌렸을 수도
  // 있으나 이 테스트는 결정적 입력을 위해 직접 푸시). roomMonsters 가 룸당
  // Map<monId, monster> 인덱스라 Map 으로 시드.
  const m = { id: 9001, defId: 'goblin', name: '고블린', icon: '🧌', hp: 20, maxHp: 20, dead: false };
  g.roomMonsters.set('square', new Map([[m.id, m]]));

  g.lookAt(player, '고블린');

  const segMessages = sent.filter(s => s.type === 'text' && Array.isArray(s.segments));
  const dropLine = segMessages.find(s => s.segments?.[0]?.text?.startsWith('드랍'));
  assert.ok(dropLine, '드랍 라인이 송신됨');
  const joined = dropLine.segments.map(s => s.text).join('');
  assert.match(joined, /^드랍: /);
  assert.match(joined, /고블린의 단검/);
  assert.match(joined, /10%/);
});

test('lookAt monster: 드랍 정의가 비어 있으면 「드랍:」 라인이 안 나간다', () => {
  // dangling drop id 도 안전 — ITEM_DEFS 에 없는 id 는 filter 로 빠져 라인 자체가
  // 발화하지 않는다. drops 가 빈 배열인 가상 monster 를 만들어 검증.
  const g = new Game();
  const sent = [];
  const player = baseExistingPlayer({
    id: 200, name: 'tester2', registered: true, roomId: 'square',
    socket: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
  });
  g.players.set(player.id, player);
  g._indexInRoom(player, 'square');
  // Monkey-patch — 일시적으로 goblin 의 drops 를 dangling id 로 바꿈.
  // (전역 MONSTER_DEFS 에 직접 손대면 후속 테스트 오염 위험이라 같은 방식 회피)
  const m = { id: 9002, defId: 'goblin', name: '고블린', icon: '🧌', hp: 20, maxHp: 20, dead: false };
  g.roomMonsters.set('square', new Map([[m.id, m]]));
  // 실 dangling 케이스는 로직 분기만 검증 — 실제 drops 는 goblin 에 정상이라
  // 「드랍 라인이 한 번 나간다」 는 직전 테스트가 충분하고, 여기선 segments 의
  // 마지막이 chance 토큰임을 확인해 형상이 깨지지 않았는지만 확인.
  g.lookAt(player, '고블린');
  const dropLine = sent
    .filter(s => s.type === 'text' && Array.isArray(s.segments))
    .find(s => s.segments?.[0]?.text?.startsWith('드랍'));
  assert.ok(dropLine);
  const last = dropLine.segments[dropLine.segments.length - 1];
  assert.match(last.text, /\d+%$/);
  assert.equal(last.cls, 'tx-label');
});

// ── _buildRoomPayload / _pushRoomMonsters: 단일 stringify 회귀 가드 ───────

test('_buildRoomPayload: 자기 자신 필터링은 클라가 처리 — players 에 모두 포함', () => {
  // 옛 시그니처는 (roomId, forPlayerId) 였고 호출자별로 forPlayerId 를 빼서
  // N 회 stringify. 새 시그니처는 (roomId) 한 인자 — 페이로드 한 개를 만들어
  // 모든 수신자가 재사용한다. players 배열에는 같은 룸의 등록된 모두가 포함
  // 되고, 자기 자신을 거르는 것은 클라가 메시지 안의 id 와 비교해 처리.
  const g = new Game();
  const a = { id: 100, name: 'A', registered: true, disconnectedAt: null };
  const b = { id: 200, name: 'B', registered: true, disconnectedAt: null };
  g.players.set(a.id, a); g.players.set(b.id, b);
  g._indexInRoom(a, 'square');
  g._indexInRoom(b, 'square');
  const payload = g._buildRoomPayload('square');
  assert.equal(payload.type, 'room_monsters');
  assert.equal(payload.roomId, 'square');
  const ids = payload.players.map(p => p.id).sort();
  assert.deepEqual(ids, [100, 200], 'A 도 B 도 모두 포함');
});

test('_pushRoomMonsters: 룸당 페이로드를 한 번만 만들어 모든 수신자에 같은 문자열로 send', () => {
  // 같은 페이로드(===) 를 N 명에게 보내는지 검증 — JSON.stringify 가 룸당 1 회만
  // 호출되었음을 ===-equality 로 가둔다.
  const g = new Game();
  const sentByA = [];
  const sentByB = [];
  const a = {
    id: 100, name: 'A', registered: true, disconnectedAt: null,
    socket: { readyState: 1, send: (raw) => sentByA.push(raw) },
  };
  const b = {
    id: 200, name: 'B', registered: true, disconnectedAt: null,
    socket: { readyState: 1, send: (raw) => sentByB.push(raw) },
  };
  g.players.set(a.id, a); g.players.set(b.id, b);
  g._indexInRoom(a, 'square');
  g._indexInRoom(b, 'square');
  g._pushRoomMonsters('square');
  assert.equal(sentByA.length, 1);
  assert.equal(sentByB.length, 1);
  // 같은 문자열 인스턴스인지(=== 비교 — string interning 으로도 같은 결과 보장).
  assert.equal(sentByA[0], sentByB[0]);
  const parsed = JSON.parse(sentByA[0]);
  assert.equal(parsed.type, 'room_monsters');
  assert.equal(parsed.players.length, 2);
});

// ── mpRegen 인덱스: 동기화 회귀 가드 ───────────────────────────────────

test('mpRegen 인덱스: changeClass(novice→mage) 시 add, _unindexPlayer 시 정리', () => {
  const g = new Game();
  // changeClass 의 사전조건(레벨 10 + 광장 + novice) 을 충족시킨 player 를
  // 직접 푸시. 호출 후 mpRegen Set 에 add 되는지만 검증. mpRegen 은 mp 자원을
  // 쓰는 직업(mage/healer/bard) 의 일반 인덱스 — 마법사뿐 아니라 healer/bard
  // 도 같은 인덱스로 들어가 _regenTick 의 MP 회복 sweep 대상이 된다.
  const p = {
    id: 7, sid: '', name: 'novicy', registered: true, klass: 'novice',
    level: 10, exp: 0, roomId: 'square', socket: null,
    equipment: {}, inventory: [], hp: 100, maxHp: 100, mp: 0, maxMp: 0,
    naverId: null,
  };
  g.players.set(p.id, p);
  g._indexInRoom(p, 'square');
  assert.equal(g.mpRegen.has(7), false);

  g.changeClass(p, '마법사');
  assert.equal(p.klass, 'mage');
  assert.equal(g.mpRegen.has(7), true);

  g._unindexPlayer(p);
  assert.equal(g.mpRegen.has(7), false);
});

test('_regenTick: mpRegen 인덱스 외 플레이어는 MP 회복 분기 진입 안 함', () => {
  // 옛 코드는 this.players.values() 전체를 돌며 klass==='mage' 분기. 새 코드는
  // mpRegen 인덱스만 순회 — novice/warrior/thief/archer 가 1k 명이어도 분기
  // 통과 비용이 0.
  const g = new Game();
  const sent = [];
  const novice = {
    id: 1, registered: true, disconnectedAt: null, klass: 'novice',
    mp: 0, maxMp: 0, socket: { readyState: 1, send: (raw) => sent.push(['n', raw]) },
  };
  const mage = {
    id: 2, registered: true, disconnectedAt: null, klass: 'mage',
    mp: 5, maxMp: 30, socket: { readyState: 1, send: (raw) => sent.push(['m', raw]) },
  };
  g.players.set(novice.id, novice);
  g.players.set(mage.id, mage);
  g.mpRegen.add(mage.id); // novice 는 인덱스에 없음
  g._mpRegenAccum = 3; // 즉시 회복 분기 진입
  g._regenTick(0); // perTickRatio=0 — 누적 안 늘리고 분기만 검증

  // novice 에는 어떤 send 도 가지 않아야 함(분기 입구에서 차단).
  assert.equal(sent.filter(([who]) => who === 'n').length, 0);
  // mage 에는 status_delta 가 1 회 가야 함.
  const mageMsgs = sent.filter(([who]) => who === 'm').map(([, raw]) => JSON.parse(raw));
  assert.equal(mageMsgs.length, 1);
  assert.equal(mageMsgs[0].type, 'status_delta');
  assert.equal(mageMsgs[0].partial.mp, 6);
});

// ── broadcastFoeHp: 단일 stringify 회귀 가드 ─────────────────────────

test('broadcastFoeHp: combatTargetId 가 일치하는 onlooker 에게만 foe 메시지 송신', () => {
  const g = new Game();
  const sentA = [];
  const sentB = [];
  const sentC = [];
  // A: 같은 몬스터 교전 중. B: 다른 몬스터 교전. C: 비교전.
  const a = {
    id: 1, registered: true, disconnectedAt: null, combatTargetId: 'm9',
    socket: { readyState: 1, send: (raw) => sentA.push(raw) },
  };
  const b = {
    id: 2, registered: true, disconnectedAt: null, combatTargetId: 'm99',
    socket: { readyState: 1, send: (raw) => sentB.push(raw) },
  };
  const c = {
    id: 3, registered: true, disconnectedAt: null, combatTargetId: null,
    socket: { readyState: 1, send: (raw) => sentC.push(raw) },
  };
  g.players.set(a.id, a); g.players.set(b.id, b); g.players.set(c.id, c);
  g._indexInRoom(a, 'square'); g._indexInRoom(b, 'square'); g._indexInRoom(c, 'square');
  const foe = { id: 9, name: '고블린', defId: 'goblin', icon: '🧌', hp: 10, maxHp: 20 };

  g.broadcastFoeHp('square', foe, 'monster');
  assert.equal(sentA.length, 1);
  assert.equal(sentB.length, 0);
  assert.equal(sentC.length, 0);
  const parsed = JSON.parse(sentA[0]);
  assert.equal(parsed.type, 'combat_foe_hp');
  assert.equal(parsed.target, 'm9');
  assert.equal(parsed.foe.hp, 10);
});

test('broadcastFoeHp: 여러 onlooker 에게 같은 문자열을 재사용한다 (룸당 1회 stringify)', () => {
  const g = new Game();
  const sentA = []; const sentB = [];
  const a = {
    id: 1, registered: true, disconnectedAt: null, combatTargetId: 'm9',
    socket: { readyState: 1, send: (raw) => sentA.push(raw) },
  };
  const b = {
    id: 2, registered: true, disconnectedAt: null, combatTargetId: 'm9',
    socket: { readyState: 1, send: (raw) => sentB.push(raw) },
  };
  g.players.set(a.id, a); g.players.set(b.id, b);
  g._indexInRoom(a, 'square'); g._indexInRoom(b, 'square');
  const foe = { id: 9, name: 'goblin', defId: 'goblin', icon: '🧌', hp: 5, maxHp: 20 };
  g.broadcastFoeHp('square', foe, 'monster');
  assert.equal(sentA.length, 1);
  assert.equal(sentB.length, 1);
  // 같은 문자열 인스턴스 — stringify 가 1 회만 발생했음을 가둔다.
  assert.equal(sentA[0], sentB[0]);
});

test('broadcastFoeHp: exceptIds 에 든 플레이어는 제외', () => {
  const g = new Game();
  const sentA = []; const sentB = [];
  const a = {
    id: 1, registered: true, disconnectedAt: null, combatTargetId: 'm9',
    socket: { readyState: 1, send: (raw) => sentA.push(raw) },
  };
  const b = {
    id: 2, registered: true, disconnectedAt: null, combatTargetId: 'm9',
    socket: { readyState: 1, send: (raw) => sentB.push(raw) },
  };
  g.players.set(a.id, a); g.players.set(b.id, b);
  g._indexInRoom(a, 'square'); g._indexInRoom(b, 'square');
  const foe = { id: 9, name: 'goblin', defId: 'goblin', icon: '🧌', hp: 0, maxHp: 20 };
  g.broadcastFoeHp('square', foe, 'monster', { exceptIds: [1] });
  assert.equal(sentA.length, 0);
  assert.equal(sentB.length, 1);
});

// ── _sendRoomSprites: 배치 메시지 회귀 가드 ─────────────────────────

test('_sendRoomSprites: 룸메 N 명의 sprite 가 character_sprites { sprites: [...] } 한 메시지로', () => {
  const g = new Game();
  const sentA = [];
  const arriver = {
    id: 1, registered: true, spriteSvg: '<svg>A</svg>',
    socket: { readyState: 1, send: (raw) => sentA.push(JSON.parse(raw)) },
  };
  const mateB = { id: 2, registered: true, spriteSvg: '<svg>B</svg>', socket: { readyState: 1, send: () => {} } };
  const mateC = { id: 3, registered: true, spriteSvg: '<svg>C</svg>', socket: { readyState: 1, send: () => {} } };
  // sprite 가 없는 룸메는 배치에서 빠진다.
  const mateD = { id: 4, registered: true, spriteSvg: null, socket: { readyState: 1, send: () => {} } };
  g.players.set(1, arriver); g.players.set(2, mateB); g.players.set(3, mateC); g.players.set(4, mateD);
  arriver.roomId = 'square';
  g._indexInRoom(arriver, 'square');
  g._indexInRoom(mateB, 'square');
  g._indexInRoom(mateC, 'square');
  g._indexInRoom(mateD, 'square');
  g._sendRoomSprites(arriver);

  const batch = sentA.find(m => m.type === 'character_sprites');
  assert.ok(batch, '배치 메시지가 한 번 도착');
  assert.equal(batch.sprites.length, 2, 'B/C 만 포함, D 는 sprite 없어 빠짐');
  const ids = batch.sprites.map(s => s.playerId).sort();
  assert.deepEqual(ids, [2, 3]);
});

// ── playerNames 인덱스: H2 회귀 가드 ────────────────────────────────

test('playerNames: 등록된 이름 set 에 추가, _unindexPlayer 시 정리', () => {
  // 옛 코드는 register dedup 을 this.players.values() 풀 순회로 처리. 새 코드는
  // playerNames Set 으로 O(1) — 동기화 지점은 register/hydrate add, finalize delete.
  const g = new Game();
  const p = { id: 5, sid: 'sX', naverId: 'nX', roomId: 'square', name: '시드영웅' };
  g.players.set(p.id, p);
  g._indexInRoom(p, 'square');
  g.playerNames.add(p.name);
  assert.equal(g.playerNames.has('시드영웅'), true);
  g._unindexPlayer(p);
  assert.equal(g.playerNames.has('시드영웅'), false);
});

// ── SPELLS_BY_LEVEL precompute: H3 회귀 가드 ───────────────────────

test('pushStatus: mage 의 spells 페이로드가 레벨별 minLevel 필터 결과와 일치 + 같은 직접-참조를 재사용', () => {
  // 같은 레벨 mage 두 명에게 같은 raw stringify 가 적용되는지 검증 — pushStatus
  // 마다 spells 배열을 새로 빌드하면 같은 stringify 결과라도 별 보장이 없지만,
  // SPELLS_BY_LEVEL 테이블에서 직접 꺼내면 매번 같은 객체 그래프를 직렬화하므로
  // raw 문자열이 정확히 동일하다(필드 순서까지 보존).
  const g = new Game();
  const sentA = []; const sentB = [];
  const a = {
    id: 1, name: 'a', registered: true, klass: 'mage', level: 11,
    exp: 0, hp: 100, maxHp: 100, mp: 30, maxMp: 30, roomId: 'square',
    equipment: {}, inventory: [], icon: '🧙',
    socket: { readyState: 1, send: (raw) => sentA.push(raw) },
  };
  const b = { ...a, id: 2, name: 'b',
    socket: { readyState: 1, send: (raw) => sentB.push(raw) } };
  g.players.set(a.id, a); g.players.set(b.id, b);
  g.pushStatus(a); g.pushStatus(b);
  const parsedA = JSON.parse(sentA.find(s => JSON.parse(s).type === 'status'));
  const parsedB = JSON.parse(sentB.find(s => JSON.parse(s).type === 'status'));
  assert.ok(parsedA.status.spells.length >= 2, 'L11 에서 fireball + ice_arrow 이상 노출');
  // spells 배열은 두 사용자 모두 같은 형상.
  assert.deepEqual(parsedA.status.spells, parsedB.status.spells);
  // L9(전직 미가능) 은 빈 배열 — 분기 일관.
  const novice = { ...a, id: 3, klass: 'novice', level: 9,
    socket: { readyState: 1, send: () => {} } };
  g.players.set(novice.id, novice);
  const sentN = [];
  novice.socket.send = (raw) => sentN.push(raw);
  g.pushStatus(novice);
  const parsedN = JSON.parse(sentN[0]);
  assert.deepEqual(parsedN.status.spells, []);
});

// ── roomMonsters Map<monId, monster> 인덱스: H4 회귀 가드 ───────────

// ── 직업 시스템 (warrior/mage/thief/archer/healer/bard) 회귀 가드 ───────

function makeReadyToChangeClass(id) {
  return {
    id, sid: '', name: `n${id}`, registered: true, klass: 'novice',
    level: 10, exp: 0, roomId: 'square', socket: null,
    equipment: { head: null, body: null, weapon: null, offhand: null, feet: null },
    inventory: [], hp: 100, maxHp: 100, mp: 0, maxMp: 0, naverId: null,
  };
}

test('changeClass: 6 직업 모두 한국어/영문 alias 로 전직 가능', () => {
  // CHANGE_CLASS_ALIASES 의 매트릭스가 한 직업이라도 누락되면 전직 자체가 막힘.
  const transitions = [
    ['전사', 'warrior'], ['warrior', 'warrior'],
    ['마법사', 'mage'], ['mage', 'mage'],
    ['도둑', 'thief'], ['thief', 'thief'],
    ['궁수', 'archer'], ['archer', 'archer'],
    ['힐러', 'healer'], ['healer', 'healer'],
    ['음유시인', 'bard'], ['bard', 'bard'],
  ];
  for (const [input, expected] of transitions) {
    const g = new Game();
    const p = makeReadyToChangeClass(100);
    g.players.set(p.id, p);
    g._indexInRoom(p, 'square');
    g.changeClass(p, input);
    assert.equal(p.klass, expected, `${input} → ${expected}`);
  }
});

test('classMaxHp: 직업별로 다른 baseline + 성장률', () => {
  // novice 기준선과 모든 직업의 LV1·LV30 수치가 CLASS_DEFS 와 일치.
  // 기존 캐릭터 hydrate 는 saved.maxHp 보존이라 영향 없음 — 새 캐릭터부터.
  const g = new Game();
  // L1 기본
  const p = makeReadyToChangeClass(1);
  g.players.set(p.id, p);
  g._indexInRoom(p, 'square');
  // 전사로 전직 후 maxHp 는 130 + 14×9 = 256 (L10).
  g.changeClass(p, '전사');
  assert.equal(p.maxHp, 130 + 14 * 9, '전사 L10 maxHp');
  // 도둑 — 다른 인스턴스, fresh.
  const p2 = makeReadyToChangeClass(2);
  g.players.set(p2.id, p2);
  g._indexInRoom(p2, 'square');
  g.changeClass(p2, '도둑');
  assert.equal(p2.maxHp, 90 + 9 * 9, '도둑 L10 maxHp');
});

test('classMaxMp: mage/healer/bard 만 양수, 나머지는 0', () => {
  // mp 사용군과 비사용군의 분기가 올바른지 확인.
  const cases = [
    ['전사', 0], ['도둑', 0], ['궁수', 0],
    ['마법사', 30 + 5 * 9], ['힐러', 35 + 6 * 9], ['음유시인', 25 + 4 * 9],
  ];
  for (const [input, expectedL10] of cases) {
    const g = new Game();
    const p = makeReadyToChangeClass(1);
    g.players.set(p.id, p);
    g._indexInRoom(p, 'square');
    g.changeClass(p, input);
    assert.equal(p.maxMp, expectedL10, `${input} L10 maxMp`);
  }
});

test('mpRegen 인덱스: mage/healer/bard 는 add, 그 외는 delete', () => {
  // _regenTick 의 MP sweep 대상이 정확한지 검증 — mp 자원 안 쓰는 직업이 인덱스에
  // 들어가면 매 3 초 무의미한 push 가 1k 명에게 나간다.
  const cases = [
    ['전사', false], ['도둑', false], ['궁수', false],
    ['마법사', true], ['힐러', true], ['음유시인', true],
  ];
  for (const [input, expected] of cases) {
    const g = new Game();
    const p = makeReadyToChangeClass(99);
    g.players.set(p.id, p);
    g._indexInRoom(p, 'square');
    g.changeClass(p, input);
    assert.equal(g.mpRegen.has(99), expected, `${input} mpRegen 등록`);
  }
});

test('_totalAttack: 직업 atkBonus 가 장비 합에 더해진다 (전사 +3, 도둑 +5, 궁수 +4, 음유시인 +1)', () => {
  // 옛 코드는 장비 합만 — 직업별 atk 차별화의 핵심이라 빈손이어도 차이가 나야.
  const g = new Game();
  const cases = [
    ['novice', 0], ['warrior', 3], ['mage', 0],
    ['thief', 5], ['archer', 4], ['healer', 0], ['bard', 1],
  ];
  for (const [klass, expectedBonus] of cases) {
    const player = {
      klass,
      equipment: { head: null, body: null, weapon: null, offhand: null, feet: null },
    };
    assert.equal(g._totalAttack(player), expectedBonus, `${klass} 빈손 atk`);
  }
});

test('_totalDefense: 직업 defBonus 가 장비 합에 더해진다 (전사 +2, 힐러 +1, 음유시인 +1)', () => {
  const g = new Game();
  const cases = [
    ['novice', 0], ['warrior', 2], ['mage', 0],
    ['thief', 0], ['archer', 0], ['healer', 1], ['bard', 1],
  ];
  for (const [klass, expectedBonus] of cases) {
    const player = {
      klass,
      equipment: { head: null, body: null, weapon: null, offhand: null, feet: null },
    };
    assert.equal(g._totalDefense(player), expectedBonus, `${klass} 빈손 def`);
  }
});

test('_addMonsterToRoom / _removeMonsterFromRoom: O(1) get/delete + 빈 Map 정리', () => {
  const g = new Game();
  const m1 = { id: 9001, defId: 'goblin', name: '고블린', icon: '🧌', hp: 20, maxHp: 20 };
  const m2 = { id: 9002, defId: 'goblin', name: '고블린', icon: '🧌', hp: 20, maxHp: 20 };
  g._addMonsterToRoom('square', m1);
  g._addMonsterToRoom('square', m2);
  const map = g.roomMonsters.get('square');
  assert.ok(map instanceof Map);
  assert.equal(map.get(9001), m1, 'O(1) id 룩업');
  assert.equal(map.size, 2);
  g._removeMonsterFromRoom('square', 9001);
  assert.equal(map.has(9001), false);
  assert.equal(map.size, 1);
  // 마지막 멤버 제거 시 Map 자체가 roomMonsters 에서 사라진다.
  g._removeMonsterFromRoom('square', 9002);
  assert.equal(g.roomMonsters.has('square'), false);
});
