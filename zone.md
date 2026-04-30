# Zone System

이 문서는 맵의 콘텐츠 단위인 **zone**의 정의·로딩·확장 규약이다. 게임 로직은 `server/game.js`, zone 콘텐츠는 `server/zones/<id>.js`, 머지 로더는 `server/zones/index.js`에 있다.

## 개념

- zone은 **자기완결적인 콘텐츠 묶음**이다 — 룸들, 그 룸이 참조하는 오브젝트, 초기 몬스터 스폰을 한 모듈에 모은다.
- 별도의 Zone 클래스나 상속은 없다. zone은 **공통 스키마를 따르는 default-export 객체**일 뿐.
- 부팅 시 로더가 모든 zone을 머지하여 글로벌 `ROOMS`/`OBJECTS`/`INITIAL_SPAWNS`를 만든다. 게임 코드는 이전과 동일하게 평탄한 사전을 룩업한다 — 즉, **zone 도입은 콘텐츠 분리이지 런타임 모델 변경이 아니다.**
- 룸은 zone 태그(`room.zone`)를 자동으로 받는다. 추후 zone 단위 쿼리(브로드캐스트, 필터, 통계)에 쓸 수 있다.

## 모듈 스키마

```js
// server/zones/<id>.js
export default {
  id: 'forest',                         // 고유 zone id (소문자, 영문)
  name: '동쪽 숲',                       // 표시용. 디버그/로그/추후 UI에 사용
  rooms:   { /* roomId -> roomDef */ }, // 룸 정의
  objects: { /* objKey -> objDef */ },  // 룸이 참조하는 오브젝트 정의
  spawns:  [ { roomId, defId } ],        // 초기 몬스터 스폰 (선택)
};
```

### `rooms`

룸 사전. 키는 글로벌 유일 룸 id, 값은:

```js
{
  name: '광장',
  desc: '돌로 포장된 넓은 광장이다.',
  exits: { north: 'market', east: 'temple' },
  objects: ['fountain', 'crystal'],
}
```

- 룸 생성 방식은 zone 내부 자유다 — 손으로 쓰든, 그리드 제너레이터로 만들든, 외부 JSON을 로드하든 모듈이 export 시점에 완성된 사전을 들고 있으면 된다.
- 출구 값은 **다른 zone의 룸 id를 가리켜도 된다**. zone 간 연결은 양쪽이 각자 자기 출구를 선언하는 식으로 양방향을 만든다(예: `temple.east = 'forest_0_0'`, `forest_0_0.west = 'temple'`).
- 로더가 `id`와 `zone` 필드를 자동 부착하므로 zone 정의에는 쓰지 않는다.

### `objects`

zone-local 오브젝트 정의. 머지 후 글로벌 `OBJECTS`에 들어가므로 **키는 글로벌 유일**해야 한다(중복 시 로더가 throw). 값은 기존 `OBJECTS` 스키마와 동일:

```js
{ name, desc, view? }
```

오브젝트가 여러 zone에서 공유될 일이 생기면 `server/zones/_shared/` 같은 자리로 옮기는 것을 검토 — 지금은 그런 케이스가 없다.

### `spawns`

초기 몬스터 스폰. `Game._spawnMonsters()`가 부팅 시 한 번 소화한다.

```js
spawns: [
  { roomId: 'market', defId: 'goblin' },
]
```

- `defId`는 `MONSTER_DEFS`의 키. 모르는 키면 로더가 throw 해도 되고 게임 시작 시점에 죽어도 된다 — 일찍 깨지게 두는 쪽이 운영상 안전.
- 리스폰은 zone과 무관하다. 죽은 몬스터는 같은 룸에 다시 스폰되며 타이밍은 `MONSTER_RESPAWN_MS[tier]`(`server/config.js`)가 결정한다.

## 로더 동작 (`server/zones/index.js`)

```js
import town from './town.js';
import forest from './forest.js';

const ZONES = [town, forest];

export function loadZones() { /* ... */ }
```

로더의 책임은 단순하다:

1. zone 배열을 순회하며 `rooms`/`objects`를 글로벌 사전에 머지.
2. 룸 id 또는 오브젝트 키 충돌 시 **즉시 throw** — 조용한 덮어쓰기는 디버깅을 어렵게 한다.
3. 각 룸에 `id`(키와 동일)와 `zone`(소속 zone id)을 자동 부착.
4. `spawns`를 단일 배열로 평탄화해 반환.

`game.js`는 부팅 시 한 번 호출:

```js
const { rooms: ROOMS, objects: OBJECTS, spawns: INITIAL_SPAWNS } = loadZones();
```

이후 로직은 변경 없음 — 기존과 똑같이 `ROOMS[id]`, `OBJECTS[key]`로 룩업한다.

## 새 zone 추가하기

1. `server/zones/<id>.js`를 만든다. 위 스키마대로 default export.
2. `server/zones/index.js`의 `ZONES` 배열에 import & 추가.
3. 다른 zone과 연결하고 싶으면 양쪽 룸의 `exits`에 서로의 룸 id를 넣는다.

서버 코드(`game.js`)나 클라이언트는 손대지 않는다. 콘텐츠만 늘리면 된다.

## 기존 룸을 다른 zone으로 옮길 때

- 룸 id 자체를 바꾸지 말 것. 다른 zone의 출구가 문자열로 그 id를 가리킬 가능성이 있다.
- zone을 옮기는 것은 파일 이동에 불과하다 — 콘텐츠 동작은 그대로.

## 안 하는 것 (의도적 비-목표)

- **Zone 클래스/상속 도입 안 함.** zone에 공유 동작이 생기기 전까지는 빈 추상화일 뿐이다. 동작이 필요해지는 시점(예: zone 진입 이벤트, zone-wide 날씨)에 다시 검토.
- **zone별 별도 OBJECTS 네임스페이스 도입 안 함.** 현재는 글로벌 단일 사전이 충분하다. 키 충돌이 잦아지면 그때 zone 프리픽스 규약(`forest_signpost`처럼)을 강제할 수 있다.
- **런타임 zone 추가/제거 안 함.** zone은 부팅 시 정적으로 결정된다. 동적 던전이 생기면 별도 메커니즘으로 다룬다.

## 변경 이력

- 초기 도입: `town`, `forest` 두 zone으로 분리. 기존 `game.js` 인라인 `ROOMS`/`OBJECTS`/`_spawnMonsters` 하드코딩을 zone 모듈로 이동.
