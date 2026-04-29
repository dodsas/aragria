# UI Main — 메인 화면 레이아웃

이 문서는 메인 화면 구성, 특히 **사이드바(상태창)** 의 위치·구조·갱신 흐름을 정리한다.

## 레이아웃 (현재)

```
┌──────────────┬──────────────────────────────────────────┐
│              │                                          │
│   사이드바    │            텍스트 뷰포트 (MUD)            │
│   (좌측)     │   - 로그 (스크롤)                          │
│              │   - 오브젝트 UI 패널 (look 시 노출)         │
│   장비       │   - 입력 프롬프트                          │
│   아이템     │                                          │
│              │                                          │
│   연결상태    │                                          │
└──────────────┴──────────────────────────────────────────┘
```

- **사이드바는 좌측 고정** (`#app { grid-template-columns: 320px 1fr; }`).
  - 이전 버전은 우측이었으나 좌측으로 변경됨.
  - 변경 시 함께 조정해야 하는 항목:
    - `public/index.html` 안에서 `<aside id="sidebar">`가 `<section id="viewport">`보다 **먼저** 와야 함.
    - `#viewport`의 분리선은 `border-left` (사이드바와 맞닿는 쪽).
- 폭 320px 고정. 본문은 남은 공간 모두 차지.

## 사이드바 구조 (`#sidebar`)

DOM 순서대로:

| 영역 | id / class | 역할 |
| --- | --- | --- |
| 헤더 | `#status-header` → `#status-name` | 플레이어 이름 표시 |
| 장비 블록 | `.status-block` → `#equipment` | 장비 슬롯 5종 (head / body / weapon / offhand / feet) |
| 아이템 블록 | `.status-block` → `#inventory` | 인벤토리 목록 (아이콘 / 이름 / 수량) |
| 푸터 | `#status-footer` → `#conn-status` | WebSocket 연결 상태 (`on`/`off` 클래스) |

### 장비 슬롯

`client.js`의 `EQUIP_SLOTS` 상수에 `[키, 한글라벨]` 쌍으로 고정 정의되어 있다. 슬롯 추가 시 이 배열에만 추가하면 사이드바에 자동 반영됨.
빈 슬롯은 `li.empty` 클래스로 회색 이탤릭 처리.

### 아이템 목록

`status.inventory` 배열을 그대로 렌더. 각 항목은 `{ id, name, icon, qty }`. `qty > 1`일 때만 `×N` 표시.

## 데이터 흐름

서버 → 클라이언트 메시지 `type: 'status'` 한 종류로 전체 상태창이 갱신된다.

```jsonc
{
  "type": "status",
  "status": {
    "name": "여행자1",
    "equipment": { "head": null, "body": {...}, "weapon": {...}, "offhand": null, "feet": {...} },
    "inventory": [ { "id": "potion_hp", "name": "체력 물약", "icon": "❦", "qty": 3 }, ... ]
  }
}
```

- **부분 갱신 없음**: 서버는 항상 전체 상태를 보내고 클라이언트는 통째로 다시 그린다. 1k 동접 환경에서도 페이로드가 작아 부담 없음. 추후 슬롯/아이템이 수십 종 이상으로 늘어날 때 부분 패치(JSON Patch 등) 도입 검토.
- 트리거 위치: `Game.pushStatus(player)` — 현재는 접속 시점에만 호출. 장비 변경/획득 명령 추가 시 그 핸들러 끝에서 다시 호출하면 됨.

## 레이아웃 고정 규칙 — 반드시 지킬 것

### 뷰포트 높이와 프롬프트 고정

**입력 프롬프트(`#prompt-form`)는 항상 뷰포트 하단에 고정**된다. 로그가 아무리 길어져도 페이지 전체 스크롤이 발생해서는 안 된다. 이를 보장하는 CSS 불변식:

| 요소 | 필수 속성 | 이유 |
| --- | --- | --- |
| `html, body` | `height: 100%` | 전체 높이 기준 확립 |
| `#app` | `height: 100vh; grid-template-rows: 1fr; overflow: hidden` | 단일 행이 컨테이너 전체 높이(100vh)를 채우도록 강제. `rows`가 없으면 암묵적 행이 `auto`(콘텐츠 크기)로 결정됨 |
| `#viewport` | `overflow: hidden` | 그리드 셀 밖으로 팽창 방지 |
| `#log` | `flex: 1; overflow-y: auto` | 남은 공간을 차지하며 내부 스크롤 |
| `#prompt-form` | `flex-shrink: 0` | flex 압축 방지 — 항상 온전한 높이 유지 |

**금지 사항:**
- `#viewport`에서 `overflow: hidden`을 제거하지 말 것 — 즉시 페이지 스크롤이 재발한다.
- `#log`의 `flex: 1`을 고정 높이로 바꾸지 말 것.
- `body` 또는 `#app`에 `overflow-y: auto / scroll`을 추가하지 말 것.

## 모드 인디케이터

프롬프트 영역 우측의 `#mode-badge` 는 입력 모드(TYPING)와 이동 모드(MOVE)를 표시한다. 자세한 내용은 `movement.md` 참조.

## 오브젝트 UI 패널 (`#object-view`)

사이드바와 별도로 **뷰포트 내부**에 위치한다 (사이드바가 아닌 본문 영역에서 노출).
대부분의 오브젝트는 텍스트 묘사만 받지만, 서버가 `view` 페이로드를 보낸 오브젝트는 이 패널에서 아이콘·태그·스탯바·전승(lore)이 구조적으로 렌더된다.
방을 `look` 으로 다시 보면 패널이 닫히도록 서버가 `view: null` 을 함께 보낸다.

## 변경 이력

- 사이드바 우측 → 좌측 이동
- 모드 배지(`#mode-badge`) 추가 — 이동 모드 도입에 따른 시각 표시
- `#viewport`에 `overflow: hidden` 추가 — 로그가 길어질 때 페이지 스크롤 발생 버그 수정, 프롬프트 하단 고정 보장
