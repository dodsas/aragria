// throttle.js — 클라 송신 minimum-interval 게이트.
//
// 가짜 시계(`now()`) + 가짜 소켓 주입으로 setTimeout 없이 시간 진행을 시뮬레이션.
// 매 테스트가 makeThrottle() 을 새로 호출해 closure lastSendAt 이 격리된다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeThrottle, MIN_SEND_INTERVAL_MS } from '../public/throttle.js';

// 헬퍼: 가짜 시계 + readyState=1 인 ok 소켓 + 송신된 raw 페이로드 spy.
function setup({ readyState = 1, sendImpl } = {}) {
  let t = 0;
  const sent = [];
  const sock = {
    readyState,
    send(raw) { (sendImpl || ((r) => sent.push(r)))(raw); },
  };
  const send = makeThrottle({ getSocket: () => sock, now: () => t });
  return {
    send,
    sent,
    sock,
    advance: (ms) => { t += ms; },
    setTime: (ms) => { t = ms; },
  };
}

test('MIN_SEND_INTERVAL_MS 가 100ms 로 노출돼 있다', () => {
  // 정책 상수의 단일 진실원 — 다른 코드/문서가 같은 값으로 매칭되는지의 닻.
  assert.equal(MIN_SEND_INTERVAL_MS, 100);
});

test('첫 송신은 무조건 통과 (lastSendAt = -Infinity 시멘틱)', () => {
  const { send, sent } = setup();
  // t=0 에서도 -Infinity 와의 차는 +Infinity 라 게이트 통과.
  assert.equal(send({ type: 'cmd', input: 'first' }), true);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]).input, 'first');
});

test('100ms 이내 연쇄 송신은 silent drop (false 반환, send 호출 안 됨)', () => {
  const { send, sent, advance } = setup();
  assert.equal(send({ a: 1 }), true);
  advance(50);
  assert.equal(send({ a: 2 }), false);
  advance(49); // t=99
  assert.equal(send({ a: 3 }), false);
  // 첫 한 건만 실제 전송.
  assert.equal(sent.length, 1);
});

test('정확히 100ms 경과 시 통과 (경계: t - lastSendAt < 100 이 false)', () => {
  const { send, sent, advance } = setup();
  assert.equal(send({ a: 1 }), true);
  advance(100); // t=100, gap=100, 조건 100 < 100 = false → 통과.
  assert.equal(send({ a: 2 }), true);
  assert.equal(sent.length, 2);
});

test('100ms 경계 직전(99ms) 은 차단, 직후(101ms) 는 통과', () => {
  const { send, advance } = setup();
  assert.equal(send({ a: 1 }), true);
  advance(99);
  assert.equal(send({ a: 2 }), false);
  advance(2); // t=101
  assert.equal(send({ a: 3 }), true);
});

test('소켓 미연결(getSocket 가 null) 이면 false, lastSendAt 갱신 안 함', () => {
  // 소켓이 곧 살아나면 인위적인 throttle 지연이 붙지 않아야 — 다음 유효 송신
  // 시점에 즉시 통과해야 한다.
  let sock = null;
  const sent = [];
  let t = 0;
  const send = makeThrottle({
    getSocket: () => sock,
    now: () => t,
  });

  assert.equal(send({ a: 1 }), false);
  // 5ms 후 소켓 부착. 「100ms 안 지났는데 차단」 이 발생하면 안 됨.
  t = 5;
  sock = { readyState: 1, send: (raw) => sent.push(raw) };
  assert.equal(send({ a: 2 }), true);
  assert.equal(sent.length, 1);
});

test('소켓 readyState !== 1 (CONNECTING/CLOSING/CLOSED) 면 false', () => {
  for (const state of [0, 2, 3]) {
    const { send, sent } = setup({ readyState: state });
    assert.equal(send({ a: 1 }), false, `readyState=${state} 인데 통과함`);
    assert.equal(sent.length, 0);
  }
});

test('sock.send 가 throw 해도 false 반환, lastSendAt 갱신 안 함', () => {
  // 네트워크 레이어 예외(예: BufferedAmount 초과)가 게이트를 영구히 잠그지 않게.
  let throwOnce = true;
  const sent = [];
  let t = 0;
  const sock = {
    readyState: 1,
    send: (raw) => {
      if (throwOnce) { throwOnce = false; throw new Error('boom'); }
      sent.push(raw);
    },
  };
  const send = makeThrottle({ getSocket: () => sock, now: () => t });

  assert.equal(send({ a: 1 }), false); // throw 흡수.
  // throw 가 lastSendAt 을 갱신했다면 다음 호출이 100ms 동안 막혔을 것.
  t = 1;
  assert.equal(send({ a: 2 }), true);
  assert.equal(sent.length, 1);
});

test('JSON.stringify 가 실패해도(circular ref) false', () => {
  const { send } = setup();
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(send(cyclic), false);
  // 후속 정상 송신은 가능 — 실패가 게이트를 잠그지 않는다.
  assert.equal(send({ ok: 1 }), true);
});

test('재연결 — getSocket 이 새 소켓 인스턴스를 돌려주면 같은 sender 가 따라간다', () => {
  // client.js 의 ws 변수가 재연결로 swap 될 때의 시나리오.
  let t = 0;
  let sock = { readyState: 1, send() {} };
  const sentA = [];
  const sentB = [];
  sock.send = (raw) => sentA.push(raw);
  const send = makeThrottle({ getSocket: () => sock, now: () => t });

  assert.equal(send({ a: 1 }), true);
  // 새 소켓으로 swap. 100ms 가 지나야 다음 송신 통과.
  sock = { readyState: 1, send: (raw) => sentB.push(raw) };
  t = 200;
  assert.equal(send({ a: 2 }), true);
  // 첫 송신은 옛 소켓, 두 번째는 새 소켓에 도달.
  assert.equal(sentA.length, 1);
  assert.equal(sentB.length, 1);
});

test('throttle 인스턴스 둘은 서로 격리 (closure 변수 분리)', () => {
  // 한 페이지에 송신 채널이 둘 이상이 될 가능성은 낮지만, 모듈 스코프 공유가
  // 아니라 closure 라는 사실을 가둬 두자.
  let t = 0;
  const sock = { readyState: 1, send() {} };
  const sendA = makeThrottle({ getSocket: () => sock, now: () => t });
  const sendB = makeThrottle({ getSocket: () => sock, now: () => t });

  assert.equal(sendA({ a: 1 }), true);
  // sendA 가 막 송신했어도 sendB 의 lastSendAt 은 -Infinity 라 즉시 통과.
  assert.equal(sendB({ b: 1 }), true);
  // sendA 는 자기 게이트가 닫혀 있어 차단.
  assert.equal(sendA({ a: 2 }), false);
});

test('100ms 간격으로 정확히 송신할 때 sustained throughput 10 Hz', () => {
  // 정책의 의도된 sustained 상한 — 서버 CMD_RATE_PER_SEC=8 보다 약간 위.
  const { send, sent, advance } = setup();
  for (let i = 0; i < 10; i++) {
    assert.equal(send({ i }), true);
    advance(100);
  }
  assert.equal(sent.length, 10);
});

test('30Hz 키 auto-repeat 시뮬레이션 — 1초 동안 10개만 통과', () => {
  // 회귀 가드의 핵심 시나리오. WASD 길게 누르기로 30번 호출이 와도 throttle 이
  // 10개로 잘라낸다(t=0, 100, 200, ..., 900 — 100/33.33 ≈ 3 호출당 1).
  const { send, sent, advance } = setup();
  let attempts = 0;
  for (let ms = 0; ms < 1000; ms += 1000 / 30) {
    attempts++;
    send({ key: 'W' });
    advance(1000 / 30);
  }
  assert.equal(attempts, 30);
  // 100ms 간격 boundary 가 33.33ms 의 정확히 3 배수마다 떨어지지는 않아 9 또는
  // 10 통과(부동소수 누적). 정책 상한 이내인지만 확인.
  assert.ok(sent.length >= 9 && sent.length <= 11, `expected ~10, got ${sent.length}`);
});
