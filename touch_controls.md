# Touch Controls — 모바일 하단 컨트롤

## 개요

모바일(≤768px)에서 채팅 입력창 바로 위에 노출되는 하단 컨트롤 영역. 두 클러스터로 구성된다.

- **좌측 D-pad** — 4방향 이동.
- **우측 액션 패드** — `공격` / `봐` / `마법`(마법사 한정) 계층 메뉴. 방의 실제 대상이 있을 때만 노출.

데스크톱에서는 둘 다 `display: none`. 서버는 모바일 여부를 모르며, 두 컨트롤 모두 기존 `cmd` 메시지로 텍스트 명령을 보내는 얇은 래퍼다.

## 레이아웃

```
┌───────────────────────── #touch-controls ─────────────────────────┐
│                                                                   │
│   ┌─ #dpad ─┐                                ┌─ #action-pad ──┐   │
│   │   ▲     │                                │  [공격] [봐]   │   │
│   │ ◀ ▼ ▶   │   ←  flex justify space-between│                │   │
│   └─────────┘                                └────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                             ↑ #prompt-form (입력창)
```

- 컨테이너 `#touch-controls` 는 `display: flex; justify-content: space-between` — d-pad는 항상 좌측 끝에, 액션 패드는 우측 끝에 정렬.
- d-pad 폭(132px = 3×36 + 두 gap)을 액션 패드의 `max-width: calc(100% - 132px)` 로 빼두어 서로 침범하지 않도록.
- 두 클러스터 모두 입력창과 시각적으로 분리되도록 `border-top: 1px solid var(--border)`.

## D-pad

키보드 방향키 클러스터를 본뜬 **ㅗ 모양** 2행 3열 grid.

| 위치 | 라벨 | 명령 |
| --- | --- | --- |
| 1행 2열 | ▲ | `go north` |
| 2행 1열 | ◀ | `go west` |
| 2행 2열 | ▼ | `go south` |
| 2행 3열 | ▶ | `go east` |

각 버튼에 `data-dir` 속성으로 영문 방향을 박아두고, 위임 클릭 핸들러가 `sendCmd(\`go ${dir}\`)` 으로 전송한다. 데스크톱 WASD 핸들러와 같은 echo 포맷(`> [이동] <방향>`).

## 액션 패드 — 계층 메뉴

`actionPadLevel ∈ {'root', 'attack', 'look', 'magic-spells', 'magic-targets'}` 단일 상태 머신. `magic-targets` 단계에 있는 동안 어떤 마법을 고른 상태인지를 별도 변수 `selectedSpell` 이 보관한다.

### Root

- `[공격]` — 방에 살아있는 몬스터가 1마리 이상일 때만 표시.
- `[봐]` — 방에 몬스터·오브젝트·다른 플레이어 중 하나라도 있으면 표시.
- `[마법]` — 마법사이고(status `spells[]` 비어 있지 않음) + 시전 가능한 몬스터가 같은 방에 있을 때만 표시.
- 셋 다 없으면 빈 패드. 사용자가 의미 없는 메뉴를 탭하지 않게 하려는 의도.

탭하면 해당 서브메뉴로 진입하되 명령은 **이 시점에 보내지 않는다** — 단 「교전 단축경로」가 발동하면 즉시 명령을 보낸다(아래 절 참조).

### 교전 단축경로 (선택지 없이 즉시 시전)

이미 어떤 몬스터와 교전 중인 상태(서버에서 `combat` 메시지가 와서 패널이 떠 있는 상태)에서:

- `[공격]` 을 탭하면 타깃 리스트로 내려가지 않고 **현재 교전 foe 에게 즉시 `attack <foe>`** 를 보낸다.
- `[마법]` → 마법 선택까지는 그대로 진행하되, 마법 버튼을 탭하면 타깃 리스트로 내려가지 않고 **현재 교전 foe 에게 즉시 `<마법명> <foe>`** 를 보낸다.

판정은 클라이언트 단의 `combatFoeInRoom()` 헬퍼가 한다 — 가장 최근 `combat` 메시지의 foe 이름이 현재 방의 `currentRoomTargets.monsters` 에 그대로 살아 있을 때만 단축경로가 켜진다. 다음 중 하나라도 해당하면 폴백(평소대로 타깃 리스트가 뜬다):

- foe 가 죽거나 다른 방으로 빠져 같은 방에 더 이상 없을 때
- 패널이 닫혔을 때(`combat=null` 메시지)
- 한 번도 교전을 안 한 신규 상태

이 동작은 PC 텍스트 입력 측에서도 거울이 있다 — 인자 없는 `attack` / `<마법명>` 은 서버의 `_doAttack` / `castSpell` 이 `player.combatTargetId` 가 같은 방에 살아 있으면 그쪽을 우선 고른다(없으면 방의 첫 번째 몬스터로 폴백). 모바일 단축경로와 PC 무인자 명령이 같은 의도를 갖도록 통일.

### Attack 서브메뉴

- 방의 살아있는 몬스터 이름이 각각 하나의 버튼으로 펼쳐짐.
- 마지막 줄에 **↩ 백 버튼**.
- 타깃 탭 → `attack <name>` 송신 + 로그에 `> 공격 <name>` echo + root 복귀.
- 백 버튼 탭 → 명령 송신 없이 root 복귀.

다른 플레이어는 의도적으로 공격 후보에서 제외 — 한 번의 오탭으로 PvP가 시작되지 않도록.

### Look 서브메뉴

- 몬스터 + 오브젝트 + 같은 방의 다른 플레이어를 합친 단일 리스트.
- 마지막 줄에 **↩ 백 버튼**.
- 타깃 탭 → `look <name>` 송신 + `> 봐 <name>` echo + root 복귀.

### Magic 서브메뉴 (마법사 한정)

- `magic-spells` — 캐릭터가 시전 가능한 마법(`status.spells[]`)을 한 개씩 버튼으로(`<이름>·<MP비용>MP`). 버튼은 element 별 색(`action-spell-fire/ice/...`).
  - 일반 탭(교전 외) → `selectedSpell` 저장 + `magic-targets` 로 진입.
  - 교전 단축경로 → 그 자리에서 `<마법명> <foe>` 송신 + root 복귀.
- `magic-targets` — 같은 방의 살아 있는 몬스터 리스트 + ↩ 백 버튼.
  - 타깃 탭 → `<선택된 마법명> <name>` 송신 + root 복귀.
  - 백 버튼 → `magic-spells` 로 한 단계만 복귀.

### 자동 폴백

서브메뉴에 머무는 도중 마지막 타깃이 사라지면(예: 몬스터를 다 잡음) 다음 `room_monsters` 갱신 시 `renderActionPad()` 가 빈 리스트를 감지하고 자동으로 root로 복귀한다(또는 한 단계 위 — 예: `magic-targets` 가 비면 `magic-spells` 로). 빈 패널이 노출되는 상태를 만들지 않는다.

### 시각 위계

- 카테고리 버튼(`.action-cat`): 강조 배경(`--accent-soft`).
- 타깃 버튼(`.action-target`): 일반 배경. 긴 이름은 `text-overflow: ellipsis` 로 잘리며 `max-width: 130px` 캡.
- 백 버튼(`.action-back`): 투명 + 디밍 색.

## 서버 프로토콜

액션 패드 채우기를 위해 **기존 `room_monsters` 메시지를 확장**했다 — 새 메시지 타입을 추가하지 않고 한 페이로드에 룸 스냅샷을 모두 싣는다.

```jsonc
{
  "type": "room_monsters",
  "roomId": "square",
  "monsters": [{ "id": 12, "defId": "goblin", "name": "고블린", "hp": 14, "maxHp": 20, "icon": "🧌" }],
  "objects":  [{ "id": "crystal",     "name": "수정"     }],
  "players":  [{ "id": 7,             "name": "카이런"   }]
}
```

- `monsters` 는 기존 형태 그대로 (HP 바 패널이 계속 사용). 추가된 `objects` / `players` 만 액션 패드 전용.
- `players` 는 **수신자별로 self를 제외**한다. 즉 같은 방에 두 명이 있으면 각자 상대방만 들어 있는 payload가 전송된다 → 자기 자신을 "봐" 대상으로 보지 않음.
- 클라이언트는 알지 못하는 필드를 무시하므로 구버전 클라이언트와도 호환.

### 푸시 시점 (서버 → 클라이언트)

룸 구성이 변할 때마다 영향받은 룸의 모든 멤버에게 푸시.

| 사건 | 푸시 대상 룸 |
| --- | --- |
| 몬스터 스폰/사망/HP 변화 | 해당 룸 |
| 플레이어 이동 | 출발 룸 + 도착 룸 |
| 플레이어 등록 도착 | 도착 룸 |
| 플레이어 사망 → 광장 리스폰 | 사망 룸 + `square` |
| 플레이어 디스커넥트 정리 | 떠난 룸 |

각 푸시에서 룸의 살아있는 등록 플레이어들을 순회하며 `_buildRoomPayload(roomId, recipientId)` 로 개별 송신.

## 클라이언트 상태

`public/client.js` 에 다음 상태가 있다.

```js
let currentRoomTargets = { monsters: [], objects: [], players: [] };
let actionPadLevel = 'root';
```

- `room_monsters` 메시지 수신 시 `currentRoomTargets` 를 갈아끼우고 `renderActionPad()` 호출.
- `renderActionPad()` 는 `pad.innerHTML = ''` 후 현재 레벨에 맞춰 버튼들을 새로 생성. row 단위 diff 없이 전부 재구성하는 편이 단순하고, 2~10개 정도의 버튼은 재생성 비용이 무시할 수준.

## 구현 위치

- **마크업:** `public/index.html`
  - `#viewport` 안, `#object-view` 와 `#prompt-form` 사이에 `#touch-controls` 배치.
  - `#dpad` 의 4 버튼은 정적이며 `data-dir` 속성을 가진다.
  - `#action-pad` 의 자식은 JS가 매번 다시 생성하므로 정적 자식은 두지 않는다(`setupActionPad()` 가 첫 호출에서 `innerHTML=''` 으로 비움).
- **CSS:** `public/style.css`
  - `#touch-controls { display: none; }` 데스크톱 기본.
  - `@media (max-width: 768px)` 안에서 grid/flex 레이아웃, 버튼 메트릭, `:active` 강조, `touch-action: manipulation`(iOS 더블탭 줌 차단), `-webkit-tap-highlight-color: transparent`(기본 하이라이트 제거) 적용.
- **클라이언트 JS:** `public/client.js`
  - `setupDpad()` — d-pad 위임 클릭 핸들러 등록.
  - `setupActionPad()` — `renderActionPad()` 1회 호출로 정적 자식 정리 + 첫 렌더.
  - `renderActionPad()` — 현 레벨/타깃 기반 DOM 재구성.
  - `attackableTargets()` / `lookableTargets()` — `currentRoomTargets` 에서 후보 추출.
- **서버:** `server/game.js`
  - `_buildRoomPayload(roomId, forPlayerId)` — 단일 수신자용 payload 빌더.
  - `_pushRoomMonsters(roomId)` — 룸 멤버별 개별 송신.
  - `describeRoom`, `_doMove`, `_finalizePlayer`, `register*`, `respawn` 경로에서 위 함수들로 룸 스냅샷 푸시.

## 1k 동접 관점

- `room_monsters` 푸시는 룸 단위 broadcast 로 수렴 — 1k 플레이어가 50개 룸에 분산되면 룸당 평균 20명, 한 사건당 송신 20건. self-exclude 때문에 broadcast 한 번이 아니라 N개의 send 가 되지만, 룸 내 인원 수만큼이라 본질적으로 같은 비용.
- `_buildRoomPayload` 가 호출당 `this.players.values()` 를 순회 — 룸당 O(N_players_in_room). 룸 내부 플레이어 캐시를 유지하지 않는 현 구조에선 `players.values()` 한 번이면 충분히 빠르다(초당 수백~수천 푸시까지 여유). 룸 인원 캐시 도입은 측정 후 결정.
- 한 메시지에 monsters/objects/players 를 묶은 덕분에 액션 패드 갱신만을 위해 별도 메시지 타입을 추가하지 않아 프레임 수가 늘지 않는다.

## 향후 확장 후보 (미구현)

- 공격 서브메뉴에 다른 플레이어를 옵션 토글로 노출(PvP 모드 진입 시).
- 액션 카테고리 추가 — `사용` (인벤토리 아이템), `말` (정형 메시지). `사용` 은 인벤토리 상태를 액션 패드 후보로 끌어와야 하므로 `status` 메시지와 결합 필요.
- 햅틱 피드백 — `navigator.vibrate(10)` 단발. iOS Safari는 vibrate 미지원이므로 Android 한정.
- 길게 누르기로 무대상 명령(`look` no-arg = 방 전체 묘사) 발사 — 현재는 텍스트 입력으로만 가능.

## 변경 이력

- 모바일 하단 d-pad(ㅗ 모양 4 버튼) 도입 — 채팅 입력창 위에 좌측 정렬.
- 우측 액션 패드 도입 — 처음에는 `공격`/`봐` 라벨 회전(예측 사이클)이었다가, 계층 구조(root → 타깃 리스트 → ↩)로 재설계.
- 서버 `room_monsters` 페이로드에 `objects` / `players` 추가, 룸 구성 변화 지점에 푸시 호출 보강.
- 카테고리 버튼은 후보가 있을 때만 노출 — 빈 메뉴 탭을 원천 차단.
