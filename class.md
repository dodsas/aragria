# class.md — 직업 시스템

Agria 의 모든 캐릭터는 직업(`klass`)을 가진다. 직업은 캐릭터의 자원
풀(MP), 사용 가능한 명령(예: 마법 시전), 성장 곡선을 결정한다.

직업 정의는 서버 단일 진실원: `server/game.js` 의 `CLASS_DEFS`. 클라이언트는
`status.klass` / `status.klassName` 을 받아 사이드바 캐릭터 블록과 모바일
액션 패드의 카테고리 노출 여부를 결정한다.

---

## 직업 매트릭스

| id        | 표시명   | mpAtLv1 | mpPerLv | 비고                                    |
|-----------|----------|---------|---------|------------------------------------------|
| `novice`  | 초보자   | 0       | 0       | 기본 직업. 입장 시 모두 novice.          |
| `mage`    | 마법사   | 30      | 5       | 광장 + 레벨 10 + novice 한정 전직 가능. |

**maxMp 공식:** `mpAtLv1 + (level - 1) * mpPerLv` — `classMaxMp(klass, level)`
한 곳에서 계산된다.

**maxHp 공식:** 직업과 무관하게 `100 + 10 * (level - 1)` — `classMaxHp(_, level)`.
직업별 HP 차이가 필요해지면 `CLASS_DEFS` 엔트리에 hp 필드를 추가하면 된다.

---

## 전직 규칙

세 조건이 모두 충족되어야 `전직 <직업>` 명령이 통과한다:

1. `player.klass === 'novice'` — 이미 전직한 캐릭터는 재전직 불가.
2. `player.level >= 10` — 임계 미달이면 시스템 라인으로 거부 사유 안내.
3. `player.roomId === 'square'` — 광장(town/square) 외 다른 방에서는 거부.

성공 시:

- `klass` 갱신.
- `maxHp / maxMp` 재계산 → `hp / mp` 가득 채움(전직 보상 회복).
- 시스템 라인: 「{직업명}로 전직했다. 광장의 마법진이 푸르게 타오른다.」
- 같은 방의 다른 플레이어에게 브로드캐스트 라인 송출.
- 마법사로 전직 시 첫 마법(레벨 10 해금) 안내 라인 한 줄.

명령 진입점: `Game.changeClass(player, raw)` (server/game.js).
허용 입력: `전직 마법사`, `전직 mage`, `class 마법사`, `class mage` 등.

---

## 레벨 / 경험치

`server/game.js` 의 `EXP_TABLE` 이 누적 경험치 임계 표(인덱스 = 레벨-1).
현재 캡 = `MAX_LEVEL = 15`.

| Lv | 누적 EXP | 누적 EXP 차 |
|----|----------|-------------|
| 1  | 0        | -           |
| 2  | 100      | 100         |
| 5  | 520      | 160         |
| 10 | 1620     | 260         |
| 15 | 3720     | 460         |

처치 보상은 `MONSTER_DEFS[def].expReward`. 마지막 일격을 가한 한 명만
`_grantExp` 를 통해 받는다(킬스틸 패시브 분배 없음). 누적 exp 가 다음 임계를
넘으면 자동 레벨업:

- `maxHp / maxMp` 재계산.
- `hp / mp` 가득 채움.
- 「▲ 레벨 N 달성」 시스템 라인.
- 새로 해금된 마법이 있으면 「새 마법을 익혔다 — 파이어볼」 한 줄씩.
- 레벨 10 도달 + novice + 광장 위치면 전직 안내 라인 추가.

레벨 캡(`MAX_LEVEL`)을 넘는 exp 누적은 무시 — `EXP_TABLE` 길이를 늘리면
캡이 자동으로 따라 올라간다.

---

## 새 직업 추가 절차

1. `server/game.js` 의 `CLASS_DEFS` 에 엔트리 추가(name/desc/mpAtLv1/mpPerLv).
2. `Game.changeClass` 의 허용 키 매핑(`map`)에 한국어 직업명/영문 id 등록.
3. 직업 고유 명령(예: 마법사의 spell 시전, 전사의 광폭화 등)은 별도 명령
   메서드를 만들고 `handleCommand` 디스패처에 추가. spell 처럼 다단어
   명령이 필요하면 prefix matcher(`_matchSpellPrefix` 패턴)를 참고.
4. 본 문서의 직업 매트릭스 표에 한 줄 추가.
5. UI 가 직업별로 분기되어야 한다면(예: 마나 행 노출), 클라이언트
   `renderStatus` 에서 `status.klass` / `maxMp` 분기로 처리.

---

## 클라이언트 표시

사이드바 캐릭터 블록(`#character-stats`)이 다음을 보여 준다:

- 직업 (klassName)
- 레벨 (Lv. N)
- 체력 바 — 항상 표시
- 마나 바 — `maxMp > 0` 일 때만 표시(novice 는 자동 숨김)
- 경험치 바 — 만렙은 「MAX」 텍스트로 고정
- 전직 안내 — `canChangeClass=true` 일 때 강조 박스 노출

`canChangeClass` 는 서버에서 권위 계산 후 보내준다(클라가 광장 좌표/레벨을
알 필요 없도록). 클라는 단순히 boolean 만 보고 박스를 켜고 끈다.
