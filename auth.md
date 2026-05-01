# auth.md — 네이버 로그인 + 캐릭터 영속성

> 영속 백엔드는 **Turso(libsql) embedded replica**. 로컬 SQLite 가
> primary 와 sync 되어 hot path 는 로컬, 쓰기는 디바운스 batch.
> 자세한 내용은 「데이터 영속」 절.


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
- `server/store.js` — Turso(libsql) embedded replica 위에 단일 `users` 테이블.
  로컬 SQLite(`data/local.db`) 가 primary 와 sync 돼 hot path 는 로컬 디스크
  액세스(< 1ms), 쓰기는 디바운스(1.5s) 묶음 batch UPSERT 로 primary 로 forward.
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
- `TURSO_DATABASE_URL` — Turso DB 의 libsql 엔드포인트
  (예: `libsql://agria-<owner>.turso.io`). 미설정이면 store 가 standalone
  로컬 SQLite 로 떨어져 운영에선 영속성이 사라지므로 반드시 설정.
- `TURSO_AUTH_TOKEN` — `turso db tokens create <db>` 로 발급한 토큰.

## 데이터 영속

- **백엔드**: Turso/libsql embedded replica.
  - 로컬 파일(`data/local.db`, gitignored) — 모든 읽기는 여기서 끝남(< 1ms).
  - 원격 primary — 모든 쓰기가 forward 되어 영속화. 다른 인스턴스/리전이
    읽을 때도 같은 primary 에서 sync.
- **테이블**: `users(naver_id PK, provider, nickname, session_token,
  session_rotated_at, character_json, created_at, updated_at)` 한 개.
  `character_json` 은 캐릭터 스냅샷을 JSON 으로 보관 — 게임 형상이 자주
  바뀌므로 컬럼으로 펼치지 않고 JSON 으로.
- **부팅**: `initStore()` 가 createClient → `client.sync()` 로 primary 의
  최신 상태를 로컬 replica 로 끌어옴. Render 처럼 fs 가 ephemeral 이라 매
  부팅마다 `local.db` 가 새로 만들어져도 1회 sync 로 모든 데이터 즉시 복구.
- **마이그레이션**: 옛 JSON 기반 영속(`data/users.json`)이 디스크에 남아
  있고 SQLite 가 비어 있으면 부팅 시 1 회 자동으로 import. 한 번 import
  하면 SQLite 가 진실원이 되며 JSON 은 더 이상 읽지 않는다.
- **쓰기 디바운스**: `_persistPlayer` / `loginNaverUser` / `clearSessionToken`
  / `saveCharacterFor` 호출은 in-memory state 만 즉시 갱신하고 dirty 사용자
  id 를 `Set` 에 모은다. 1.5s 후 timer 발화 시 모든 dirty 사용자에 대해 한
  번의 `client.batch([UPSERT...])` 로 묶어 보낸다 — 같은 사용자에 대한 N 번
  의 호출은 1 번의 round-trip 으로 압축.
- **Naver 콜백 / 로그아웃 / SIGTERM** 직후엔 `flushNow()` 로 즉시 동기 flush
  해서 「토큰 회전이 디스크에 닿기 전에 다른 디바이스가 옛 토큰을 사용하는」
  race 를 막는다.

## 새 OAuth 제공자 추가

1. `server/auth.js` 와 동일한 구조의 어댑터 모듈 추가(예: `server/auth_kakao.js`).
2. 콜백에서 `store.loginNaverUser` 와 같은 방식으로 별도 키스페이스 사용
   (예: `byKakaoId`) — 또는 store 를 `byProviderId[provider:id]` 단일 맵으로
   리팩터링.
3. `server/index.js` 에 라우트 추가 + `authenticateWsRequest` 에서 매칭하는
   토큰 검색 로직 확장.
