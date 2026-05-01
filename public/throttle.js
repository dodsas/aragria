// 클라 → 서버 송신 minimum-interval 게이트.
//
// 같은 모듈을 브라우저(client.js 가 import) 와 Node 테스트(`tests/throttle.test.js`)
// 양쪽에서 쓰기 위해 closure factory 로 만든다. 의존성은 두 가지:
//   - getSocket(): 매 호출마다 현재 WebSocket 핸들을 돌려준다 — client.js 의
//     ws 변수가 재연결로 바뀌어도 같은 sender 가 새 소켓을 본다.
//   - now(): monotonic clock. 기본값은 performance.now(); 테스트에선 가짜 시계
//     주입으로 setTimeout 없이 시간 진행을 시뮬레이션.
//
// 정책:
//   1) 마지막 성공 송신 시각으로부터 MIN_SEND_INTERVAL_MS 이내면 silent drop.
//   2) 소켓 없음 / readyState !== 1 이면 false (lastSendAt 갱신 안 함 — 다음
//      유효 송신이 인위적으로 지연되지 않도록).
//   3) JSON.stringify / send 가 throw 하면 false (역시 lastSendAt 안 갱신).
//   4) 성공 시에만 lastSendAt 갱신.
//
// 모듈 스코프 lastSendAt 가 아니라 closure 변수라 makeThrottle() 호출당 별개
// 인스턴스 — 테스트 간 격리가 자연스럽다.

export const MIN_SEND_INTERVAL_MS = 100;

export function makeThrottle({ getSocket, now = () => performance.now() }) {
  let lastSendAt = -Infinity;
  return function send(obj) {
    const t = now();
    if (t - lastSendAt < MIN_SEND_INTERVAL_MS) return false;
    const sock = getSocket();
    if (!(sock && sock.readyState === 1)) return false;
    try {
      sock.send(JSON.stringify(obj));
      lastSendAt = t;
      return true;
    } catch { return false; }
  };
}
