# UI Main — 메인 화면 레이아웃

이 문서는 메인 화면 구성, 특히 **사이드바(상태창)** 의 위치·구조·갱신 흐름을
정리한다.

## 레이아웃 (현재)

```
┌──────────────┬──────────────────────────────────────────┐
│              │                                          │
│   사이드바    │          텍스트 뷰포트 (MUD)              │
│   (좌측)     │   - 전투 패널 (combat 시 노출)             │
│              │   - 로그 (스크롤)                          │
│   캐릭터     │   - 오브젝트 UI 패널 (look 시 노출)         │
│   장비       │   - 모바일 d-pad / 액션 패드                │
│   아이템     │   - 입력 프롬프트                          │
│   지도       │                                          │
│   연결상태    │                                          │
└──────────────┴──────────────────────────────────────────┘
```

- **사이드바는 좌측 고정** (`#app { grid-template-columns: <width> 8px 1fr; }`).
  - 이전 버전은 우측이었으나 좌측으로 변경됨.
  - 폭은 사용자가 `#sidebar-resizer` 드래그로 조정 — 마지막 값이
    `localStorage.agria.sidebarWidth` 에 저장돼 다음 접속에 복원된다.
  - 변경 시 함께 조정해야 하는 항목:
    - `public/index.html` 안에서 `<aside id="sidebar">` 가
      `<section id="viewport">` 보다 **먼저** 와야 함.
    - `#viewport` 의 분리선은 `border-left` (사이드바와 맞닿는 쪽).
- 모바일(≤768px)에선 사이드바가 기본 접힘 — 헤더 좌상단의 `#sidebar-toggle`
  버튼으로 열고 닫는다. 열린 상태는 `#sidebar-backdrop` 으로 본문 영역을
  덮어 탭하면 자동 닫힘.

## 사이드바 구조 (`#sidebar`)

DOM 순서대로:

| 영역         | id / class                                      | 역할 |
| ------------ | ------------------------------------------------ | ---- |
| 헤더         | `#status-header` → `#status-name`                | 플레이어 이름 |
| 캐릭터 stats | `.status-block` → `#character-stats`             | 직업·레벨·HP·MP·EXP 바 (+ 전직 안내 hint) |
| 장비 블록    | `.status-block` → `#equipment`                   | 장비 슬롯 5종 (head/body/weapon/offhand/feet) |
| 아이템 블록  | `.status-block` → `#inventory`                   | 인벤토리 목록 (아이콘/이름/수량) |
| 지도 블록    | `.status-block` → `#map-canvas`                  | 미니맵 (현재 zone 의 룸 그래프 + 자기 위치) |
| 푸터         | `#status-footer` → `#conn-status`, `#settings-open` | WS 연결 상태(`on`/`off`), 설정 모달 트리거 |

`#sidebar-toggle` (모바일 햄버거) 와 `#sidebar-resizer` (드래그 핸들) 는
사이드바 외부의 형제 요소라 사이드바가 접혀도 살아 있다.

### 캐릭터 stats 블록

`#character-stats` 안에 6 개 행:

- **직업** (`#stat-class`) — `klassName` 표시.
- **레벨** (`#stat-level`).
- **체력 바** (`#stat-hp-fill` / `#stat-hp-num`) — 항상 표시.
- **마나 바** (`#stat-mp-fill` / `#stat-mp-num`) — `maxMp > 0` 일 때만 표시
  (novice 는 자동 숨김).
- **경험치 바** (`#stat-exp-fill` / `#stat-exp-num`) — 만렙은 「MAX」 텍스트로 고정.
- **전직 안내** (`#stat-class-hint`) — `canChangeClass=true` 일 때 강조 박스 노출.

`canChangeClass` 는 서버에서 권위 계산 후 보내준다(클라가 광장 좌표/레벨을
알 필요 없도록). 클라는 단순히 boolean 만 보고 박스를 켜고 끈다.

### 장비 슬롯

`client.js` 의 `EQUIP_SLOTS` 상수에 `[키, 한글라벨]` 쌍으로 고정 정의되어 있다.
슬롯 추가 시 이 배열에만 추가하면 사이드바에 자동 반영됨. 빈 슬롯은 `li.empty`
클래스로 회색 이탤릭 처리.

### 아이템 목록

`status.inventory` 배열을 그대로 렌더. 각 항목은 `{ id, name, icon, qty,
attack?, defense? }`. `qty > 1` 일 때만 `×N` 표시. equip-kind 아이템은
이름 옆에 `+5⚔` / `+3🛡` 토큰을 붙인다(좁은 사이드바에서 별도 컬럼을 두면
가독성이 떨어져 한 줄에 합침 — equipment.md 참조).

## 데이터 흐름

서버 → 클라이언트 메시지 `type: 'status'` 한 종류로 캐릭터·장비·아이템
블록이 모두 갱신된다.

```jsonc
{
  "type": "status",
  "status": {
    "name":         "카이런",
    "roomId":       "square",
    "klass":        "mage",
    "klassName":    "마법사",
    "level":        12,
    "exp":          380,           // 현재 레벨 구간 진행도
    "expNext":      400,           // 현재 레벨 구간의 길이 (만렙은 0)
    "hp":           150,
    "maxHp":        210,
    "mp":           42,
    "maxMp":        85,
    "equipment":    { "head": null, "body": {...}, "weapon": {...}, "offhand": null, "feet": {...} },
    "inventory":    [{ "id": "potion_hp", "name": "체력 물약", "icon": "❦", "qty": 3 }, ...],
    "spells":       [{ "id": "fireball", "name": "파이어볼", "mpCost": 8, "element": "fire", "minLevel": 10 }, ...],
    "canChangeClass": false
  }
}
```

- **부분 갱신 없음**: 서버는 항상 전체 상태를 보내고 클라이언트는 통째로 다시
  그린다. 1k 동접 환경에서도 페이로드가 작아(직렬화 ~200 byte) 부담 없음.
  추후 슬롯/아이템이 수십 종 이상으로 늘어날 때 부분 패치(JSON Patch 등)
  도입 검토.
- `spells[]` 는 마법사 한정 — 모바일 액션 패드의 마법 메뉴 채우기에 사용.
- `roomId` 는 미니맵(`#map-canvas`) 이 「현재 위치」 마커를 그릴 때 쓴다.

### 트리거 시점 (서버 `Game.pushStatus(player)`)

`pushStatus` 는 단일 수신자에게만 보낸다(broadcast 가 아니다). 호출은 상태에
의미 있는 변화가 일어난 직후에만:

- 등록 완료(`registerPlayer`).
- 재접속 attach(`_reattachExistingPlayer`).
- 인증 사용자 hydrate(`_addAuthenticatedPlayer`).
- 방 이동(`_doMove`).
- 사망/리스폰(`_respawnAtSquare`).
- 장비 변경(`equip` / `unequip`).
- 직업 전환(`changeClass`).
- 아이템 사용(`useItem`).
- 공격·반격으로 HP 가 변할 때(`_attackMonster`).
- 마법 시전 후 MP/HP 가 변할 때(`castSpell`).
- 경험치 획득·레벨업(`_grantExp`) — 마지막에 한 번만 push 해 같은 틱 내
  중복 송신 방지.
- 마나 자가 회복 틱(`_regenTick`) — 마법사 한정, MP 가 실제로 변한 경우만.

## 레이아웃 고정 규칙 — 반드시 지킬 것

### 뷰포트 높이와 프롬프트 고정

**입력 프롬프트(`#prompt-form`) 는 항상 뷰포트 하단에 고정**된다. 로그가
아무리 길어져도 페이지 전체 스크롤이 발생해서는 안 된다. 이를 보장하는 CSS
불변식:

| 요소 | 필수 속성 | 이유 |
| --- | --- | --- |
| `html, body` | `height: 100%` | 전체 높이 기준 확립 |
| `#app` | `height: 100vh; grid-template-rows: 1fr; overflow: hidden` | 단일 행이 컨테이너 전체 높이(100vh)를 채우도록 강제 |
| `#viewport` | `overflow: hidden` | 그리드 셀 밖으로 팽창 방지 |
| `#log` | `flex: 1; overflow-y: auto` | 남은 공간을 차지하며 내부 스크롤 |
| `#prompt-form` | `flex-shrink: 0` | flex 압축 방지 — 항상 온전한 높이 유지 |

**금지 사항:**
- `#viewport` 에서 `overflow: hidden` 을 제거하지 말 것 — 즉시 페이지 스크롤
  재발.
- `#log` 의 `flex: 1` 을 고정 높이로 바꾸지 말 것.
- `body` 또는 `#app` 에 `overflow-y: auto / scroll` 을 추가하지 말 것.

## 모드 인디케이터

프롬프트 영역 우측의 `#mode-badge` 는 입력 모드(TYPING)와 이동 모드(MOVE)를
표시한다. 자세한 내용은 `movement.md` 참조.

## 오브젝트 UI 패널 (`#object-view`)

사이드바와 별도로 **뷰포트 내부**에 위치한다. 대부분의 오브젝트는 텍스트
묘사만 받지만, 서버가 `view` 페이로드를 보낸 오브젝트는 이 패널에서 아이콘·
태그·스탯바·전승(lore)이 구조적으로 렌더된다. 방을 `look` 으로 다시 보면
서버가 `view: null` 을 함께 보내 패널이 닫힌다.

## 전투 패널 (`#combat-view`)

마찬가지로 뷰포트 내부, `#log` 위쪽에 위치. `combat` 메시지를 받으면 표시,
`combat: null` 로 닫힘. 마법 시전 시 element 별 발사체 overlay 가 위에 뜬다
(magic.md 「전투 패널 이펙트」 절 참조). 패널이 켜지면 `#log` 의
`clientHeight` 가 줄어들기 때문에 `scrollLogToBottom()` 이 다음 frame 에서
스크롤을 다시 끝으로 맞춘다.

## 설정 모달 (`#settings-overlay`)

푸터의 `#settings-open` 으로 띄운다. 두 그룹:

- **테마** — `themes/<name>.css` 들 중 하나 선택. 선택 즉시 `<html data-theme>`
  바뀌고 `localStorage.agria.theme` 에 저장.
- **계정** (`#settings-account-group`) — 네이버 로그인 사용자에게만 노출.
  닉네임 + 「로그아웃」 버튼. 로그아웃은 `/auth/logout` POST 후 페이지 reload.

자세한 인증 흐름은 `auth.md` 참조.

## 변경 이력

- 사이드바 우측 → 좌측 이동.
- 모드 배지(`#mode-badge`) 추가 — 이동 모드 도입에 따른 시각 표시.
- `#viewport` 에 `overflow: hidden` 추가 — 로그가 길어질 때 페이지 스크롤
  발생 버그 수정, 프롬프트 하단 고정 보장.
- 사이드바에 캐릭터 stats 블록(`#character-stats`) 추가 — 직업/레벨/HP/MP/
  EXP/전직 안내. status 페이로드에 `klass/klassName/level/exp/expNext/hp/
  maxHp/mp/maxMp/spells/canChangeClass` 필드 동시 추가.
- 사이드바에 미니맵 블록(`#map-canvas`) 추가 — `roomId` 변화에 반응해 현재
  zone 의 룸 그래프 위에 위치 마커 갱신.
- 모바일 햄버거 토글(`#sidebar-toggle`) + 백드롭 + 드래그 리사이저 추가.
  사이드바 폭은 `localStorage` 에 영속.
- 설정 모달에 계정 그룹 추가 — 네이버 로그인 사용자 닉네임 + 로그아웃 버튼
  (auth.md).
- `pushStatus` 를 등록 / 이동 / 사망 / equip / unequip / 전직 / 아이템 사용 /
  공격 / 마법 / 경험치 획득 / 마나 회복 틱 등 「상태가 의미 있게 변하는 모든
  지점」 으로 확대. 옛 「접속 시점에만 호출」 가이드는 폐기.
