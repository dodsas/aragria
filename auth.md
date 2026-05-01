# auth.md — 네이버 로그인 + 캐릭터 영속성

## 목적

- 사용자가 네이버 계정으로 로그인하면 캐릭터(이름·레벨·EXP·인벤토리·장비·
  현재 방·스프라이트)가 디스크에 영속된다.
- 같은 계정으로 다른 디바이스에서 로그인하면 캐릭터가 그대로 따라온다.
- 한 계정의 활성 세션은 항상 1 — 다른 디바이스에서 로그인하면 이전 디바이스의
  세션이 즉시 무효화된다(서버측 단일 sessionToken 회전).
- 로그인 정보는 사용자가 명시적으로 로그아웃하거나 다른 디바이스에서 새로
  로그인하기 전까지 유지된다.

## 구성 요소

- `server/auth.js` — Naver OAuth 2.0 어댑터. `/auth/naver/login`,
  `/auth/naver/callback`, `/auth/me`, `/auth/logout` 4 라우트.
- `server/store.js` — 단일 JSON 파일(`data/users.json`)에 모든 계정과 그
  계정에 묶인 캐릭터 스냅샷을 저장. 디바운스(1.5s) + atomic rename 으로 flush.
- `server/game.js` — `attachPlayer({auth})` 가 인증된 사용자에 대해
  `naverIdToPlayer` 맵에 키잉, 저장된 스냅샷이 있으면 hydrate, 없으면 등록 모달.
  레벨업·장착·이동·연결종료 시점에 `_persistPlayer()` 로 스냅샷을 갱신.
- `public/client.js` — 페이지 로드 시 `/auth/me` 로 인증 상태 확인,
  welcome 모달에 「네이버로 로그인」 버튼 표시 여부 결정, 설정 모달에서
  로그아웃 노출.

## 흐름

1. 사용자가 welcome 모달의 「네이버로 로그인」 클릭 → `/auth/naver/login` 으로 이동.
2. 서버가 CSRF state 쿠키(`agria_oauth_state`) 발급 + Naver authorize URL 로 302.
3. 사용자 동의 후 `/auth/naver/callback?code=&state=` 로 복귀.
4. 서버:
   - state 쿠키와 비교 → 불일치면 400.
   - `code` 로 access_token 교환 (네이버 `/oauth2.0/token`).
   - access_token 으로 프로필 조회 (`/v1/nid/me`) → `{id, nickname}`.
   - `store.loginNaverUser()` 호출 → 새 32-byte sessionToken 생성, 기존 토큰
     덮어쓰기. 캐릭터 스냅샷은 그대로 유지.
   - `agria_session` 쿠키(httpOnly, SameSite=Lax, Max-Age=30 일) 발급.
   - `/` 로 302.
5. 클라이언트 페이지 재로드 → `/auth/me` = 200, `applyAuthUi()` 가 로그인된
   상태로 UI 갱신.
6. WebSocket 업그레이드 시 `authenticateWsRequest(req)` 가 쿠키의 토큰을
   store 와 비교 → 일치하면 `auth = {naverId, nickname, sessionToken}`.
7. `Game.attachPlayer({auth})` 가 `naverIdToPlayer` 에서 살아 있는 player 를
   찾으면 takeover/grace 정책을 따르고, 없으면 `_addAuthenticatedPlayer()` 가
   저장된 캐릭터 스냅샷을 hydrate 또는 welcome 모달로 흘림.

## 다른 디바이스 로그인의 단일성

핵심 메커니즘: 한 사용자 레코드(`UserRec`)에 활성 sessionToken 은 단 1 개.
새 로그인이 발생하면 토큰을 회전하고, 이전 디바이스의 쿠키는 더 이상 store
에 없는 토큰을 들고 있게 된다.

- 이전 디바이스의 WS 가 살아 있는 동안에는 이미 attach 된 player 객체로 계속
  통신 가능. 단, 그 디바이스가 페이지를 새로고침하거나 잠깐 끊겼다 들어오면
  `authenticateWsRequest` 에서 토큰이 없는 것으로 판정 → 익명 분기 → welcome
  모달이 다시 뜬다.
- 새 디바이스가 같은 sid 가 아니라도 같은 naverId 로 attach 하면
  `naverIdToPlayer.get(auth.naverId)` 가 살아 있는 이전 player 를 발견하고
  takeover 정책에 따라 처리. 운영(`allowTakeover=false`)에서는 신규 측이
  `duplicate_pending` 모달을 띄워 사용자 결정 → `force_takeover` 시 이전
  디바이스에 `kicked_by_other` 통보 후 새 디바이스가 활성.

## 영속 시점

스토어는 디바운스(1.5s)로 flush 를 묶기 때문에, 아래 시점에 `_persistPlayer()`
를 자유롭게 호출해도 디스크 I/O 는 묶여 한 번만 발생한다.

- 등록 완료(`registerPlayer`) — 신규 캐릭터의 첫 스냅샷.
- 레벨업/EXP 획득(`_grantExp`) — 진행도 보존.
- 장비 변경(`equip`/`unequip`).
- 직업 전환(`changeClass`).
- 방 이동(`_doMove`).
- 연결 종료(`detachPlayer`) — 단일 디바이스 새로고침/이탈.
- grace 만료(`_finalizePlayer`) — 정말로 떠난 시점의 마지막 보장.
- 프로세스 종료(SIGINT/SIGTERM, `bindShutdownFlush`).

## env

- `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` — 네이버 개발자 센터에서 발급.
  미설정 시 `/env.js` 의 `AGRIA_NAVER_LOGIN=false` 가 되어 클라가 로그인
  버튼을 숨기고, `/auth/naver/login` 호출 시 503 반환.
- `NAVER_CALLBACK_URL` — `${ORIGIN}/auth/naver/callback`. 미설정 시 요청의
  `host`/`x-forwarded-proto` 헤더로 자동 합성(개발용). 운영은 풀 URL 명시 권장.
- `SESSION_COOKIE_SECURE` — `'true'` 면 `Secure` 플래그 강제. https 종단
  뒤(Render 등)에서 활성.

## 데이터 파일

- 위치: `data/users.json` (gitignored).
- 1k 동시 접속 목표 안에서 메모리에 통째로 들고 있어도 안전한 크기.
- 사용자 수가 늘어 단일 파일이 부담스러워지면 user → file shard 로 전환.
- Render 운영 환경은 `render.yaml` 의 `disk:` 마운트(영속 디스크)로 보존.

## 새 OAuth 제공자 추가

1. `server/auth.js` 와 동일한 구조의 어댑터 모듈 추가(예: `server/auth_kakao.js`).
2. 콜백에서 `store.loginNaverUser` 와 같은 방식으로 별도 키스페이스 사용
   (예: `byKakaoId`) — 또는 store 를 `byProviderId[provider:id]` 단일 맵으로
   리팩터링.
3. `server/index.js` 에 라우트 추가 + `authenticateWsRequest` 에서 매칭하는
   토큰 검색 로직 확장.
