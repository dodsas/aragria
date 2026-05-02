# Command — 명령 입력 정책

이 문서는 클라이언트에서 들어오는 메시지에 대해 서버가 적용하는 모든 입력
방어 계층(rate limit, 길이 캡, 쿨다운, 큐잉)을 정리한다. 게임 로직은
`server/game.js`, 튜너블 값은 `server/config.js` 에 있다.

## 권한 모델

- **서버가 단일 권한이다.** 모든 입력 제한은 서버에서 강제한다. 클라이언트는
  UX 목적(쿨다운 표시 등)으로만 보조 제한을 둘 수 있다.
- 클라이언트가 보낸 타임스탬프, 카운터, 쿨다운 상태는 **신뢰하지 않는다**.
  서버는 자체 시계(`Date.now()`)와 플레이어별 상태만으로 판정한다.
- 따라서 클라이언트 코드 변조(개발자 도구, 패치된 빌드, 직접 WebSocket 호출)
  로 제한을 우회할 수 없다.

## 방어 계층 (바깥 → 안쪽)

요청 한 건이 통과하려면 아래 5 계층을 순서대로 모두 통과해야 한다. 한
계층이라도 차단하면 그 시점에 거부되거나 큐잉된다. 추가로 와이어보다 더
바깥쪽에 **클라 자체 송신 게이트**(아래 0 계층)가 있어 키보드 auto-repeat 등의
프레임 단위 flood 가 서버 토큰 버킷에 도달하기 전에 잘려 나간다 — 어디까지나
대역 절약과 echo 정합성을 위한 보조 게이트이며, 클라 코드를 우회한 직접 WS
연결은 여전히 1~5 계층이 모두 권위로 막는다.

### 0. 클라 송신 최소 간격 (`MIN_SEND_INTERVAL_MS = 100`, `public/client.js`)

`sendWS()` 가 마지막 송신 시각(`lastSendAt`, 모듈 스코프) 으로부터 100ms 이내
호출되면 silent drop. `sendCmd()` 와 `sendCmdEcho()` 모두 결국 `sendWS()` 를
거치므로 어떤 입구(키 입력 / d-pad / 액션 패드 / sidebar 버튼 / `register` /
`force_takeover`) 든 동일하게 게이팅된다. 시각은 `performance.now()` — NTP 보정
등으로 시스템 시계가 뒤로 점프해도 게이트가 영구 차단되지 않는 monotonic clock.

`sendCmdEcho(input, echoLabel = input)` 는 송신 성공 시에만 `> <echoLabel>`
로그 라인을 추가해 「로그엔 명령이 보이는데 서버엔 안 도착한 유령 명령」 을
차단한다. `echoLabel` 미지정 시 `input` 을 그대로 사용 — `use ${id}` 같은
영문 명령이 그대로 표시될 때는 한 인자만 넘기면 끝.

`lastSendAt` 은 재연결로 `ws` 가 새로 만들어져도 reset 되지 않아 reconnect 직후
burst 우회도 막힌다. 첫 송신 통과를 위해 `-Infinity` 로 초기화.

상한 100ms = 10/s 는 5 계층의 `CMD_RATE_PER_SEC=8` 보다 약간 더 관대하지만,
WASD 30Hz auto-repeat 이나 버튼 연타가 burst 16 을 한 번에 비우는 사고를 클라단에서
사전 차단하는 것이 목적이다. 명령별 cooldown(`MOVE_COOLDOWN_MS=500` 등) 은
어차피 서버가 권위로 강제하므로, 클라단 100ms 가 너무 관대해도 게임 동작은 변하지 않는다.

### 0-α. 후속 과제 — 명령별 cadence throttle (미구현)

현 100ms 글로벌 throttle 은 「move 가 500ms 마다만 의미가 있다」 는 사실을 모른다.
W 를 길게 눌러 corridor 를 건너는 자연스러운 입력이 30Hz → 10Hz 로 줄어 서버에
도달, `MOVE_COOLDOWN_MS=500` 이 뒷단에서 2Hz 로 다시 자르는 구조라 8/s 는 토큰
버킷을 갉아먹기만 한다. 명령별 cadence 를 알도록 — `move` 는 500ms, 그 외 100ms
— 만들면 1) 토큰 버킷 낭비 제거, 2) 서버 도달 트래픽 추가 절감, 3) latency 동일.
다만 「W 누르고 있으면 계속 이동」 UX 는 keyup/keydown 트래킹과 타이머가 필요해
간단한 작업은 아니다. 현재 정책으론 게임 동작에 영향 없으므로 미루고 — 이상 트래픽
징후가 보이면 그때 도입.

### 1. WS 프레임 캡 (`WS_MAX_PAYLOAD = 4096`)

`new WebSocketServer({ ..., maxPayload: WS_MAX_PAYLOAD })` 가 단일 프레임
크기 상한을 잡는다. 4 KiB 를 넘는 프레임은 `ws` 가 자동으로 에러를 발생시키고
소켓을 끊는다 — DoS 시도(메가바이트짜리 `say` 등)는 JSON 파서까지 가지
못하고 와이어 레벨에서 죽는다.

### 2. 연결 빈도 제한 (`CONN_RATE_LIMIT`, `CONN_RATE_WINDOW_MS`)

IP 별 슬라이딩 윈도우 — 한 IP 가 `CONN_RATE_WINDOW_MS` (기본 10 초) 안에
`CONN_RATE_LIMIT` (기본 6) 개를 넘는 WebSocket 을 새로 열면 신규 연결을
`close(4003 'rate limit')` 로 거절한다. DEV (`process.env.DEV`) 모드에선
이 게이트를 건너뛴다 — 같은 머신에서 여러 탭을 여는 테스트가 정상 워크플로우.

### 3. 글로벌 토큰 버킷 (`CMD_RATE_PER_SEC`, `CMD_BURST`)

플레이어당 `cmd` 메시지의 전역 처리량 상한. `handleCommand` 진입부에서
지연 갱신(lazy refill) 토큰 버킷을 소비한다:

```js
const dt = (now - player.cmdBucketRefAt) / 1000;
player.cmdBucket = Math.min(CMD_BURST, player.cmdBucket + dt * CMD_RATE_PER_SEC);
if (player.cmdBucket < 1) return;   // silent drop
player.cmdBucket -= 1;
```

- 기본값: `CMD_RATE_PER_SEC = 8` (지속 8 cmd/s), `CMD_BURST = 16` (최대 16 회 연속).
- 토큰이 없으면 **조용히 drop** — rate-limit notice 자체도 송신 비용이라
  flood 를 증폭하지 않도록 응답 없이 무시한다.
- 명령 종류와 무관하게 모든 `cmd` 에 적용 — `look`/`use`/`help` 처럼 별도
  쿨다운이 없는 명령에도 이 게이트로 상한이 잡힌다.
- 타이머·크로스-플레이어 동기화 없음 — 호출 진입 시점의 `now` 만 보고 한 번에
  계산. 1k 동시 접속에서 비용 무시.

### 4. 입력 길이 캡 (`INPUT_MAX_LEN`)

토큰화 직전에 `cmd` 의 `input` 필드를 `slice(0, INPUT_MAX_LEN)` 으로 자른다
(기본 500자). 4 KiB 프레임에 500자짜리 `look <arg>` 를 넣어 게임 코드 안에서
긴 문자열이 비싸지지 않도록 한 번 더 잘라두는 가드.

### 5. 명령별 쿨다운 / 큐잉 / 차단

아래 「명령별 제한」 절 — 각 명령 고유의 쿨다운, 큐잉, 차단 정책.

## 명령별 제한

### `attack` — 공격 쿨다운 (큐잉 방식)

- **간격:** 같은 플레이어가 연속해서 공격할 수 있는 최소 간격은
  `ATTACK_COOLDOWN_MS` (기본 `1000ms`).
- **거부가 아니라 지연이다.** 쿨다운에 걸린 공격은 **거부하지 않고 큐잉**한다.
  남은 쿨다운이 다 지난 시점에 서버가 자동으로 큐잉된 공격을 실행한다.
  (이동 큐와 동일 모델.)
- **응답:** 큐잉 시 `type: 'system'` 메시지 한 번 — `"X.X초 후 공격합니다."`.
  실제 공격 시점에 일반 공격 메시지(피해량/반격/사망 등)가 나간다.
- **재입력은 마지막이 이긴다(latest-wins).** 큐잉 도중 다시 `attack` 을
  입력하면 **기존 타이머를 취소하고** 새 인자로 교체한다. 여러 타이머가
  쌓이지 않는다.
- **대상 재해석은 발화 시점에 한다.** 큐잉된 인자는 문자열 그대로 보관되며,
  타이머가 발화할 때 현재 방의 몬스터/플레이어를 다시 탐색한다. 큐잉 중
  대상이 죽거나 사라졌다면 발화 시 `'<arg>을(를) 찾을 수 없습니다.'`
  또는 다른 대상에 자동 매칭될 수 있다.
- **lastAttackAt 갱신 시점:** `_doAttack` 진입부에서 항상 갱신한다. 대상이
  없거나 잘못된 인자라도 쿨다운은 소비된다 — 클라이언트가 빈 인자로 무한
  핑하는 것을 막기 위함.
- **마법 시전과 슬롯 공유:** `Game.castSpell` 도 같은 `lastAttackAt` 슬롯을
  검사·갱신한다. 공격 → 마법 또는 마법 → 공격 사이도 1 초 쿨다운이 적용돼
  마법으로 공격 쿨다운을 우회할 수 없다(magic.md 참조).
- **취소 조건:** (1) 같은 플레이어의 이후 `attack` 입력(latest-wins 교체),
  (2) 사망/리스폰(`_respawnAtSquare`) — 부활 직후 큐잉된 공격이 광장에서
  발화하지 않도록 강제 취소, (3) 방 이동(`_doMove`) — 큐잉된 인자는 이전
  방 기준이라 다른 방에서 발화하면 의도와 어긋남, (4) 접속 종료
  (`detachPlayer`) — 타이머 누수 방지.
- **상태 저장 위치:** `player.lastAttackAt`, `player.pendingAttack = { arg, timer } | null`
  (서버 메모리). 접속 시 모두 0/null 초기화.

### `move` — 이동 쿨다운 (큐잉 방식)

- **간격:** 같은 플레이어가 맵 사이를 이동할 수 있는 최소 간격은
  `MOVE_COOLDOWN_MS` (기본 `500ms`).
- **거부가 아니라 지연이다.** `attack` 과 동일한 큐잉 모델 — 쿨다운에 걸린
  이동은 거부하지 않고 큐잉, 남은 시간 후 자동 발화.
- **응답:** 큐잉 시 `type: 'system'` 메시지 한 번 — `"X.X초 후 이동합니다."`.
- **재입력은 마지막이 이긴다(latest-wins).** 큐잉 도중 다른 방향으로
  입력하면 기존 타이머를 취소하고 교체. 여러 타이머가 쌓이지 않는다.
- **lastMoveAt 갱신 시점:** **실제로 방을 떠나는 시점**에만 갱신한다.
  큐잉된 이동이 발화한 뒤 출구가 없는 방향이었다면(`'그 방향으로는 갈 수 없습니다.'`)
  쿨다운은 소비되지 않는다 — 벽에 부딪힌 직후라도 다시 정상 방향을 입력할
  수 있다.
- **취소 조건:** (1) 같은 플레이어의 이후 `move` 입력, (2) 사망/리스폰
  (`_respawnAtSquare`) — 큐잉된 방향이 사망 직전 방 기준이라 부활 직후 잘못된
  방으로 끌고 갈 수 있어 강제 취소, (3) 접속 종료(`detachPlayer`) — 타이머
  누수 방지.
- **상태 저장 위치:** `player.lastMoveAt`, `player.pendingMove = { dir, timer } | null`
  (서버 메모리). 접속 시 모두 0/null 초기화. WASD 키 리피트(초당 20~30건)는
  latest-wins 교체로 흡수된다.

### `move` — 킬 스틸 이동 방해 (kill-steal block)

- **트리거:** 플레이어 A 가 결정타를 넣은 몬스터에 대해, 같은 방의 다른
  플레이어 B 가 `combatTargetId` 로 그 몬스터를 가리키고 있었다면 — 즉 B
  가 잡으려던 몬스터를 A 가 가로챈 경우. 여러 명이 교전 중이었다면 첫
  번째로 발견된 B 가 「방해자」로 기록된다.
- **효과:** A 의 `move` 가 `KILLSTEAL_MOVE_BLOCK_MS` (기본 `5000ms`) 동안
  **거부**된다. 기존 쿨다운과 달리 큐잉되지 않는다 — 차단이 풀리는 순간
  자동 이동하는 동작은 anti-grief 의도에 어긋난다.
- **응답:** `type: 'system'` 메시지 — `"<B 이름>님이 당신의 이동을 방해중입니다. (<n>초 후 이동가능)"`.
  차단이 적용되는 시점에 한 번, 차단 중 추가 입력마다 한 번 더 (남은 초는
  매번 재계산).
- **자동 해제(lazy):** 차단을 거는 시점이 아니라 다음 `move` 입력 때 검증.
  방해자 B 가 방을 떠났거나(다른 룸으로 이동·사망 후 광장 리스폰·연결 종료)
  같은 룸에 더 이상 없으면 차단을 즉시 풀고 이동을 통과시킨다. 「방해자가
  떠나면 가둘 이유가 없다」 정책. 동시에 `_clearKillStealBlocksAgainst` 가
  방해자 측 이벤트 시점에 push-clear 도 한다(같은 결과의 이중 가드).
- **취소 조건:** A 의 사망/리스폰. `_respawnAtSquare` 에서
  `moveBlockedUntil`/`moveBlockedBy`/`moveBlockedById` 를 0/null 로 초기화.
- **상태 저장 위치:** `player.moveBlockedUntil` (절대 epoch ms),
  `player.moveBlockedBy` (방해자 이름 문자열), `player.moveBlockedById`
  (방해자 player.id — lazy 해제 시 방해자 룸 위치 검사를 위해 필요).
  접속 시 0/null. 차단을 적용하는 시점에 큐잉된 `pendingMove` 도 함께
  취소된다 — 안 그러면 차단 직후 큐 타이머가 발화해 `_doMove` 로 곧장
  들어간다.

### `say` — 채팅 쿨다운 + 길이 캡

- **간격:** `SAY_COOLDOWN_MS` (기본 `600ms`). 너무 짧으면 floor flood,
  너무 길면 대화가 끊긴다.
- **거부 방식 — 큐잉하지 않음.** 큐잉하면 지연된 broadcast 가 쌓여 룸
  전체에 부담이 된다. 차단되면 `"잠시 후 다시 말할 수 있습니다."` 시스템
  라인 한 줄.
- **길이 캡:** `SAY_MAX_LEN` (기본 `200자`). 거부가 아니라 **잘라낸다** —
  긴 메시지도 의도는 전달되지만 broadcast 비용이 보장된다. 자른 문자열에
  말줄임 표시는 붙이지 않는다.
- **상태 저장 위치:** `player.lastSayAt` (서버 메모리). 접속 시 0 초기화.

### 그 외 명령

`look`, `use`, `equip`, `unequip`, `cast`, `help`, `전직` 등 — 명령별
쿨다운은 **없다.** 글로벌 토큰 버킷(계층 3) 만으로 상한이 잡힌다.

## 1k 동접 관점

- 공격 쿨다운은 플레이어당 1초 = 초당 최대 1회. 1k 동접 × 1 atk/s = 1k atk/s.
  메시지·이벤트 루프 부하 모두 안전한 범위.
- 글로벌 토큰 버킷은 플레이어당 8 cmd/s 상한. 1k × 8 = 8k cmd/s 가 이론적
  최대인데, 실제 사용에서는 한 명이 자주 쓰는 명령 수가 시간당 수백 건
  수준이라 평균은 훨씬 낮음.
- 모든 게이트 검사는 `Date.now()` + 정수 비교 + Map lookup — O(1).
  핫패스 비용 없음.
- 쿨다운 거부 시에도 시스템 메시지 한 줄을 응답한다. 클라이언트가 의도적으로
  쿨다운을 무시하고 1ms 간격으로 보내도 서버가 즉시 거부 응답을 보내므로,
  트래픽 증폭은 1:1 수준에서 멈춘다. `say` 의 거부 메시지는 broadcast 가
  아니라 sender 한 명에게만 가므로 룸 전체로 번지지도 않는다.

## 튜너블 (모두 `server/config.js`)

```js
// 와이어 / 연결 계층
export const WS_MAX_PAYLOAD = 4096;
export const CONN_RATE_WINDOW_MS = 10_000;
export const CONN_RATE_LIMIT = 6;

// 글로벌 토큰 버킷
export const CMD_RATE_PER_SEC = 8;
export const CMD_BURST = 16;

// 입력 / say
export const INPUT_MAX_LEN = 500;
export const SAY_MAX_LEN = 200;
export const SAY_COOLDOWN_MS = 600;

// 명령별 쿨다운
export const ATTACK_COOLDOWN_MS = 1000;
export const MOVE_COOLDOWN_MS = 500;
export const KILLSTEAL_MOVE_BLOCK_MS = 5000;
```

값은 `config.js` 에서만 수정한다. `game.js` 는 직접 숫자를 박지 않는다.

## 관리자 명령 (admin)

일반 게임 명령과 분리된 관리자 전용 채널. 진입점은 같은 `cmd` 메시지지만
`Game.isAdmin(player)` 검증을 통과해야 효과가 발생한다.

### 권한 모델

- 권한 식별은 **네이버 OAuth 의 `naverId`** 한 가지 — 익명/sid-only 사용자는
  영원히 admin 이 될 수 없다. 미인증 사용자는 admin 명령을 시도해도
  `naverId` 가 null 이라 매칭 자체에서 false.
- allowlist 는 `AGRIA_ADMIN_NAVER_IDS` env(콤마 구분, 공백 허용) 에 둔다.
  비어 있거나 미설정이면 admin 0 명 — 모든 admin 명령이 「관리자
  명령입니다」 로 거부.
- 권한 검증 단일 진실원: `server/config.js` 의 `isAdminNaverId(naverId)`.
  캐시는 env 값 변동 시 자동 무효화 — 운영에서는 부팅 시 한 번 set 하므로
  캐시 100%, 테스트는 `process.env.AGRIA_ADMIN_NAVER_IDS` 갈아끼우면 즉시 추종.

### 사용 가능한 명령

| 입력                              | 메서드                                      | 효과                                                                         |
|-----------------------------------|---------------------------------------------|------------------------------------------------------------------------------|
| `리셋 <이름>` / `초기화 <이름>` / `reset <이름>` | `Game.resetCharacter(admin, targetArg)`  | 대상 캐릭터를 신규 baseline(novice L1) 으로 초기화 + 광장 텔레포트 + 영속.  |

### `리셋 <이름>` 의 효과

대상은 같은 이름의 등록된(registered=true) 플레이어 한 명. disconnected
(grace 중) / generating 도 매칭 — disconnected 라면 다음 reattach 시 새
baseline 으로 깨어난다. 효과:

- `klass` → `novice`, `level` → 1, `exp` → 0
- `maxHp / maxMp` 재계산(`classMaxHp('novice', 1)` / `classMaxMp('novice', 1)`)
  → `hp / mp` 가득
- `equipment` → `STARTING_EQUIPMENT()` (튜닉·단검·부츠 시작 세트)
- `inventory` → `STARTING_INVENTORY()` (체력 물약 ×10, 빵 ×2, 밧줄 ×1)
- `roomId` → `square` (옛 룸의 멤버 인덱스에서 빠지고 같은 룸 사람들에게
  「{이름}님이 사라졌다」 라인 송출)
- `combatTargetId` / `pendingMove` / `pendingAttack` / `downed` / `moveBlocked*`
  모두 정리 — pending 타이머는 clearTimeout 으로 cancel
- `mpRegen` 인덱스에서 제거(novice 는 mp 자원 없음)
- 관리자에게 「{이름} 을(를) 레벨 1 노비스로 초기화했습니다」 system 라인,
  대상에게 「관리자에 의해 캐릭터가 초기화되었습니다. 광장에서 다시
  시작합니다」 system 라인. 같은 사람(self-reset) 일 땐 한 줄만.
- 광장에 「{이름}님이 광장에 다시 나타났다」 입장 라인 broadcast.
- 클라 사이드바·전투 패널 갱신: `clearCombat` → `pushStatus` → `describeRoom`.
- 영속 — `_persistPlayer(target)` 가 디스크에 새 baseline flush.
- 운영 audit log: `[admin] {admin.name}({admin.naverId}) reset {target.name}({target.naverId})`.

이 작업은 **파괴적**이며 동의 모달 없이 즉시 발화한다 — 대상의 모든 진행
(레벨/EXP/직업 분기/획득한 장비/드랍·구매한 인벤토리)이 영구 삭제된다. 대상
이름 오타로 다른 사람을 리셋하지 않도록 admin 본인이 신중히 입력해야 한다.

### 향후 admin 명령 TODO

현재는 `리셋` 단일 — 운영 중 자주 필요해지는 도구가 발견되면 같은 권한
모델 위에 추가:

- `킥 <이름>` — 대상의 WS 를 즉시 close(4001 'kicked by admin'). 어뷰저
  강제 퇴장.
- `밴 <naverId>` — naverId 를 차단 리스트에 추가, attach 시점 거부.
- `소환 <이름>` — 대상을 자기 룸으로 소환(현재 광장 텔레포트만).
- `방송 <메시지>` — 모든 룸에 system 라인 broadcast(점검 안내 등).
- `give <이름> <itemId> [수량]` — 대상 인벤토리에 아이템 지급.
- `setlevel <이름> <레벨>` — 디버깅용 레벨 직접 설정.

새 admin 명령을 추가할 때:

1. `Game` 클래스 내부에 메서드 추가, 첫 줄에 `if (!this.isAdmin(admin)) return ...`.
2. `handleCommand` switch 에 case 추가 (한국어/영문 alias 포함).
3. 본 절의 매트릭스에 한 줄 추가.
4. `tests/game.test.js` 의 「관리자 명령 회귀 가드」 절에 권한 거부 + 효과
   + edge case(대상 미존재, 인자 누락) 검증 추가.
5. 파괴적 효과(데이터 삭제, 강제 종료 등)면 audit log(`console.log('[admin] ...')`)
   에 actor + target + naverId 를 기록.

## 새 명령에 rate limit 을 추가할 때

1. `server/config.js` 에 `<COMMAND>_COOLDOWN_MS` 상수 추가.
2. 플레이어 객체에 `last<Command>At` 필드 추가, `_addPlayer` 에서 0 초기화.
3. 해당 명령의 dispatcher 진입부에서
   `Date.now() - player.last<Command>At < COOLDOWN` 검사,
   거부 시 `system` 메시지로 응답하고 return.
4. 통과한 경우 `player.last<Command>At = Date.now()` 갱신.
5. 큐잉이 필요하면 `pending<Command> = { ...args, timer }` 패턴을 따른다 —
   `attack`/`move` 의 latest-wins + 사망/이동/접속종료 시 cancel 분기를
   동일하게 구현.
6. 본 문서 「명령별 제한」 절에 항목 추가.

쿨다운 외 다른 형태(예: 윈도우 내 호출 횟수)가 필요해지면 별도 헬퍼로 빼고
본 문서에서 그 동작을 명시한다.

## 변경 이력

- `attack` 1초 쿨다운 (서버 강제) 도입
- `move` 2초 쿨다운 (서버 강제) 도입 — 맵 간 이동 간격 제한, WASD 키 리피트
  흡수. 출구 없는 방향은 쿨다운을 소비하지 않음.
- `move` 쿨다운을 거부 → **큐잉(자동 발화)** 방식으로 변경. 쿨다운 중 입력은
  거절되지 않고 남은 시간 후 자동 실행. 재입력은 latest-wins 로 교체.
- `move` 쿨다운을 2000ms → **500ms** 로 단축.
- 킬 스틸 이동 방해(`KILLSTEAL_MOVE_BLOCK_MS`, 기본 5초) 도입. lazy 해제
  로직(방해자가 같은 룸을 떠나면 차단 자동 해제) 추가.
- `attack` 쿨다운을 거부 → **큐잉(자동 발화)** 방식으로 변경. 대상 재해석은
  발화 시점에 수행.
- 글로벌 토큰 버킷(`CMD_RATE_PER_SEC=8`, `CMD_BURST=16`) 추가 — 모든 `cmd`
  에 적용되는 전역 상한. 토큰 부족 시 silent drop.
- `say` 쿨다운(`SAY_COOLDOWN_MS=600`) + 길이 캡(`SAY_MAX_LEN=200`, 자르기)
  도입.
- 마법 시전(`castSpell`) 이 `lastAttackAt` 슬롯을 공유하도록 변경 — 공격
  쿨다운 우회 방지.
- 어뷰즈 방어 계층(WS 프레임 캡 4 KiB, 입력 길이 캡 500자, IP 별 연결 빈도
  6/10s) 정리.
- 클라 측 송신 최소 간격(`MIN_SEND_INTERVAL_MS=100`, `public/client.js`) 도입 —
  키보드 auto-repeat / 버튼 연타가 서버 토큰 버킷에 도달하기 전에 잘려 나가도록.
  `sendCmdEcho()` 헬퍼로 송신 실패 시 로그 echo 도 함께 생략(유령 명령 방지).
  서버 권위 5 계층은 그대로 — 클라 우회 공격은 여전히 서버에서 막힌다.
- 클라 throttle 의 시계를 `Date.now()` → `performance.now()` 로 교체(monotonic).
  `sendCmdEcho` 시그니처를 `(input, echoLabel = input)` 으로 정리해 같은 문자열을
  두 번 넘기던 호출 사이트 4 개를 한 인자로 압축.
- throttle 정책을 `public/throttle.js` ESM 모듈로 추출하고 `client.js` 가 import
  하도록 재구성(index.html 의 client.js 스크립트는 `type="module"` 로 전환).
  `tests/throttle.test.js` 13 케이스로 가짜 시계·가짜 소켓 주입 회귀 가드 — 첫
  송신 통과 / 100ms 경계(99/100/101) / 소켓 readyState 분기 / `sock.send` throw /
  JSON 직렬화 실패 / 재연결 시 새 소켓 follow / 인스턴스 격리 / 30Hz 입력에서
  ~10 통과 sustained.
- 1k 동접 관점 hot path 최적화 묶음.
  - `Game.roomMembers = Map<roomId, Set<playerId>>` 인덱스 도입 — broadcastRoom /
    `_pushRoomMonsters` / `_buildRoomPayload` / `_sendRoomSprites` / `_regenTick`
    의 engagement scan / `_clearKillStealBlocksAgainst` / 같은 룸 attack/spell
    observer 7 개 사이트가 `this.players.values()` 전체 순회에서 `_roomPlayers(roomId)`
    iterator 로 교체. 룸 mutation 5 지점(register/_doMove/respawn/_addAuthenticatedPlayer/
    `_unindexPlayer` via `_finalizePlayer`) 에서만 인덱스 갱신. 룸 단위 push 비용을
    O(N_total) → O(N_room) 으로.
  - `store.bySessionToken` 병행 인덱스 — `getUserBySessionToken` 을 선형 스캔에서
    O(1) 룩업으로. WS connect / `/auth/me` 마다 호출되는 hot path 라 누적 가입자
    수에 무관하게 비용 일정. 토큰 변동 4 지점(loginNaverUser 회전 / clearSessionToken /
    reloadStateFromDb / `_resetForTesting`) 에서 동기화.
  - `pushStatusDelta(player, partial)` 도입 — MP regen 이 풀 status 대신 `{ mp }`
    한 필드만 송신. 클라 `applyStatusDelta` 가 lastStatus 캐시에 병합 후 영향
    행만 setBar, 인벤토리/장비 DOM 재구성 skip. 1k 마법사 부족 상태에서의
    직렬화·대역·클라 CPU 모두 절감.
  - `SPELL_PREFIX_TABLE` 모듈 로드 시 prebuild — `_matchSpellPrefix` 가 매 cmd
    마다 같은 후보 배열을 재구성하던 것을 한 번만.
  - 클라 `renderStatus` 의 12 회 `getElementById` 를 모듈 상단 캐시로(`statClassEl`,
    `statHpRow`, `statHpFill`, ...). 사이드바 DOM 은 라이프타임 동안 안 바뀜.
  - `tests/game.test.js` 7 케이스 추가 — `_indexInRoom` idempotent / 마지막 멤버
    제거 시 Set 자체 정리 / `_roomPlayers` 분리 / 정리 누락 race 안전 / `_unindexPlayer`
    가 roomMembers 까지 / `pushStatusDelta` 페이로드 형태 + falsy no-op. 65/65 통과.
- 관리자 명령 채널 도입 — `AGRIA_ADMIN_NAVER_IDS` env allowlist + `Game.isAdmin` /
  `Game.resetCharacter` / `리셋 <이름>` 디스패치. 운영자가 어뷰저나 테스트
  계정을 신규 baseline(novice L1, 시작 장비/인벤, 광장) 으로 되돌릴 수 있다.
  파괴적 작업이라 audit log(`[admin] {actor} reset {target}`) 도 함께. 회귀
  가드 4 케이스 — env 분기 / 비관리자 거부 / 풀 reset 효과(stat/직업/장비/
  인벤토리/룸/mpRegen) / 인자 누락·미존재 분기. 89/89 통과.
