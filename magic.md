# magic.md — 마법 시스템

마법사(`klass='mage'`) 전용 자원·명령 체계. 마나(MP)를 소모해 element
타입의 데미지를 가하는 단일 타겟 액션이 기본.

서버 단일 진실원: `server/game.js` 의 `SPELL_DEFS`. 클라이언트는 status
페이로드의 `spells[]` 배열로 자기 캐릭터가 시전 가능한 마법 목록을 받는다.

---

## 마법 매트릭스

| id                 | 한국어 이름   | minLevel | mpCost | dmg(min~max) | element     | 색상 #RGB |
|--------------------|---------------|----------|--------|--------------|-------------|-----------|
| `fireball`         | 파이어볼      | 10       | 8      | 15~25        | `fire`      | `#ff6b35` |
| `ice_arrow`        | 아이스 애로우 | 11       | 10     | 20~28        | `ice`       | `#6dd5ed` |
| `lightning`        | 번개          | 12       | 14     | 25~36        | `lightning` | `#f7e07c` |
| `skeleton_warrior` | 해골 전사     | 13       | 20     | 32~46        | `dark`      | `#b289ff` |
| `meteor`           | 메테오        | 14       | 32     | 55~80        | `meteor`    | `#ff4848` |

각 마법은 한국어/영문 alias 를 함께 갖는다(예: 파이어볼 = `fireball` =
화염구). alias 정의는 `SPELL_DEFS[id].aliases`.

**최종 데미지:** `random(min~max) + floor((player.level - minLevel) / 2)`.
레벨 보너스는 후반 마법에 비례 가중되지 않도록 의도적으로 작게.

---

## 시전 절차 (서버)

`Game.castSpell(player, spellId, arg)` 가 게이트를 순서대로 검사:

1. `klass === 'mage'` — 아니면 「마법은 마법사만 시전할 수 있습니다.」
2. `level >= spell.minLevel` — 미달이면 「{이름} — 레벨 N 이상 필요」
3. `mp >= spell.mpCost` — 부족이면 현재/필요 표시
4. 공격 쿨다운(`ATTACK_COOLDOWN_MS`) 공유 — 마법으로 공격 쿨다운 우회 방지
5. 대상 해소 — 같은 방의 살아있는 몬스터, attack 과 동일한 매칭 규칙
6. mp 차감 → 데미지 적용 → 처치 시 `_grantExp` 로 경험치 → 미처치면 반격

마법 데미지의 segment cls 는 `tx-dmg-${spell.element}` 로 보낸다. 클라이언트는
이 클래스를 element 별 고유 RGB 로 렌더링(아래 「색상」 절).

같은 몬스터를 교전 중인 다른 플레이어들에게도 「{시전자}의 {마법명}이(가) …
{데미지}의 피해를 입혔다」 형식으로 동일한 element 색을 입혀 동시 송출 —
공격 패턴과 동일한 broadcast 모델.

---

## 입력 파싱 (PC / 모바일)

### PC — 텍스트 입력

마법 이름이 다단어("해골 전사")가 흔해 첫 단어 토큰화로는 깨진다. 그래서
디스패처보다 먼저 `_matchSpellPrefix(input)` 가 입력 전체를 등록된 마법
이름·alias 와 prefix-match 한다. 매칭되면:

- `cmd = 'cast'`, `arg = '<spellId> <rest>'` 형태로 `castSpell` 직행.
- 더 긴 alias 가 짧은 alias 의 prefix 일 때 긴 쪽을 우선(길이 내림차순 정렬).

예시 입력 → 시전:

```
파이어볼 고블린        → fireball, target='고블린'
해골 전사 해골 전사    → skeleton_warrior, target='해골 전사' (몬스터 이름)
시전 메테오 비룡       → meteor, target='비룡'
```

명시적 `시전`/`cast` 명령도 같은 prefix matcher 를 한 번 더 돌리므로
어떤 alias 든 받아 준다.

### 모바일 — 마법 메뉴

액션 패드 루트에 **마법** 카테고리 버튼이 노출되는 조건:

- `currentSpells.length > 0` — server status 가 spell 목록을 비어 있지 않게 보냄
- 같은 방에 시전 가능한 몬스터 1마리 이상 존재

플로우:

1. 마법 탭 → 시전 가능한 마법 리스트(이름·MP 비용 표시)
2. 마법 선택 → 같은 방 몬스터 리스트
3. 몬스터 선택 → `<마법명> <대상>` 명령 송출 + 루트로 복귀

각 단계는 ↩ 버튼으로 한 단계 뒤로. spell 버튼은 `action-spell-<element>`
클래스로 element 색이 입혀져 시각적 구분 — 데미지 색과 짝을 이뤄 인식
일관성을 유지(파이어볼 버튼 = 주황 = 파이어볼 데미지 색).

---

## 색상 (Themeable 아님)

마법 데미지 색은 의도적으로 테마 변수를 쓰지 않는다 — element 가 곧
정체성이다(불은 어느 테마에서도 주황). `public/style.css` 의 `tx-dmg-*`
규칙 직접 RGB:

| element     | 색상      | 효과                                  |
|-------------|-----------|---------------------------------------|
| `fire`      | `#ff6b35` | 주황 + 약한 글로우                    |
| `ice`       | `#6dd5ed` | 청록 + 약한 글로우                    |
| `lightning` | `#f7e07c` | 노랑 + 진한 글로우                    |
| `dark`      | `#b289ff` | 보라 + 글로우(소환술/네크로 톤)       |
| `meteor`    | `#ff4848` | 적색 + 더 굵은 폰트 + 진한 글로우     |

새 element 추가 시:

1. `SPELL_DEFS` 엔트리에 `element: '<new>'` 지정.
2. `style.css` 에 `#log .tx-dmg-<new>` 규칙 한 줄 추가.
3. 모바일 메뉴 색을 짝 맞추려면 `.action-btn.action-spell-<new>` 도 추가.
4. 본 문서의 색상 매트릭스에 한 줄 추가.

---

## 마나 회복

`Game._regenTick` 에서 3초마다 마법사 한정으로 MP +1. 만렙(maxMp)에 도달
하면 자동 정지(틱 비용 0). 변동이 있으면 그 플레이어에게만 `pushStatus` —
1k 동시 접속에서도 「부족 상태인 마법사 수」 만큼만 비용이 든다.

전투/사망/이동 등 어떤 이벤트에서도 MP 자체는 자동 소비되지 않는다.
시전 명령이 유일한 소비 경로.

---

## 새 마법 추가 절차

1. `server/game.js` 의 `SPELL_DEFS` 에 엔트리 추가(name/aliases/minLevel/
   mpCost/dmg/element/castVerb).
2. element 가 새 종류면 `style.css` 에 `tx-dmg-<element>` + 모바일
   `action-spell-<element>` 규칙 추가.
3. 본 문서의 마법/색상 매트릭스에 한 줄씩 추가.
4. (선택) 레벨업 시 새 마법이 해금되도록 minLevel 을 EXP_TABLE 의 레벨
   임계와 맞추면 「새 마법을 익혔다」 안내가 자연스럽게 나온다.

별도의 클라이언트 코드 변경은 필요 없다 — `pushStatus` 가 spells[] 를
권위로 보내고, 모바일 메뉴는 그 배열을 그대로 그린다.
