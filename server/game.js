// Authoritative game state. Single in-memory world.
// All commands flow through Game.handleCommand(player, input).

import {
  MONSTER_RESPAWN_MS, DEFAULT_MONSTER_TIER, MONSTER_REGEN_TICK_MS,
  ATTACK_COOLDOWN_MS, MOVE_COOLDOWN_MS, KILLSTEAL_MOVE_BLOCK_MS,
  INPUT_MAX_LEN, SAY_MAX_LEN, SAY_COOLDOWN_MS,
  CMD_RATE_PER_SEC, CMD_BURST, RECONNECT_GRACE_MS,
  NAME_MAX_LEN, NAME_MIN_LEN, DESC_MAX_LEN, DESC_MIN_LEN,
  REGISTRATION_ENABLED, AUTO_REGISTER_DESC,
} from './config.js';
import { loadZones } from './zones/index.js';
import { generateCharacterSprite, getDefaultCharacterSprite } from './sprite.js';
import { saveCharacterFor, getCharacterFor } from './store.js';

let nextPlayerId = 1;

// Canonical exit keys remain English in zone definitions; we localize only at
// the presentation boundary so room data stays language-neutral.
const DIR_LABEL = { north: '북', south: '남', east: '동', west: '서' };

// 룸/오브젝트/초기 스폰 콘텐츠는 zone 모듈에 분리되어 있다(server/zones/, zone.md).
// 부팅 시 한 번 머지하여 글로벌 사전을 만든다. 룩업 모델은 그대로 — ROOMS[id], OBJECTS[key].
const { rooms: ROOMS, objects: OBJECTS, spawns: INITIAL_SPAWNS } = loadZones();

// Monster definitions. `tier` controls respawn timing (see config.js).
// Tier 1 = lowest. Higher tiers can be added later with their own respawn ranges.
// hpRegen은 초당 자가 회복량. 0이면 회복 없음. 회복은 전투 중에도 적용되며,
// 모든 동일 룸 플레이어에게 동기 브로드캐스트된다(monster.md 회복 절 참조).
// expReward는 처치 보상 — 마지막 일격을 가한 플레이어 한 명만 받는다.
const MONSTER_DEFS = {
  goblin: {
    tier: 1,
    name: '고블린',
    icon: '🧌',
    desc: '작고 교활한 눈빛의 녹색 생명체. 녹슨 단검을 들고 있다.',
    hp: 20, maxHp: 20, atk: 5, hpRegen: 1,
    expReward: 30,
    // 처치 시 각 엔트리 별 chance(0~1) 만큼 인벤토리로 자동 지급. 순서·중복
    // 무관 — 각 drop 은 독립 베르누이 시행. equipment.md 드랍 매트릭스 참조.
    drops: [{ id: 'goblin_dagger', chance: 0.10 }],
  },
  skeleton: {
    tier: 1,
    name: '해골 전사',
    icon: '☠',
    desc: '낡은 갑옷을 입은 뼈만 남은 전사. 텅 빈 눈구멍에서 붉은 빛이 흔들린다.',
    hp: 35, maxHp: 35, atk: 8, hpRegen: 1,
    expReward: 60,
    drops: [
      { id: 'bone_helmet', chance: 0.08 },
      { id: 'bone_sword',  chance: 0.05 },
    ],
  },
  dragon: {
    tier: 2,
    name: '검은 비룡',
    icon: '🐉',
    desc: '숲 속 검은 제단에서 깨어난 비룡. 그을음으로 새카만 비늘 사이로 노란 눈이 어둠을 가른다.',
    hp: 120, maxHp: 120, atk: 18, hpRegen: 3,
    expReward: 800,
    drops: [
      { id: 'dragon_scale', chance: 0.06 },
      { id: 'dragon_fang',  chance: 0.04 },
    ],
  },
  red_dragon: {
    tier: 2,
    name: '붉은 비룡',
    icon: '🐲',
    desc: '부서진 사당에 둥지를 튼 비룡. 비늘은 잿불처럼 붉고, 콧김에서 마른 연기가 새어나온다.',
    hp: 100, maxHp: 100, atk: 22, hpRegen: 3,
    expReward: 600,
    drops: [
      { id: 'flame_cloak', chance: 0.06 },
      { id: 'flame_blade', chance: 0.04 },
    ],
  },
};

// 직업 정의. novice 는 갓 입장한 모든 캐릭터의 기본 직업이고, 마법사는
// 광장에서 레벨 10 도달 시 전직할 수 있는 첫 번째 분기. 새 직업을 추가할 때는
// (1) 여기에 엔트리를 만들고 (2) class.md 직업 매트릭스에 한 줄 추가 +
// (3) 필요하면 changeClass 의 허용 키 목록을 확장한다.
const CLASS_DEFS = {
  novice: {
    name: '초보자',
    desc: '아직 길을 정하지 않은 풋내기.',
    // maxMp = mpAtLv1 + (level - 1) * mpPerLv. novice 는 마나 자원을 못 쓴다.
    mpAtLv1: 0,
    mpPerLv: 0,
  },
  mage: {
    name: '마법사',
    desc: '광장의 마법진에서 마나의 길을 받아들인 자.',
    mpAtLv1: 30,
    mpPerLv: 5,
  },
};

// 마법 정의. 클라이언트가 모르는 단일 진실원이며, 입력은 (1) 텍스트(파이어볼 …)
// (2) 모바일 마법 메뉴 양쪽에서 동일하게 cmd 'cast <spellId>' 형태로 도착한다
// (multi-word 한국어 이름이 첫 단어 토큰화에 깨지지 않도록 _matchSpellPrefix가
// 입력을 사전에 흡수해 표준 cmd 로 갈아끼운다 — magic.md 참조).
//
// element는 client tx-dmg-<element> CSS 클래스와 짝을 이룬다. 새 element 를
// 추가하면 magic.md 와 style.css 의 색상 매트릭스를 같이 갱신할 것.
const SPELL_DEFS = {
  fireball: {
    name: '파이어볼',
    aliases: ['fireball', '화염구', '파이어 볼'],
    minLevel: 10,
    mpCost: 8,
    dmg: [15, 25],
    element: 'fire',
    castVerb: '화염구를 쏘아',
  },
  ice_arrow: {
    name: '아이스 애로우',
    aliases: ['ice arrow', 'ice_arrow', '얼음 화살', '아이스애로우', '서리 화살'],
    minLevel: 11,
    mpCost: 10,
    dmg: [20, 28],
    element: 'ice',
    castVerb: '서리 화살을 날려',
  },
  lightning: {
    name: '번개',
    aliases: ['lightning', '전격', 'thunder', '낙뢰'],
    minLevel: 12,
    mpCost: 14,
    dmg: [25, 36],
    element: 'lightning',
    castVerb: '백색 번개를 내리꽂아',
  },
  skeleton_warrior: {
    name: '해골 전사',
    aliases: ['skeleton warrior', 'skeleton_warrior', '본 워리어', '뼈 전사', '해골전사'],
    minLevel: 13,
    mpCost: 20,
    dmg: [32, 46],
    element: 'dark',
    castVerb: '소환된 해골 전사가 달려들어',
  },
  meteor: {
    name: '메테오',
    aliases: ['meteor', '운석', '유성', '운석우'],
    minLevel: 14,
    mpCost: 32,
    dmg: [55, 80],
    element: 'meteor',
    castVerb: '하늘에서 운석을 떨어뜨려',
  },
};

// 누적 경험치 테이블. EXP_TABLE[lv-1] = 레벨 lv 가 되기 위한 누적 경험치.
// 1레벨은 0 부터 시작. 표 길이가 곧 레벨 캡(현재 30).
// 분기 기준이 되는 10레벨 지점은 1620 — 고블린(30)/해골(60) 기준 약 27마리.
// 11~15 구간은 Δ가 380→400→420→440→460 으로 +20 씩 늘어나는 산술 progression
// 이라 그대로 30 까지 연장(+480, +500, ..., +760). 만렙 도달 비용 13020.
const EXP_TABLE = [
  0,        // L1
  100,      // L2
  220,      // L3
  360,      // L4
  520,      // L5
  700,      // L6
  900,      // L7
  1120,     // L8
  1360,     // L9
  1620,     // L10  ← 전직 가능
  2000,     // L11
  2400,     // L12
  2820,     // L13
  3260,     // L14
  3720,     // L15
  4200,     // L16
  4700,     // L17
  5220,     // L18
  5760,     // L19
  6320,     // L20
  6900,     // L21
  7500,     // L22
  8120,     // L23
  8760,     // L24
  9420,     // L25
  10100,    // L26
  10800,    // L27
  11520,    // L28
  12260,    // L29
  13020,    // L30
];
const MAX_LEVEL = EXP_TABLE.length;

function levelFromExp(exp) {
  // 누적 exp 를 받아 현재 레벨을 돌려준다. 표 끝을 넘어가면 MAX_LEVEL 에 고정.
  let level = 1;
  for (let i = 0; i < EXP_TABLE.length; i++) {
    if (exp >= EXP_TABLE[i]) level = i + 1;
    else break;
  }
  return level;
}
function classMaxHp(/* klass */ _klass, level) {
  // 직업에 무관한 공통 HP 성장. 미세 차이가 필요해지면 직업 정의로 빼면 된다.
  return 100 + 10 * (level - 1);
}
function classMaxMp(klass, level) {
  const def = CLASS_DEFS[klass] || CLASS_DEFS.novice;
  return def.mpAtLv1 + (level - 1) * def.mpPerLv;
}

let nextMonsterId = 1;
function spawnMonster(defId) {
  const def = MONSTER_DEFS[defId];
  return {
    id: nextMonsterId++,
    defId,
    name: def.name,
    icon: def.icon,
    hp: def.hp,
    maxHp: def.maxHp,
    atk: def.atk,
    tier: def.tier ?? DEFAULT_MONSTER_TIER,
    // 초당 자가 회복량. 정의에서 미지정이면 0으로 떨어져 회복 비활성화.
    hpRegen: def.hpRegen ?? 0,
  };
}

// 모든 아이템(소비/장비/잡템)의 단일 정의 사전. 인벤토리·장비 슬롯에는 이
// 정의의 스냅샷(makeItem)이 들어가 — ITEM_DEFS 의 stat 가 나중에 바뀌어도
// 이미 든 아이템의 능력치는 그대로 유지된다(보존성을 의도). 새 아이템은
// 여기에 한 줄 추가하고 equipment.md 에 등록.
//   kind: 'equip' | 'consume' | 'misc'
//   slot: 'head' | 'body' | 'weapon' | 'offhand' | 'feet'  (equip 만)
//   attack / defense: equip 의 능력치 보너스(없으면 0).
const ITEM_DEFS = {
  // 소비/잡템
  potion_hp: { id: 'potion_hp', name: '체력 물약', icon: '❦', kind: 'consume' },
  bread:     { id: 'bread',     name: '빵',        icon: '⌬', kind: 'consume' },
  rope:      { id: 'rope',      name: '밧줄',      icon: '∽', kind: 'misc' },

  // 시작 장비
  short_sword: { id: 'short_sword', name: '단검',       icon: '†', kind: 'equip', slot: 'weapon', attack: 5 },
  tunic:       { id: 'tunic',       name: '낡은 튜닉',  icon: '⛊', kind: 'equip', slot: 'body',   defense: 1 },
  boots:       { id: 'boots',       name: '가죽 부츠',  icon: '⛢', kind: 'equip', slot: 'feet',   defense: 1 },

  // 몬스터 드랍 — 등급은 티어에 비례. 능력치는 시작 장비 대비 점진적.
  goblin_dagger: { id: 'goblin_dagger', name: '고블린의 단검',     icon: '⚔',  kind: 'equip', slot: 'weapon', attack: 8 },
  bone_helmet:   { id: 'bone_helmet',   name: '뼈 투구',           icon: '⛑',  kind: 'equip', slot: 'head',   defense: 3 },
  bone_sword:    { id: 'bone_sword',    name: '뼈 검',             icon: '🦴', kind: 'equip', slot: 'weapon', attack: 11 },
  dragon_scale:  { id: 'dragon_scale',  name: '비룡 비늘 갑옷',    icon: '⛉',  kind: 'equip', slot: 'body',   defense: 12 },
  dragon_fang:   { id: 'dragon_fang',   name: '비룡 송곳니 검',    icon: '🗡', kind: 'equip', slot: 'weapon', attack: 18 },
  flame_cloak:   { id: 'flame_cloak',   name: '불꽃 망토',         icon: '🜲', kind: 'equip', slot: 'body',   defense: 10 },
  flame_blade:   { id: 'flame_blade',   name: '불꽃 검',           icon: '🔥', kind: 'equip', slot: 'weapon', attack: 16 },
};

// 정의의 스냅샷 한 벌을 만들어 player 인벤토리/장비 슬롯에 들어갈 수 있게.
// 펼친 복사라 나중에 ITEM_DEFS 가 바뀌어도 기존 보유분의 능력치는 영향 없음.
function makeItem(id, qty = 1) {
  const def = ITEM_DEFS[id];
  if (!def) return null;
  return { ...def, qty };
}

const STARTING_EQUIPMENT = () => ({
  head: null,
  body: makeItem('tunic'),
  weapon: makeItem('short_sword'),
  offhand: null,
  feet: makeItem('boots'),
});

const STARTING_INVENTORY = () => ([
  makeItem('potion_hp', 10),
  makeItem('bread', 2),
  makeItem('rope', 1),
]);

const ITEM_USE = {
  potion_hp: (player) => {
    const heal = Math.min(30, player.maxHp - player.hp);
    player.hp += heal;
    return heal > 0
      ? `체력 물약을 마셨다. 체력이 ${heal} 회복됐다. (${player.hp}/${player.maxHp})`
      : `체력이 이미 가득 찼다. (${player.hp}/${player.maxHp})`;
  },
};

export class Game {
  constructor() {
    this.players = new Map();
    // sid → player. Lets a reconnect within RECONNECT_GRACE_MS rebind to the
    // same in-world player object so penalties (kill-steal block, low HP,
    // active combat target) survive a socket close.
    this.sidToPlayer = new Map();
    // naverId → player. 인증된 사용자는 sid 와 무관하게 한 명의 살아 있는
    // player 객체로 키잉된다. 다른 디바이스에서 같은 계정으로 재로그인 시
    // 기존 디바이스의 sessionToken 이 회전돼 무효가 되고, 새 디바이스의 WS 가
    // 들어오는 순간 이 맵이 1:1 단일성을 보장한다.
    this.naverIdToPlayer = new Map();
    this.roomMonsters = new Map();
    this._spawnMonsters();
    this._startRegenTick();
  }

  // 1초 주기 자가 회복 틱. 회복이 일어난 방에 한해 broadcast하고, 같은
  // 몬스터를 교전 중인 플레이어에게는 combat 패널까지 갱신해 HP 바가 차오르는
  // 모습을 실시간으로 본다. 1k 동시 접속 목표를 고려해 변화 없는 방은 침묵.
  // .unref()로 묶어 테스트/임시 종료 시 프로세스 잔존을 막는다.
  _startRegenTick() {
    const tick = MONSTER_REGEN_TICK_MS;
    const perTickRatio = tick / 1000;
    const interval = setInterval(() => this._regenTick(perTickRatio), tick);
    if (typeof interval.unref === 'function') interval.unref();
  }

  _regenTick(perTickRatio) {
    for (const [roomId, monsters] of this.roomMonsters) {
      let anyChanged = false;
      for (const m of monsters) {
        if (m.dead) continue;
        if (m.hp >= m.maxHp) continue;
        const rate = m.hpRegen || 0;
        if (rate <= 0) continue;
        const before = m.hp;
        // 정수 HP 유지 — round로 누적 오차를 흡수. 작은 rate(1/sec)에서도
        // 최소 1 이상 회복되도록 1초 틱 기준으로는 그대로 정수가 더해진다.
        const next = Math.min(m.maxHp, m.hp + Math.max(1, Math.round(rate * perTickRatio)));
        if (next === before) continue;
        m.hp = next;
        anyChanged = true;
        // 교전 중인 플레이어들에게 combat 패널 갱신 — HP 바가 다시 차오르는
        // 모습이 즉시 반영되도록.
        const engagementKey = `m${m.id}`;
        for (const p of this.players.values()) {
          if (p.combatTargetId !== engagementKey) continue;
          if (p.roomId !== roomId) continue;
          this.pushCombat(p, m, 'monster');
        }
      }
      if (anyChanged) this._pushRoomMonsters(roomId);
    }

    // 플레이어 MP 회복 — 마법사 한정, 1초당 0.33씩 누적해 3초마다 정수 1.
    // 만렙 마법사 1k 명이 모두 부족 상태여도 한 틱당 1k pushStatus(약 200KB
    // 직렬화) 수준으로 1k 동시 접속 목표 안에서 안전. mp 가 가득 찬 플레이어는
    // 틱 비용 0 — Math.min 분기로 push 도 생략된다.
    if (!this._mpRegenAccum) this._mpRegenAccum = 0;
    this._mpRegenAccum += perTickRatio; // perTickRatio 는 초 단위 비율(1.0=1초)
    if (this._mpRegenAccum >= 3) {
      this._mpRegenAccum = 0;
      for (const p of this.players.values()) {
        if (!p.registered || p.disconnectedAt != null) continue;
        if (p.klass !== 'mage') continue;
        if (p.mp >= p.maxMp) continue;
        p.mp = Math.min(p.maxMp, p.mp + 1);
        this.pushStatus(p);
      }
    }
  }

  // 같은 방의 모든 플레이어(교전·비교전 무관)에게 현재 룸 스냅샷을 보낸다.
  // monsters는 HP 바 갱신용, objects/players는 모바일 액션 패드의 대상 선택
  // 서브메뉴 채우기용. dead 플래그가 선 항목은 splice 예정이라 제외해 패널이
  // 깜빡이지 않도록 하고, players는 수신자별로 self를 제외해 자기 자신을
  // "봐" 대상에서 제외한다.
  _buildRoomPayload(roomId, forPlayerId) {
    const list = this.roomMonsters.get(roomId) || [];
    const monsters = [];
    for (const m of list) {
      if (m.dead) continue;
      monsters.push({
        id: m.id, defId: m.defId, name: m.name, icon: m.icon,
        hp: Math.max(0, m.hp), maxHp: m.maxHp,
      });
    }
    const room = ROOMS[roomId];
    const objects = (room?.objects || [])
      .map(id => ({ id, name: OBJECTS[id]?.name }))
      .filter(o => o.name);
    const players = [];
    for (const o of this.players.values()) {
      if (o.id === forPlayerId) continue;
      if (!o.registered || o.disconnectedAt != null) continue;
      if (o.roomId !== roomId) continue;
      players.push({ id: o.id, name: o.name });
    }
    return { type: 'room_monsters', roomId, monsters, objects, players };
  }

  _pushRoomMonsters(roomId) {
    for (const p of this.players.values()) {
      if (p.roomId !== roomId || !p.registered || p.disconnectedAt != null) continue;
      this.send(p, this._buildRoomPayload(roomId, p.id));
    }
  }

  _spawnMonsters() {
    // 초기 스폰은 zone 모듈의 spawns 선언에서 온다(zone.md 참조).
    for (const { roomId, defId } of INITIAL_SPAWNS) {
      const list = this.roomMonsters.get(roomId) || [];
      list.push(spawnMonster(defId));
      this.roomMonsters.set(roomId, list);
    }
  }

  scheduleRespawn(roomId, defId) {
    const def = MONSTER_DEFS[defId];
    if (!def) return;
    const tier = def.tier ?? DEFAULT_MONSTER_TIER;
    const range = MONSTER_RESPAWN_MS[tier] || MONSTER_RESPAWN_MS[DEFAULT_MONSTER_TIER];
    const [minMs, maxMs] = range;
    const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    setTimeout(() => {
      const list = this.roomMonsters.get(roomId) || [];
      list.push(spawnMonster(defId));
      this.roomMonsters.set(roomId, list);
      this.broadcastRoom(roomId, {
        type: 'text',
        segments: [{ text: def.name, cls: 'monster-name' }, { text: '이(가) 나타났다.' }],
      });
      // 새 인스턴스가 추가됐으니 룸 몬스터 패널도 갱신.
      this._pushRoomMonsters(roomId);
    }, delay);
  }

  // Atomic HP application. Node's single-threaded event loop guarantees this
  // synchronous block cannot interleave with another attack handler, so the
  // read-modify-write is race-free. `dead` ensures that even if two attacks
  // arrive in the same tick and both compute hp -> 0, only the first one is
  // treated as the killing blow (kill credit + respawn schedule fire once).
  applyMonsterDamage(monster, damage) {
    if (monster.dead) return { hpBefore: 0, killingBlow: false };
    const hpBefore = monster.hp;
    monster.hp = Math.max(0, hpBefore - damage);
    const killingBlow = monster.hp === 0 && hpBefore > 0;
    if (killingBlow) monster.dead = true;
    return { hpBefore, killingBlow };
  }

  // 장비 슬롯들의 총 공격/방어 합. 능력치 없는 슬롯은 0 으로 떨어져 안전.
  // 매 공격마다 호출되지만 5개 슬롯 순회라 오버헤드 무시 수준.
  _totalAttack(player) {
    let a = 0;
    for (const k of Object.keys(player.equipment)) {
      const it = player.equipment[k];
      if (it?.attack) a += it.attack;
    }
    return a;
  }
  _totalDefense(player) {
    let d = 0;
    for (const k of Object.keys(player.equipment)) {
      const it = player.equipment[k];
      if (it?.defense) d += it.defense;
    }
    return d;
  }

  // 인벤토리에 아이템을 더한다. 같은 id 가 이미 있으면 qty 누적, 없으면
  // 새 엔트리로 push. 장비도 일단 인벤토리에 들어가 — 곧바로 장착되지
  // 않는다(equip 명령 또는 모바일 인벤토리 클릭으로 사용자가 직접 장착).
  _addToInventory(player, item) {
    if (!item) return;
    const inc = item.qty || 1;
    const existing = player.inventory.find(it => it.id === item.id);
    if (existing) {
      existing.qty = (existing.qty || 1) + inc;
      return;
    }
    // 새 엔트리는 정의 스냅샷을 그대로 — 능력치(`attack`/`defense`)도 함께
    // 복사돼 인벤토리 표시·장착 시점 능력치가 즉시 정확.
    player.inventory.push({ ...item, qty: inc });
  }

  // 처치 시 몬스터 정의의 drops 를 베르누이 시행으로 굴려 인벤토리로 지급.
  // 마지막 일격을 가한 한 명만 호출자(killing blow path)에서 받게 되어 있어
  // 킬스틸·드랍 분배 정책이 자연스럽게 통일된다(monster.md / equipment.md).
  _rollDrops(player, defId) {
    const def = MONSTER_DEFS[defId];
    const drops = def?.drops || [];
    for (const d of drops) {
      if (Math.random() >= d.chance) continue;
      const item = makeItem(d.id, d.qty || 1);
      if (!item) continue;
      this._addToInventory(player, item);
      this.send(player, { type: 'system', text: `★ ${item.name} 획득!` });
    }
  }

  // 처치 보상으로 경험치를 지급하고 누적 경험치가 다음 레벨 임계를 넘으면
  // 자동으로 레벨업 처리한다. 레벨업은 maxHp/maxMp 를 직업 공식대로 다시
  // 계산해 그 값으로 hp/mp 를 가득 채워주는 회복 보상을 함께 준다. 새로
  // 해금되는 마법이 있으면 시스템 라인으로 공지. status 푸시는 마지막에
  // 한 번만 — 같은 틱에 여러 번 보내지 않는다.
  _grantExp(player, amount) {
    if (!amount || amount <= 0) return;
    if (player.level >= MAX_LEVEL) {
      // 레벨 캡 도달 시 경험치 누적도 멈춘다 — 표 바깥으로 무한히 늘어나는
      // 의미가 없다. 캡 확장은 EXP_TABLE 길이를 늘리는 것으로 충분.
      return;
    }
    const before = player.level;
    player.exp += amount;
    this.send(player, { type: 'system', text: `${amount} 경험치를 얻었다. (${player.exp})` });
    const after = Math.min(MAX_LEVEL, levelFromExp(player.exp));
    if (after > before) {
      player.level = after;
      player.maxHp = classMaxHp(player.klass, after);
      player.maxMp = classMaxMp(player.klass, after);
      player.hp = player.maxHp;
      player.mp = player.maxMp;
      this.send(player, { type: 'system', text: `▲ 레벨 ${after} 달성! 체력과 마나가 가득 찼다.` });
      // 새로 해금된 마법 안내 (마법사 한정)
      if (player.klass === 'mage') {
        for (const [, spell] of Object.entries(SPELL_DEFS)) {
          if (spell.minLevel > before && spell.minLevel <= after) {
            this.send(player, { type: 'system', text: `새 마법을 익혔다 — ${spell.name}` });
          }
        }
      }
      // 레벨 10 도달 + novice 인 경우 광장 전직 안내
      if (before < 10 && after >= 10 && player.klass === 'novice' && player.roomId === 'square') {
        this.send(player, { type: 'system', text: '광장의 마법진이 빛난다. `전직 마법사` 명령으로 마법사가 될 수 있다.' });
      }
    }
    this.pushStatus(player);
    // 경험치/레벨이 바뀐 사이클의 끝에 한 번만 영속 — store 가 디바운스로 묶어
    // 같은 틱 안에 여러 번 호출돼도 디스크 I/O 는 한 번.
    this._persistPlayer(player);
  }

  // 광장에서 레벨 10 이상의 novice 만 직업을 바꿀 수 있다. 현재는 마법사 한
  // 갈래만 분기로 열려 있다 — 새 직업이 들어오면 허용 키 매핑을 확장.
  changeClass(player, raw) {
    if (player.klass !== 'novice') {
      return this.send(player, { type: 'system', text: '이미 전직했습니다.' });
    }
    if (player.level < 10) {
      return this.send(player, { type: 'system', text: `전직은 레벨 10부터 가능합니다. (현재 ${player.level})` });
    }
    if (player.roomId !== 'square') {
      return this.send(player, { type: 'system', text: '전직은 광장에서만 가능합니다.' });
    }
    const arg = String(raw || '').trim().toLowerCase();
    // 허용 키: 한국어 직업명 + 영문 id
    const map = { '마법사': 'mage', 'mage': 'mage' };
    const target = map[arg];
    if (!target) {
      const options = Object.entries(CLASS_DEFS)
        .filter(([id]) => id !== 'novice')
        .map(([, def]) => def.name)
        .join(', ');
      return this.send(player, { type: 'system', text: `전직 가능한 직업: ${options}. 사용법: \`전직 마법사\`` });
    }
    player.klass = target;
    player.maxHp = classMaxHp(target, player.level);
    player.maxMp = classMaxMp(target, player.level);
    player.hp = player.maxHp;
    player.mp = player.maxMp;
    const name = CLASS_DEFS[target].name;
    this.send(player, { type: 'system', text: `${name}로 전직했다. 광장의 마법진이 푸르게 타오른다.` });
    this.broadcastRoom('square', { type: 'text', text: `${player.name}님이 ${name}로 전직했다.` }, player.id);
    // 마법사 전직 시 1레벨 마법(파이어볼)이 즉시 해금되므로 안내.
    if (target === 'mage') {
      const firstSpell = Object.values(SPELL_DEFS).find(s => s.minLevel <= player.level);
      if (firstSpell) {
        this.send(player, { type: 'system', text: `첫 마법: ${firstSpell.name} (\`${firstSpell.name} <대상>\`로 시전)` });
      }
    }
    this.pushStatus(player);
    this._persistPlayer(player);
  }

  // PvP analog to applyMonsterDamage. Same atomicity guarantees: synchronous
  // read-modify-write under the single-threaded event loop, and only the call
  // that drives HP from positive to zero returns killingBlow=true. The downed
  // flag mirrors monster.dead — it prevents two simultaneous attacks both
  // claiming the kill (and triggering double-respawn).
  applyPlayerDamage(target, damage) {
    if (target.hp <= 0 || target.downed) return { hpBefore: 0, killingBlow: false };
    const hpBefore = target.hp;
    target.hp = Math.max(0, hpBefore - damage);
    const killingBlow = target.hp === 0 && hpBefore > 0;
    if (killingBlow) target.downed = true;
    return { hpBefore, killingBlow };
  }

  // Public connection entry. Either rebinds an existing in-grace player whose
  // sid matches (preserving HP, kill-steal block, room, etc.) or allocates a
  // fresh one. Rejecting duplicate live sessions on the same sid prevents two
  // tabs from controlling the same character.
  //
  // allowTakeover=false (production default): older-wins. 같은 sid 의 살아 있는
  // 소켓이 이미 있으면 신규 연결을 null 로 거절해 호출자가 4004 로 close 하게
  // 한다. 두 탭 사이 newer-wins 핑퐁(close(4001) 이 1006 으로 도착해 양쪽이
  // generic auto-reconnect 로 떨어지는 무한 루프) 을 원천 차단.
  // allowTakeover=true (DEV): 같은 탭 새로고침에서 옛 소켓이 아직
  // readyState=1 일 때 새 소켓이 받기를 원하므로 newer-wins 유지.
  attachPlayer(socket, sid, { allowTakeover = false, auth = null } = {}) {
    const existing = this.lookupExistingPlayer({ sid, auth });
    if (existing) return this._reattachExistingPlayer(existing, socket, sid, allowTakeover);
    if (auth && auth.naverId) {
      // 신규 인증 attach. 저장된 캐릭터 스냅샷이 있으면 즉시 월드에 풀어 넣고,
      // 없으면 등록 모달로 흘려 신규 캐릭터를 만들게 한다.
      return this._addAuthenticatedPlayer(socket, sid, auth);
    }
    return this._addPlayer(socket, sid);
  }

  // sid + auth 우선순위로 in-memory player 를 찾는다(없으면 null). 인증된
  // 사용자는 sid 와 무관하게 같은 계정의 살아 있는 player 한 명만 존재 — 그래서
  // auth 가 있으면 그쪽이 우선이다. handleDuplicatePending 에서도 같은 룰로
  // 기존 탭을 찾아 「kicked_by_other」 를 보낸다.
  lookupExistingPlayer({ sid, auth } = {}) {
    if (auth && auth.naverId) return this.naverIdToPlayer.get(auth.naverId) || null;
    if (sid) return this.sidToPlayer.get(sid) || null;
    return null;
  }

  // 두 인덱스(sid, naverId) 에서 player 매핑을 동시에 제거. detach/finalize 양쪽
  // 에서 같은 코드가 반복돼 분기 어긋남이 회귀로 들어오기 쉬워 한 곳으로 정리.
  _unindexPlayer(p) {
    if (!p) return;
    if (p.sid) this.sidToPlayer.delete(p.sid);
    if (p.naverId) this.naverIdToPlayer.delete(p.naverId);
  }

  // 같은 player 가 이미 in-memory 에 있을 때 — sid 또는 auth.naverId 매칭으로
  // 도착 — 새 socket 으로 묶고 클라가 화면을 복원하기 위한 메시지를 다시 흘린다.
  // 살아 있는 옛 socket 이 있으면 takeover 정책에 따라 reject(null) 또는 강제
  // close(4001 'replaced by newer session'). graceTimer/disconnectedAt 을 정리해
  // _finalizePlayer 가 발화되지 않도록.
  //
  // The old socket's `close` handler in index.js is guarded by
  // `player.socket === socket` and silently skips its detach when that's no
  // longer true — race-safe.
  _reattachExistingPlayer(existing, socket, sid, allowTakeover) {
    if (existing.socket && existing.socket.readyState === 1) {
      if (!allowTakeover) return null;
      try { existing.socket.close(4001, 'replaced by newer session'); } catch {}
    }
    if (existing.graceTimer) {
      clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
    }
    existing.disconnectedAt = null;
    existing.socket = socket;
    if (sid) {
      existing.sid = sid;
      this.sidToPlayer.set(sid, existing);
    }

    if (existing.registered) {
      this.send(existing, { type: 'system', text: `다시 접속했습니다, ${existing.name}.` });
      this.pushStatus(existing);
      this.describeRoom(existing);
      // Re-deliver own sprite so the freshly-loaded client can render it
      // in combat without a roundtrip.
      if (existing.spriteSvg) {
        this.send(existing, { type: 'character_sprite', playerId: existing.id, svg: existing.spriteSvg });
      }
    } else if (existing.generating) {
      // Stub mid-sprite-generation. Don't reset the modal back to the form —
      // the in-flight generation is still running and a fresh `register`
      // would hit the re-entry guard. Re-show the progress UI so the
      // reloaded client knows we're still working. (Skipped when
      // registration is disabled: there's no modal to re-show.)
      if (REGISTRATION_ENABLED) {
        this.send(existing, { type: 'register_progress', text: '캐릭터를 그리는 중입니다…' });
      }
    } else if (REGISTRATION_ENABLED) {
      // Stub player resumed before completing registration — re-prompt.
      this.send(existing, { type: 'welcome' });
    } else {
      // Disabled mode: a stub that came back without a registered state
      // (auto-register lost mid-flight, or a sid registered before the
      // flag was flipped). Re-arm auto-registration silently.
      this._autoRegisterStub(existing);
    }
    return existing;
  }

  // 인증된 신규 attach. 저장된 캐릭터 스냅샷이 있으면 player 객체를 그 데이터로
  // hydrate 해 즉시 등록 상태로 만들고, 없으면 일반 stub 와 동일하게 welcome
  // 모달로 흘려 보낸다. 등록이 끝나면 _persistPlayer 가 첫 스냅샷을 디스크에 저장.
  _addAuthenticatedPlayer(socket, sid, auth) {
    const saved = getCharacterFor(auth.naverId);
    const player = this._addPlayer(socket, sid, { suppressWelcome: !!saved });
    player.naverId = auth.naverId;
    this.naverIdToPlayer.set(auth.naverId, player);
    if (!saved) return player;

    // hydrate. _addPlayer 가 신규 stub 의 기본값으로 초기화해 둔 필드를
    // 스냅샷의 값으로 덮어쓴다. 형상이 깨진 옛 스냅샷이 들어와도 누락 필드는
    // 기본값을 유지하도록 안전하게 spread.
    player.name = saved.name || '';
    player.description = saved.description || '';
    player.klass = saved.klass || 'novice';
    player.level = saved.level || 1;
    player.exp = saved.exp || 0;
    player.maxHp = saved.maxHp || classMaxHp(player.klass, player.level);
    player.maxMp = saved.maxMp || classMaxMp(player.klass, player.level);
    player.hp = Math.min(player.maxHp, saved.hp ?? player.maxHp);
    player.mp = Math.min(player.maxMp, saved.mp ?? player.maxMp);
    player.equipment = saved.equipment || STARTING_EQUIPMENT();
    player.inventory = saved.inventory || STARTING_INVENTORY();
    player.spriteSvg = saved.spriteSvg || null;
    player.roomId = saved.roomId && ROOMS[saved.roomId] ? saved.roomId : 'square';
    player.registered = true;

    this.send(player, { type: 'system', text: `${player.name}, 다시 만나서 반갑습니다.` });
    this.pushStatus(player);
    this.describeRoom(player);
    if (player.spriteSvg) {
      this.send(player, { type: 'character_sprite', playerId: player.id, svg: player.spriteSvg });
    }
    this._sendRoomSprites(player);
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 이곳에 도착했습니다.` }, player.id);
    this._pushRoomMonsters(player.roomId);
    return player;
  }

  // 캐릭터 스냅샷을 디스크 스토어에 기록. 인증되지 않은 player 는 영속성 대상이
  // 아니므로 no-op. 호출자는 「상태가 의미 있게 바뀐 시점」(레벨업·장착·이동·
  // 재접속·연결 종료) 에서 한 번씩 호출하면 충분 — store 가 디바운스로 묶는다.
  _persistPlayer(player) {
    if (!player || !player.naverId || !player.registered) return;
    saveCharacterFor(player.naverId, {
      name: player.name,
      description: player.description,
      klass: player.klass,
      level: player.level,
      exp: player.exp,
      hp: player.hp,
      maxHp: player.maxHp,
      mp: player.mp,
      maxMp: player.maxMp,
      equipment: player.equipment,
      inventory: player.inventory,
      roomId: player.roomId,
      spriteSvg: player.spriteSvg,
    });
  }

  // Defers actual removal by RECONNECT_GRACE_MS so a reconnect with the same
  // sid can resume in-place. The player object remains in `this.players` and
  // therefore in their room's broadcast set during grace; PvP / monster
  // interactions still resolve against them. Their socket is null'd so any
  // server→client send is dropped silently.
  detachPlayer(id) {
    const p = this.players.get(id);
    if (!p || p.disconnectedAt != null) return;

    // 연결 종료 직전 스냅샷 — 같은 디바이스 재접속이든 다른 디바이스 로그인이든
    // 새 attach 가 이 데이터에서 시작할 수 있도록.
    this._persistPlayer(p);

    // Stubs (not yet registered) have no in-world state worth preserving and
    // no roomId to broadcast departure from. Drop them immediately so a fresh
    // sid'd connect doesn't keep the half-formed record around.
    if (!p.registered) {
      this.players.delete(id);
      this._unindexPlayer(p);
      return;
    }

    p.disconnectedAt = Date.now();
    p.socket = null;
    // Queued intents reference the room state at the time of issue and would
    // fire during grace into a missing socket — cancel both.
    if (p.pendingMove) {
      clearTimeout(p.pendingMove.timer);
      p.pendingMove = null;
    }
    if (p.pendingAttack) {
      clearTimeout(p.pendingAttack.timer);
      p.pendingAttack = null;
    }

    p.graceTimer = setTimeout(() => {
      // If still disconnected when timer fires, finalize. Reattach clears
      // disconnectedAt, so this guard skips reattached players whose timer
      // wasn't cleared in time (race-safe under the single-threaded model).
      if (p.disconnectedAt != null) this._finalizePlayer(id);
    }, RECONNECT_GRACE_MS);
  }

  _addPlayer(socket, sid = '', { suppressWelcome = false } = {}) {
    const id = nextPlayerId++;
    const now = Date.now();
    // Stub player. Sits outside the world (roomId=null) until registerPlayer
    // promotes it. The only client→server message accepted in this state is
    // `register`; everything else is rejected with a system notice.
    const player = {
      id,
      sid,
      name: '',
      description: '',
      registered: false,
      socket,
      roomId: null,
      spriteSvg: null,
      // HP/MP 기본값은 직업+레벨 함수로 계산. novice + level 1 → maxHp 100, maxMp 0.
      hp: classMaxHp('novice', 1),
      maxHp: classMaxHp('novice', 1),
      mp: classMaxMp('novice', 1),
      maxMp: classMaxMp('novice', 1),
      icon: '🧙',
      equipment: STARTING_EQUIPMENT(),
      inventory: STARTING_INVENTORY(),
      // 직업·성장. klass='novice' 는 출발 직업. 광장에서 레벨 10 도달 시
      // 전직 명령(`전직 마법사`)으로 'mage'로 전환된다.
      level: 1,
      exp: 0,
      klass: 'novice',
      combatTargetId: null,
      downed: false,
      lastAttackAt: 0,
      lastMoveAt: 0,
      lastSayAt: 0,
      pendingMove: null,
      pendingAttack: null,
      moveBlockedUntil: 0,
      moveBlockedBy: null,
      moveBlockedById: null,
      // Token bucket for global per-player command rate. Refills lazily on
      // each handleCommand entry — no timers, no cross-player coordination.
      cmdBucket: CMD_BURST,
      cmdBucketRefAt: now,
      // Reconnect/grace state. disconnectedAt is null while live; set when the
      // socket closes; cleared on reattach. graceTimer fires _finalizePlayer
      // if the grace window expires without a reconnect.
      disconnectedAt: null,
      graceTimer: null,
      // True while the per-character sprite is being generated as part of
      // registration. Blocks re-entry of registerPlayer and lets attachPlayer
      // resume the progress UI after a mid-generation reload.
      generating: false,
    };
    this.players.set(id, player);
    if (sid) this.sidToPlayer.set(sid, player);

    // suppressWelcome 가 true 면 호출자(_addAuthenticatedPlayer)가 hydrate 후
    // describeRoom 까지 직접 처리한다. welcome/auto-register 분기는 「stub 채로
    // 시작하는」 신규 사용자 전용.
    if (suppressWelcome) return player;

    if (REGISTRATION_ENABLED) {
      this.send(player, { type: 'welcome' });
    } else {
      // 등록 절차가 비활성화된 모드. welcome 모달을 띄우지 않고, 백그라운드에서
      // 자동 등록을 점화한다. 분류기 + 합성기 한 사이클(보통 1~3초) 후 플레이어가
      // 광장에 도착한다. 그 사이 사용자는 빈 화면을 보지 않도록 한 줄짜리 진입
      // 안내만 시스템 텍스트로 흘려준다.
      this.send(player, { type: 'system', text: '아그리아에 진입하는 중...' });
      this._autoRegisterStub(player);
    }
    return player;
  }

  // Fire-and-forget auto-registration. Used when REGISTRATION_ENABLED=false to
  // promote a fresh stub straight into the world without going through the
  // welcome modal. The name is keyed by the monotonic player id so duplicate
  // checks inside registerPlayer never collide. Description is fixed in config
  // so the classifier maps everyone to the same wanderer-class character —
  // intentional: in disabled mode all auto players look like the default
  // outlander archetype.
  _autoRegisterStub(player) {
    const autoName = `방랑자-${player.id}`;
    // useDefaultSprite: 첫 자동 등록자에서 만들어진 SVG를 모듈 레벨에 캐싱해
    // 두 번째 접속부터는 generate를 다시 돌리지 않고 같은 이미지를 즉시 사용.
    this.registerPlayer(player, autoName, AUTO_REGISTER_DESC, { silent: true, useDefaultSprite: true })
      .catch((err) => console.error('auto-register failed', err));
  }

  // Promote a stub player to a fully registered character. Sprite generation
  // runs inline (await) before the player enters the world — first combat
  // would otherwise render the default sprite for ~30s and then visibly swap
  // when the AI call returned. The wait is surfaced via `register_progress`
  // so the welcome modal can show a "drawing" state instead of looking frozen.
  async registerPlayer(player, name, description, opts = {}) {
    // Internal auto-register path passes `silent: true` so progress/error
    // notifications don't pop the welcome modal back open in disabled mode.
    const silent = !!opts.silent;
    if (player.registered) return;
    // Single-flight: while one register is mid-await, drop additional ones.
    // Resend the progress UI so a reloaded client doesn't think the second
    // press did nothing.
    if (player.generating) {
      if (!silent) this.send(player, { type: 'register_progress', text: '캐릭터를 그리는 중입니다…' });
      return;
    }

    const cleanName = String(name ?? '').slice(0, NAME_MAX_LEN).trim();
    const cleanDesc = String(description ?? '').slice(0, DESC_MAX_LEN).trim();
    // Validation failures used to send `system` + `welcome` — but `system`
    // landed in the log behind the modal (invisible) and `welcome` re-rendered
    // the modal with the error area hidden. The user saw the button re-enable
    // and nothing else. `register_error` keeps the modal up and surfaces the
    // reason inline.
    if (cleanName.length < NAME_MIN_LEN || cleanDesc.length < DESC_MIN_LEN) {
      if (!silent) this.send(player, { type: 'register_error', text: `이름은 ${NAME_MIN_LEN}~${NAME_MAX_LEN}자, 특징은 ${DESC_MIN_LEN}~${DESC_MAX_LEN}자로 입력하세요.` });
      return;
    }
    // Reject duplicate live names so attack/look targeting (exact-match) stays
    // unambiguous. Also reject names already reserved by another stub mid-
    // generation, otherwise two parallel registers race and the loser fails
    // ~30s later after the user has stared at a progress spinner.
    for (const p of this.players.values()) {
      if (p.id === player.id) continue;
      if (p.name !== cleanName) continue;
      if (p.registered || p.generating) {
        if (!silent) this.send(player, { type: 'register_error', text: '같은 이름의 모험가가 이미 있습니다.' });
        return;
      }
    }

    // Reserve the name on the stub before yielding so concurrent registrations
    // from other players see the slot occupied during sprite generation.
    player.name = cleanName;
    player.description = cleanDesc;
    player.generating = true;
    if (!silent) this.send(player, { type: 'register_progress', text: '캐릭터를 그리는 중입니다…' });

    let svg = null;
    try {
      // 자동 등록 경로(스킵 모드)는 이름만 다르고 description이 늘 같아 합성
      // 결과도 동일하다. 매 접속마다 LLM 분류·합성을 새로 돌리지 않도록 모듈
      // 캐시된 디폴트 SVG를 재사용한다. 첫 호출만 generate가 실행된다.
      svg = opts.useDefaultSprite
        ? await getDefaultCharacterSprite(cleanDesc)
        : await generateCharacterSprite(cleanName, cleanDesc);
    } finally {
      player.generating = false;
    }

    // Player may have disconnected/finalized while we awaited. Stubs are
    // dropped immediately on socket close (no grace), so the typical case is
    // `players.has(id) === false` here and we abort silently.
    if (!this.players.has(player.id)) return;
    if (player.registered) return;

    player.spriteSvg = svg; // null is fine — client falls back to default.
    player.registered = true;
    player.roomId = 'square';

    this.send(player, { type: 'system', text: `${cleanName}, 아그리아에 오신 것을 환영합니다.` });
    this.pushStatus(player);
    this.describeRoom(player);
    this.broadcastRoom(player.roomId, { type: 'text', text: `${cleanName}님이 이곳에 도착했습니다.` }, player.id);
    this._pushRoomMonsters(player.roomId);
    // Cache own sprite client-side. _sendRoomSprites broadcasts to roommates
    // but skips the arriver, so we send self here so PLAYER_SPRITES on the
    // client is keyed by the player's own id for combat-panel lookup.
    if (svg) this.send(player, { type: 'character_sprite', playerId: player.id, svg });
    this._sendRoomSprites(player);
    // 신규 등록 직후 첫 스냅샷 — 인증된 사용자는 이 시점부터 영속 캐릭터.
    this._persistPlayer(player);
  }

  // Final removal after grace expires (or on respawn-driven cleanup). Same
  // semantics as the old removePlayer: drop from registry, free kill-steal
  // blocks anchored to this player's presence, broadcast departure.
  _finalizePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    // grace 가 끝나는 시점이 마지막 영속 보장. 이 시점에 _persistPlayer 가
    // 호출되지 않으면 detachPlayer 가 남긴 스냅샷이 곧 사라지는 in-memory 상태를
    // 가리키게 된다 — 추가 호출 비용은 작고 안전.
    this._persistPlayer(p);
    const fromRoom = p.roomId;
    this.players.delete(id);
    this._unindexPlayer(p);
    this._clearKillStealBlocksAgainst(id, fromRoom);
    this.broadcastRoom(fromRoom, { type: 'text', text: `${p.name}님이 떠났습니다.` });
    this._pushRoomMonsters(fromRoom);
  }

  // Kill-steal block (see _attackMonster) is anchored to the victim's presence
  // in the disputed room. Once the victim leaves that room — by moving,
  // dying/respawning, or disconnecting — the anti-grief gate has nothing to
  // enforce and we lift it on every player still holding a block against them.
  _clearKillStealBlocksAgainst(blockerId, fromRoomId) {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.moveBlockedById !== blockerId) continue;
      if (p.roomId !== fromRoomId) continue;
      if (p.moveBlockedUntil <= now) continue;
      p.moveBlockedUntil = 0;
      p.moveBlockedBy = null;
      p.moveBlockedById = null;
      this.send(p, { type: 'system', text: '방해자가 자리를 떠났다. 이제 이동할 수 있다.' });
    }
  }

  handleCommand(player, raw) {
    // Stub players (pre-registration) can't issue any text commands —
    // everything routes through the welcome modal until they register.
    // In disabled mode there's no modal: auto-registration is in flight, so
    // drop the input silently and let it complete (the user will retry).
    if (!player.registered) {
      if (REGISTRATION_ENABLED) this.send(player, { type: 'welcome' });
      return;
    }
    // Global per-player rate limit. Token bucket refilled lazily; drops
    // commands silently when empty. Silent-drop avoids amplifying a flood
    // with rate-limit notices, which would themselves be expensive to send.
    const now = Date.now();
    const dt = (now - player.cmdBucketRefAt) / 1000;
    player.cmdBucket = Math.min(CMD_BURST, player.cmdBucket + dt * CMD_RATE_PER_SEC);
    player.cmdBucketRefAt = now;
    if (player.cmdBucket < 1) return;
    player.cmdBucket -= 1;

    // Cap input before any tokenization. WS_MAX_PAYLOAD is the wire-level
    // ceiling; this is the per-command ceiling (a 4 KiB frame can still carry
    // a 4 KiB `look` arg otherwise).
    const input = String(raw || '').slice(0, INPUT_MAX_LEN).trim();
    if (!input) return;

    // 마법 이름은 다단어("해골 전사")가 흔해 첫 단어 토큰화로는 깨진다.
    // 입력 전체를 등록된 spell 이름·alias 와 prefix-match 해 매칭 시 표준
    // (cmd='cast' arg='<spellId> <rest>') 형태로 변환. 새 spell 을 추가해도
    // 디스패처는 건드릴 필요 없다.
    const spellMatch = this._matchSpellPrefix(input);
    if (spellMatch) {
      return this.castSpell(player, spellMatch.spellId, spellMatch.rest);
    }

    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case 'look': case 'l':
      case '보기': case '보다': case '봐': case '살피다': case '살펴보다': case '조사':
        return arg ? this.lookAt(player, arg) : this.describeRoom(player);
      case 'go': case 'move':
      case '이동': case '이동하다': case '가다': case '가': case '걷다':
        return this.move(player, arg);
      case 'say':
      case '말': case '말하다': case '말해': case '외치다': case '소리치다':
        return this.say(player, arg);
      case 'attack': case 'hit': case 'fight': case 'kill':
      case '공격': case '공격하다': case '때리다': case '때려': case '싸우다':
        return this.attack(player, arg);
      case 'use':
      case '사용': case '사용하다': case '써': case '쓰다': case '먹다':
        return this.useItem(player, arg);
      case 'equip': case '장착': case '장비': case '입다': case '끼다':
        return this.equip(player, arg);
      case 'unequip': case '해제': case '벗다': case '벗기':
        return this.unequip(player, arg);
      case '전직': case '전직하다': case 'class': case 'job': case 'change-class':
        return this.changeClass(player, arg);
      case 'cast': case '시전': case '시전하다': case '마법': {
        // `시전 <spell>` 명시 명령은 한 번 더 prefix-match 한다 — 취향대로
        // 「시전 파이어볼 고블린」 처럼 쓸 수 있게 하기 위함. 무인자 호출 또는
        // 「마법 목록/리스트/list」 같은 자연어 변형은 보유 목록 출력으로 폴백 —
        // 「뭐 쓸 수 있지?」 라는 의도를 받아 준다.
        if (!arg || /^(목록|리스트|list)$/i.test(arg)) return this.listSpells(player);
        const m = this._matchSpellPrefix(arg);
        if (!m) return this.send(player, { type: 'system', text: '알 수 없는 마법입니다.' });
        return this.castSpell(player, m.spellId, m.rest);
      }
      case 'skills': case 'spells': case 'spelllist':
      case '스킬': case '마법목록': case '주문서':
        return this.listSpells(player);
      case 'help':
      case '도움말': case '도움': case '명령어': case '명령':
        return this.send(player, { type: 'text', text: '명령: 보기 [대상], 이동 <방향>, 공격 <대상/플레이어>, 말 <내용>, 사용 <아이템>, 장착 <장비>, 해제 <슬롯>, 전직 <직업>, <마법명> <대상>, 스킬, 도움말' });
      default:
        if (['north','south','east','west','n','s','e','w','북','남','동','서','북쪽','남쪽','동쪽','서쪽'].includes(cmd)) {
          return this.move(player, cmd);
        }
        // Anything we don't recognize is treated as chat — typing prose into
        // the prompt naturally broadcasts to the room without needing the
        // `말` keyword. `say`'s own cooldown / length cap still apply.
        return this.say(player, input);
    }
  }

  describeRoom(player) {
    const room = ROOMS[player.roomId];
    const exits = Object.keys(room.exits).map(d => DIR_LABEL[d] || d).join(', ') || '(없음)';
    const objs = room.objects.map(o => OBJECTS[o]?.name).filter(Boolean).join(', ') || '(없음)';
    const others = [...this.players.values()]
      .filter(p => p.registered && p.roomId === room.id && p.id !== player.id && p.disconnectedAt == null)
      .map(p => p.name).join(', ');
    this.send(player, { type: 'text', text: `── ${room.name} ──` });
    this.send(player, { type: 'text', text: room.desc });
    this.send(player, { type: 'text', text: `보이는 것: ${objs}` });
    const monsters = this.roomMonsters.get(room.id) || [];
    if (monsters.length > 0) {
      const segs = [{ text: '적: ' }];
      monsters.forEach((m, i) => {
        if (i > 0) segs.push({ text: ', ' });
        segs.push({ text: m.name, cls: 'monster-name' });
        segs.push({ text: ` (${m.hp}/${m.maxHp})` });
      });
      this.seg(player, segs);
    }
    if (others) this.send(player, { type: 'text', text: `이곳에 있는 사람: ${others}` });
    this.send(player, { type: 'text', text: `출구: ${exits}` });
    this.send(player, { type: 'view', view: null });
    // 대기화면 룸 스냅샷을 즉시 채운다. 이전 방의 잔존 항목이 있어도 새 룸
    // 스냅샷(빈 배열일 수 있음)으로 덮어써 깨끗하게 갱신.
    this.send(player, this._buildRoomPayload(room.id, player.id));
  }

  // Resolution order: self-shortcuts → room objects → monsters → players in
  // the same room. Misses fall through to a "not found" system message.
  lookAt(player, target) {
    if (['나', '나를', '내가', 'me', 'self', '자신'].includes(target)) {
      return this._lookPlayer(player, player, true);
    }

    const room = ROOMS[player.roomId];
    const objKey = room.objects.find(o => {
      const obj = OBJECTS[o];
      return obj && (
        o === target || obj.name === target ||
        (target.length >= 2 && obj.name.includes(target))
      );
    });
    if (objKey) {
      const obj = OBJECTS[objKey];
      this.send(player, { type: 'text', text: obj.desc });
      if (obj.view) {
        this.send(player, { type: 'view', view: { ...obj.view, name: obj.name } });
      } else {
        this.send(player, { type: 'view', view: null });
      }
      return;
    }

    const monsters = this.roomMonsters.get(player.roomId) || [];
    const monster = monsters.find(m =>
      m.name === target || m.defId === target ||
      (target.length >= 2 && m.name.includes(target))
    );
    if (monster) {
      const def = MONSTER_DEFS[monster.defId];
      this.send(player, { type: 'text', text: def.desc });
      this.seg(player, [
        { text: monster.name, cls: 'monster-name' },
        { text: ` — 체력: ${monster.hp}/${monster.maxHp}` },
      ]);
      this.send(player, { type: 'view', view: null });
      return;
    }

    // Disconnected players (in grace) remain findable so they can still be
    // engaged — disconnect doesn't grant invulnerability.
    const someone = [...this.players.values()].find(p =>
      p.roomId === player.roomId &&
      (p.name === target || String(p.id) === target)
    );
    if (someone) {
      return this._lookPlayer(player, someone, someone.id === player.id);
    }

    this.send(player, { type: 'system', text: `'${target}'을(를) 찾을 수 없습니다.` });
  }

  _lookPlayer(viewer, target, isSelf) {
    const equipped = Object.values(target.equipment)
      .filter(Boolean)
      .map(it => it.name)
      .join(', ') || '(맨몸)';
    // The character's own description (entered at registration) is what
    // other players read on `look` — same role as a monster's hand-written
    // `desc` on the definition.
    this.send(viewer, {
      type: 'text',
      text: target.description || (isSelf ? '거울에 비친 자신을 본다.' : '또 다른 여행자다.'),
    });
    this.seg(viewer, [
      { text: target.name, cls: 'tx-player' },
      { text: ` — 체력: ${target.hp}/${target.maxHp}` },
    ]);
    this.send(viewer, { type: 'text', text: `장비: ${equipped}` });
    this.send(viewer, { type: 'view', view: null });
  }

  // Server-authoritative cooldown — see command.md. WASD key-repeat,
  // duplicate clicks, and tampered clients all hit this gate first. During
  // cooldown the move is QUEUED (not rejected): a single timer fires the
  // pending move when the cooldown elapses. Latest input wins — pressing
  // another direction replaces the queued move so timers can't pile up.
  move(player, dir) {
    const now = Date.now();
    // Kill-steal block: short-circuits any move attempt (including queued ones —
    // pendingMove was cleared when the block was applied). Blocked input is
    // REJECTED, not queued, so the player can't stack a move that auto-fires
    // the moment the block lifts.
    if (player.moveBlockedUntil > now) {
      // Lazy fallback: if the blocker has since left this room (or disconnected
      // without the push-clear path firing for any reason), the gate has
      // nothing to enforce — drop it and let the move proceed.
      const blockerPlayer = player.moveBlockedById ? this.players.get(player.moveBlockedById) : null;
      if (!blockerPlayer || blockerPlayer.roomId !== player.roomId) {
        player.moveBlockedUntil = 0;
        player.moveBlockedBy = null;
        player.moveBlockedById = null;
      } else {
        const remainSec = Math.ceil((player.moveBlockedUntil - now) / 1000);
        const blocker = player.moveBlockedBy || '누군가';
        this.send(player, { type: 'system', text: `${blocker}님이 당신의 이동을 방해중입니다. (${remainSec}초 후 이동가능)` });
        return;
      }
    }
    const elapsed = now - player.lastMoveAt;
    if (elapsed < MOVE_COOLDOWN_MS) {
      if (player.pendingMove) clearTimeout(player.pendingMove.timer);
      const remain = MOVE_COOLDOWN_MS - elapsed;
      const remainSec = (remain / 1000).toFixed(1);
      this.send(player, { type: 'system', text: `${remainSec}초 후 이동합니다.` });
      const timer = setTimeout(() => {
        // Stale-fire guard: player may have disconnected, and respawn
        // explicitly clears pendingMove so a stale direction can't relocate
        // them. If we get here, the queued intent is still valid.
        if (!this.players.has(player.id)) return;
        player.pendingMove = null;
        this._doMove(player, dir);
      }, remain);
      player.pendingMove = { dir, timer };
      return;
    }
    this._doMove(player, dir);
  }

  _doMove(player, dir) {
    const map = { n: 'north', s: 'south', e: 'east', w: 'west', '북': 'north', '남': 'south', '동': 'east', '서': 'west', '북쪽': 'north', '남쪽': 'south', '동쪽': 'east', '서쪽': 'west' };
    const d = map[dir] || dir;
    const room = ROOMS[player.roomId];
    const next = room.exits[d];
    if (!next) {
      // Invalid direction does NOT consume the cooldown — players bumping
      // into walls shouldn't be punished with a wait timer.
      this.send(player, { type: 'system', text: '그 방향으로는 갈 수 없습니다.' });
      return;
    }
    player.lastMoveAt = Date.now();
    const fromRoom = player.roomId;
    // Anyone holding a kill-steal block against this player loses the gate the
    // moment we leave the disputed room. Push-clear before we change roomId so
    // the helper can match on the (still-current) from-room.
    this._clearKillStealBlocksAgainst(player.id, player.roomId);
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 ${DIR_LABEL[d] || d}쪽으로 떠났습니다.` }, player.id);
    player.roomId = next;
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 도착했습니다.` }, player.id);
    this.clearCombat(player);
    player.combatTargetId = null;
    // Queued attack was bound to the previous room's targets; firing it after
    // a room change would resolve against unrelated monsters/players. Cancel.
    if (player.pendingAttack) {
      clearTimeout(player.pendingAttack.timer);
      player.pendingAttack = null;
    }
    this.pushStatus(player);
    this.describeRoom(player);
    this._sendRoomSprites(player);
    // Refresh both rooms' player rosters so other clients' action-pad targets
    // (and "사람" lists) reflect the move without waiting for a stray event.
    this._pushRoomMonsters(fromRoom);
    this._pushRoomMonsters(player.roomId);
    // 위치 보존 — 재접속 시 마지막 방에서 다시 시작하도록.
    this._persistPlayer(player);
  }

  // On room entry, push the cached sprite of every other registered player
  // currently in the room so the arriving client can render them in combat.
  // Also push the arriver's sprite to those roommates so they see this
  // player in combat. Self-cache is handled by registerPlayer (which sends
  // own sprite directly to the player) since this method skips the arriver.
  _sendRoomSprites(arriver) {
    if (!arriver.registered) return;
    // Send arriver's sprite to room mates (so they see this player in combat).
    if (arriver.spriteSvg) {
      const myMsg = { type: 'character_sprite', playerId: arriver.id, svg: arriver.spriteSvg };
      for (const p of this.players.values()) {
        if (p.id === arriver.id) continue;
        if (!p.registered) continue;
        if (p.roomId !== arriver.roomId) continue;
        this.send(p, myMsg);
      }
    }
    // Send room mates' sprites to the arriver.
    for (const p of this.players.values()) {
      if (p.id === arriver.id) continue;
      if (!p.registered) continue;
      if (p.roomId !== arriver.roomId) continue;
      if (!p.spriteSvg) continue;
      this.send(arriver, { type: 'character_sprite', playerId: p.id, svg: p.spriteSvg });
    }
  }

  useItem(player, arg) {
    if (!arg) {
      this.send(player, { type: 'system', text: '사용할 아이템을 지정하세요.' });
      return;
    }
    const idx = player.inventory.findIndex(it =>
      it.id === arg || it.name === arg ||
      (arg.length >= 2 && it.name.includes(arg))
    );
    if (idx === -1) {
      this.send(player, { type: 'system', text: `'${arg}'을(를) 소지하고 있지 않습니다.` });
      return;
    }
    const item = player.inventory[idx];
    // 장비 아이템에 `use` 가 들어오면 자연스럽게 장착으로 라우팅 — 텍스트
    // 입력 사용자가 `use 뼈 검` 처럼 친근한 동사를 써도 통하게.
    if (item.kind === 'equip') {
      return this.equip(player, item.id);
    }
    const handler = ITEM_USE[item.id];
    if (!handler) {
      this.send(player, { type: 'system', text: `${item.name}은(는) 지금 사용할 수 없습니다.` });
      return;
    }
    const msg = handler(player);
    item.qty -= 1;
    if (item.qty <= 0) player.inventory.splice(idx, 1);
    this.send(player, { type: 'text', text: msg });
    this.pushStatus(player);
    // 교전 중에 회복 아이템을 쓰면 player.hp만 바뀌고 클라의 combat 패널은
    // 다음 공격 틱까지 옛 HP로 남는다. 현재 교전 상대를 다시 찾아 즉시
    // pushCombat으로 갱신해 회복이 실시간으로 보이도록.
    if (player.combatTargetId) {
      const tid = player.combatTargetId;
      if (tid.startsWith('m')) {
        const mid = Number(tid.slice(1));
        const list = this.roomMonsters.get(player.roomId) || [];
        const foe = list.find(m => m.id === mid && !m.dead);
        if (foe) this.pushCombat(player, foe, 'monster');
      } else if (tid.startsWith('p')) {
        const foe = this.players.get(tid.slice(1));
        if (foe) this.pushCombat(player, foe, 'player');
      }
    }
  }

  // 장비 슬롯과 인벤토리 사이에서 한 칸을 옮긴다. 같은 슬롯에 이미 장비가
  // 있으면 그것을 인벤토리로 떨궈 1:1 스왑(개별 명령으로 먼저 해제할 필요
  // 없음). qty>1 인 인벤토리 엔트리는 1만 빠지고 나머지는 그대로 남아
  // 같은 종류 여러 장을 보관해도 일관되게 동작.
  equip(player, raw) {
    const arg = String(raw || '').trim();
    if (!arg) {
      return this.send(player, { type: 'system', text: '장착할 장비 이름을 지정하세요.' });
    }
    const idx = player.inventory.findIndex(it =>
      it.kind === 'equip' && (
        it.id === arg || it.name === arg || (arg.length >= 2 && it.name.includes(arg))
      )
    );
    if (idx === -1) {
      return this.send(player, { type: 'system', text: `'${arg}' 장비를 가지고 있지 않습니다.` });
    }
    const src = player.inventory[idx];
    const slot = src.slot;
    if (!slot || !(slot in player.equipment)) {
      return this.send(player, { type: 'system', text: `${src.name}은(는) 장착할 슬롯이 없습니다.` });
    }
    // 인벤토리에서 1 빼기 — 다 떨어지면 엔트리 제거.
    if ((src.qty || 1) > 1) src.qty -= 1;
    else player.inventory.splice(idx, 1);
    // 장비 슬롯에 ITEM_DEFS 의 새 단일-qty 스냅샷을 넣는다(인벤토리 원본과
    // 분리해 추후 변동 격리). 기존 장비는 인벤토리로 환원.
    const previous = player.equipment[slot];
    player.equipment[slot] = makeItem(src.id);
    if (previous) this._addToInventory(player, previous);
    this.send(player, { type: 'text', text: `${src.name}을(를) 장착했다.` });
    this.pushStatus(player);
    this._persistPlayer(player);
  }

  // 슬롯명("무기"/"head" 등) 또는 현재 장착 중인 아이템 이름으로 해당 슬롯을
  // 비워 인벤토리로 되돌린다. 빈 슬롯에 호출하면 안내 라인.
  unequip(player, raw) {
    const arg = String(raw || '').trim();
    const SLOT_ALIASES = {
      head: 'head', body: 'body', weapon: 'weapon', offhand: 'offhand', feet: 'feet',
      '머리': 'head', '몸': 'body', '몸통': 'body',
      '무기': 'weapon', '보조': 'offhand', '발': 'feet',
    };
    let slot = SLOT_ALIASES[arg.toLowerCase()] || SLOT_ALIASES[arg] || null;
    if (!slot && arg) {
      // 슬롯 키가 아니면 장착품 이름으로 매칭 시도.
      for (const [s, item] of Object.entries(player.equipment)) {
        if (!item) continue;
        if (item.id === arg || item.name === arg || (arg.length >= 2 && item.name.includes(arg))) {
          slot = s;
          break;
        }
      }
    }
    if (!slot) {
      return this.send(player, { type: 'system', text: '해제할 슬롯/아이템을 지정하세요. (머리/몸통/무기/보조/발)' });
    }
    const item = player.equipment[slot];
    if (!item) {
      return this.send(player, { type: 'system', text: '해당 슬롯은 비어 있습니다.' });
    }
    player.equipment[slot] = null;
    this._addToInventory(player, item);
    this.send(player, { type: 'text', text: `${item.name}을(를) 해제했다.` });
    this.pushStatus(player);
    this._persistPlayer(player);
  }

  // Server-authoritative cooldown — see command.md. During cooldown the attack
  // is QUEUED (not rejected): a single timer fires the pending attack when the
  // cooldown elapses. Latest input wins — issuing another attack replaces the
  // queued arg so timers can't pile up. Mirrors the move-queue model.
  attack(player, arg) {
    const now = Date.now();
    const elapsed = now - player.lastAttackAt;
    if (elapsed < ATTACK_COOLDOWN_MS) {
      if (player.pendingAttack) clearTimeout(player.pendingAttack.timer);
      const remain = ATTACK_COOLDOWN_MS - elapsed;
      const remainSec = (remain / 1000).toFixed(1);
      this.send(player, { type: 'system', text: `${remainSec}초 후 공격합니다.` });
      const timer = setTimeout(() => {
        // Stale-fire guards: disconnect or respawn explicitly clears
        // pendingAttack so a queued intent can't fire against a stale room.
        if (!this.players.has(player.id)) return;
        player.pendingAttack = null;
        this._doAttack(player, arg);
      }, remain);
      player.pendingAttack = { arg, timer };
      return;
    }
    this._doAttack(player, arg);
  }

  // Dispatcher: resolve the target by name/id at fire time, prefer monsters
  // then players. Self-targeting is rejected. Argless `attack` prefers the
  // currently-engaged monster(combatTargetId) and falls back to the first live
  // monster only when none of those is in this room — never auto-targets a player.
  //
  // lastAttackAt is consumed here unconditionally — even on miss/no-target —
  // so a tampered client can't ping the resolver for free.
  _doAttack(player, arg) {
    player.lastAttackAt = Date.now();

    const monsters = this.roomMonsters.get(player.roomId) || [];

    if (arg) {
      // Monster: exact name/defId or substring of length ≥ 2. Single-char
      // probes can no longer auto-resolve to whatever happens to be in the room.
      const monster = monsters.find(m => !m.dead && (
        m.name === arg || m.defId === arg || (arg.length >= 2 && m.name.includes(arg))
      ));
      if (monster) return this._attackMonster(player, monster);

      // Player: exact name or numeric id only. Substring matching dropped —
      // it let `attack 자` resolve to any 여행자N at random. Disconnected
      // players in grace remain valid targets.
      const other = [...this.players.values()].find(p =>
        p.id !== player.id && p.roomId === player.roomId && !p.downed &&
        (p.name === arg || String(p.id) === arg)
      );
      if (other) return this._attackPlayer(player, other);

      this.send(player, { type: 'system', text: `'${arg}'을(를) 찾을 수 없습니다.` });
      return;
    }

    // 현재 교전 중인 몬스터가 같은 방에 살아 있다면 그쪽을 우선 — 모바일의
    // 「선택지 없이 즉시 공격」 단축경로(액션 패드에서 공격 버튼 한 번)와
    // PC 의 인자 없는 `attack` 둘 다 같은 의도(이미 상대가 있는데 또 고를
    // 필요 없다)를 갖는다. fallback 은 기존 동작 — 방의 첫 번째 살아 있는
    // 몬스터.
    let monster = null;
    if (player.combatTargetId && player.combatTargetId.startsWith('m')) {
      const id = Number(player.combatTargetId.slice(1));
      monster = monsters.find(m => m.id === id && !m.dead) || null;
    }
    if (!monster) monster = monsters.find(m => !m.dead);
    if (monster) return this._attackMonster(player, monster);
    this.send(player, { type: 'system', text: '공격할 대상이 없습니다.' });
  }

  _attackMonster(player, target) {
    player.combatTargetId = `m${target.id}`;
    // Close any object-view panel the attacker had open from a prior `look`.
    // Combat takes over the side panel space; leaving an unrelated view
    // visible during a fight is noisy.
    this.send(player, { type: 'view', view: null });

    // 기본 공격은 base 3 + 모든 장비의 attack 합 + random(0..7). 무기를
    // 안 든 상태에서도 base 3 + random 으로 빈손 잽이 가능. 장비 없을 때의
    // 옛 (3) / 시작 단검 (8) baseline 은 ITEM_DEFS.short_sword.attack=5 로
    // 그대로 재현된다.
    const dmgOut = Math.floor(Math.random() * 8) + 3 + this._totalAttack(player);
    const { killingBlow } = this.applyMonsterDamage(target, dmgOut);

    this.seg(player, [
      { text: '당신이 ' },
      { text: target.name, cls: 'monster-name' },
      { text: `에게 ${dmgOut}의 피해를 입혔다.` },
    ]);

    // Push HP update to other players in this room currently engaged with the
    // same monster, so they see the bar drain in real time. On a killing blow
    // we also flag the killer as a kill-stealer if any of these onlookers were
    // engaged with this same monster — they are the victims of the steal.
    const engagementKey = `m${target.id}`;
    let killStealVictimName = null;
    let killStealVictimId = null;
    for (const p of this.players.values()) {
      if (p.id === player.id) continue;
      if (p.roomId !== player.roomId) continue;
      if (p.combatTargetId !== engagementKey) continue;
      this.seg(p, [
        { text: player.name, cls: 'tx-player' },
        { text: '님이 ' },
        { text: target.name, cls: 'monster-name' },
        { text: `에게 ${dmgOut}의 피해를 입혔다.` },
      ]);
      if (killingBlow) {
        this.seg(p, [
          { text: target.name, cls: 'monster-name' },
          { text: '이(가) ' },
          { text: player.name, cls: 'tx-player' },
          { text: '님에게 쓰러졌다.' },
        ]);
        // First engaged onlooker becomes the named blocker. Multiple victims
        // could exist; one name is enough for the message.
        if (!killStealVictimName) {
          killStealVictimName = p.name;
          killStealVictimId = p.id;
        }
      }
      this.pushCombat(p, target, 'monster', killingBlow ? 'foe' : null, killingBlow ? player.name : null);
      if (killingBlow) p.combatTargetId = null;
    }

    if (killingBlow) {
      const roomId = player.roomId;
      const list = this.roomMonsters.get(roomId);
      list.splice(list.indexOf(target), 1);
      this.seg(player, [{ text: target.name, cls: 'monster-name' }, { text: '이(가) 쓰러졌다!' }]);
      this.pushCombat(player, target, 'monster', 'foe');
      player.combatTargetId = null;
      // 죽은 몬스터를 룸 몬스터 패널에서 즉시 제거.
      this._pushRoomMonsters(roomId);
      // 처치 보상은 마지막 일격을 가한 한 명만 — 경험치와 드랍 모두 동일 정책.
      // 드랍 먼저 굴려 인벤토리를 갱신한 뒤 _grantExp 가 마무리 pushStatus 를
      // 한 번에 보내도록 — 같은 틱에 push 가 두 번 나가는 걸 피하기 위해.
      this._rollDrops(player, target.defId);
      const expReward = MONSTER_DEFS[target.defId]?.expReward || 0;
      if (expReward > 0) this._grantExp(player, expReward);
      if (killStealVictimName) {
        // Anti-grief: kill-stealer can't immediately walk away. Cancel any
        // queued move first — otherwise it would auto-fire under the block.
        if (player.pendingMove) {
          clearTimeout(player.pendingMove.timer);
          player.pendingMove = null;
        }
        player.moveBlockedUntil = Date.now() + KILLSTEAL_MOVE_BLOCK_MS;
        player.moveBlockedBy = killStealVictimName;
        player.moveBlockedById = killStealVictimId;
        const sec = Math.ceil(KILLSTEAL_MOVE_BLOCK_MS / 1000);
        this.send(player, { type: 'system', text: `${killStealVictimName}님이 당신의 이동을 방해중입니다. (${sec}초 후 이동가능)` });
      }
      this.scheduleRespawn(roomId, target.defId);
      return;
    }

    // Counter-attack only retaliates against the player who landed this hit.
    // 방어구의 defense 합으로 감산 — 갑옷이 의미 있게 작동하도록. 최소 1 보장
    // (방어가 충분히 높아도 「쓰다듬는 한 대」는 들어와 stalemate 방지).
    const rawDmg = Math.floor(Math.random() * target.atk) + 1;
    const dmgIn = Math.max(1, rawDmg - this._totalDefense(player));
    player.hp = Math.max(0, player.hp - dmgIn);
    this.seg(player, [
      { text: target.name, cls: 'monster-name' },
      { text: `이(가) 반격해 ${dmgIn}의 피해를 입혔다. 체력: ${player.hp}/${player.maxHp}` },
    ]);

    if (player.hp <= 0) {
      const fromRoom = player.roomId;
      this.send(player, { type: 'system', text: '의식을 잃고 쓰러졌다...' });
      this.pushCombat(player, target, 'monster', 'me');
      this._respawnAtSquare(player);
      // _respawnAtSquare가 player.roomId를 광장으로 바꾸므로 사전에 잡아둔
      // fromRoom으로 패널을 갱신해야 한다 — 같은 방의 다른 플레이어들이 살아
      // 남은 몬스터의 변동된 HP를 본다.
      this._pushRoomMonsters(fromRoom);
      return;
    }
    this.pushCombat(player, target, 'monster');
    this.pushStatus(player);
    // 비교전 룸메이트도 HP 바 변화를 보도록 룸 전체에 갱신 푸시.
    this._pushRoomMonsters(player.roomId);
  }

  // 보유 마법 목록을 로그에 출력. 마법사가 아니면 안내, 해금된 마법은
  // element 색으로 강조해 시각적으로 모바일 액션 패드의 spell 버튼과
  // 짝이 맞게. 잠금된 마법(레벨 미달)은 dim 라벨로 미리보기 — 다음 목표
  // 레벨이 한눈에 보인다. 인벤토리/장비 같은 사이드바 패널이 아니라
  // 텍스트 로그에 흘리는 이유: 이게 「쿼리」 명령이고 일회성 출력이라
  // status 페이로드를 뚱뚱하게 만들 필요 없이 채팅 흐름에 자연스럽게 섞임.
  listSpells(player) {
    if (player.klass !== 'mage') {
      return this.send(player, { type: 'system', text: '아직 마법을 익힌 직업이 아닙니다. (광장 + 레벨 10 에서 전직 가능)' });
    }
    const all = Object.values(SPELL_DEFS);
    const unlocked = all.filter(s => player.level >= s.minLevel);
    const locked = all.filter(s => player.level < s.minLevel);
    if (unlocked.length === 0) {
      this.send(player, { type: 'system', text: '아직 익힌 마법이 없습니다.' });
    } else {
      this.send(player, { type: 'text', text: `── 보유 마법 (${unlocked.length}/${all.length}) ──` });
      for (const s of unlocked) {
        this.seg(player, [
          { text: '• ' },
          { text: s.name, cls: `tx-dmg-${s.element}` },
          { text: `  Lv.${s.minLevel}  ${s.mpCost}MP  데미지 ${s.dmg[0]}~${s.dmg[1]}` },
        ]);
      }
    }
    if (locked.length > 0) {
      this.send(player, { type: 'text', text: '── 잠김 ──' });
      for (const s of locked) {
        this.seg(player, [
          { text: '• ', cls: 'tx-label' },
          { text: s.name, cls: 'tx-label' },
          { text: `  Lv.${s.minLevel} 필요`, cls: 'tx-label' },
        ]);
      }
    }
  }

  // 입력 전체를 SPELL_DEFS 의 이름·alias 와 prefix-match. 다단어 한국어
  // 마법명("해골 전사 고블린")이 첫 단어 토큰화에 깨지지 않도록 디스패처보다
  // 먼저 호출된다. 더 긴 alias 가 짧은 alias 의 prefix 인 경우(예: "파이어 볼"
  // / "파이어볼") 긴 쪽을 먼저 시도하기 위해 길이 내림차순으로 검사.
  _matchSpellPrefix(input) {
    if (!input) return null;
    const trimmed = input.trim();
    const lo = trimmed.toLowerCase();
    const candidates = [];
    for (const [id, spell] of Object.entries(SPELL_DEFS)) {
      candidates.push({ id, key: spell.name.toLowerCase() });
      for (const a of spell.aliases || []) candidates.push({ id, key: a.toLowerCase() });
    }
    candidates.sort((a, b) => b.key.length - a.key.length);
    for (const c of candidates) {
      if (lo === c.key) return { spellId: c.id, rest: '' };
      if (lo.startsWith(c.key + ' ')) {
        return { spellId: c.id, rest: trimmed.slice(c.key.length).trim() };
      }
    }
    return null;
  }

  // 마법 시전. 공격과 비슷한 라이프사이클(쿨다운 → 대상 해소 → 데미지 →
  // 반격 → 처치 처리)을 따르되 다음 셋이 다르다:
  //  1) 클래스/레벨/MP 게이트가 추가됨.
  //  2) 데미지 출력 segment 에 spell 의 element 별 cls(`tx-dmg-<element>`)를
  //     붙여 클라이언트가 마법별 고유 색으로 데미지를 칠하게 한다.
  //  3) 쿨다운은 attack 과 같은 lastAttackAt 슬롯을 공유 — 마법으로 공격
  //     쿨다운을 우회하지 못하게.
  castSpell(player, spellId, arg) {
    const spell = SPELL_DEFS[spellId];
    if (!spell) {
      return this.send(player, { type: 'system', text: '알 수 없는 마법입니다.' });
    }
    if (player.klass !== 'mage') {
      return this.send(player, { type: 'system', text: '마법은 마법사만 시전할 수 있습니다.' });
    }
    if (player.level < spell.minLevel) {
      return this.send(player, { type: 'system', text: `${spell.name} — 레벨 ${spell.minLevel} 이상 필요. (현재 ${player.level})` });
    }
    if (player.mp < spell.mpCost) {
      return this.send(player, { type: 'system', text: `마나가 부족합니다. (${player.mp}/${player.maxMp}, 필요 ${spell.mpCost})` });
    }
    const now = Date.now();
    const elapsed = now - player.lastAttackAt;
    if (elapsed < ATTACK_COOLDOWN_MS) {
      const remainSec = ((ATTACK_COOLDOWN_MS - elapsed) / 1000).toFixed(1);
      return this.send(player, { type: 'system', text: `${remainSec}초 후 시전 가능합니다.` });
    }

    const monsters = this.roomMonsters.get(player.roomId) || [];
    let target = null;
    if (arg) {
      target = monsters.find(m => !m.dead && (
        m.name === arg || m.defId === arg || (arg.length >= 2 && m.name.includes(arg))
      ));
      if (!target) {
        return this.send(player, { type: 'system', text: `'${arg}'을(를) 찾을 수 없습니다.` });
      }
    } else {
      // attack 과 동일한 우선순위 — 교전 중이면 그 몬스터, 아니면 방의 첫 번째.
      if (player.combatTargetId && player.combatTargetId.startsWith('m')) {
        const id = Number(player.combatTargetId.slice(1));
        target = monsters.find(m => m.id === id && !m.dead) || null;
      }
      if (!target) target = monsters.find(m => !m.dead);
      if (!target) {
        return this.send(player, { type: 'system', text: '시전할 대상이 없습니다.' });
      }
    }

    // 비용 차감과 시전 시각 기록 — 쿨다운 게이트는 attack 과 공유.
    player.lastAttackAt = now;
    player.mp -= spell.mpCost;
    player.combatTargetId = `m${target.id}`;
    this.send(player, { type: 'view', view: null });

    const [dmin, dmax] = spell.dmg;
    // 레벨에 따른 약한 보너스(2레벨당 +1) — 후반 마법에 비례 가중되지 않도록 작게.
    const bonus = Math.floor((player.level - spell.minLevel) / 2);
    const dmg = Math.max(1, Math.floor(Math.random() * (dmax - dmin + 1)) + dmin + bonus);
    const { killingBlow } = this.applyMonsterDamage(target, dmg);

    const dmgCls = `tx-dmg-${spell.element}`;
    // 시각 이펙트 페이로드. 이 cast 사이클의 모든 pushCombat 에 동일하게
    // 실어 보낸다 — 클라이언트는 첫 도착하는 메시지에서 overlay 를 띄우고
    // 이어지는 counter-attack 메시지가 stage 만 교체하더라도 overlay 가
    // 살아남는다(magic.md 참조).
    const spellEffect = { kind: 'spell', element: spell.element, name: spell.name };
    this.seg(player, [
      { text: `${spell.castVerb} ` },
      { text: target.name, cls: 'monster-name' },
      { text: '에게 ' },
      { text: String(dmg), cls: dmgCls },
      { text: '의 피해를 입혔다.' },
    ]);

    // 같은 몬스터 교전 중인 다른 플레이어들도 본다 — _attackMonster 패턴과 동일.
    const engagementKey = `m${target.id}`;
    let killStealVictimName = null;
    let killStealVictimId = null;
    for (const p of this.players.values()) {
      if (p.id === player.id) continue;
      if (p.roomId !== player.roomId) continue;
      if (p.combatTargetId !== engagementKey) continue;
      this.seg(p, [
        { text: player.name, cls: 'tx-player' },
        { text: `의 ${spell.name}이(가) ` },
        { text: target.name, cls: 'monster-name' },
        { text: '에게 ' },
        { text: String(dmg), cls: dmgCls },
        { text: '의 피해를 입혔다.' },
      ]);
      if (killingBlow) {
        this.seg(p, [
          { text: target.name, cls: 'monster-name' },
          { text: '이(가) ' },
          { text: player.name, cls: 'tx-player' },
          { text: '님에게 쓰러졌다.' },
        ]);
        if (!killStealVictimName) {
          killStealVictimName = p.name;
          killStealVictimId = p.id;
        }
      }
      this.pushCombat(p, target, 'monster', killingBlow ? 'foe' : null, killingBlow ? player.name : null, spellEffect);
      if (killingBlow) p.combatTargetId = null;
    }

    if (killingBlow) {
      const roomId = player.roomId;
      const list = this.roomMonsters.get(roomId);
      list.splice(list.indexOf(target), 1);
      this.seg(player, [{ text: target.name, cls: 'monster-name' }, { text: '이(가) 쓰러졌다!' }]);
      this.pushCombat(player, target, 'monster', 'foe', null, spellEffect);
      player.combatTargetId = null;
      this._pushRoomMonsters(roomId);
      const expReward = MONSTER_DEFS[target.defId]?.expReward || 0;
      if (expReward > 0) this._grantExp(player, expReward);
      if (killStealVictimName) {
        if (player.pendingMove) {
          clearTimeout(player.pendingMove.timer);
          player.pendingMove = null;
        }
        player.moveBlockedUntil = Date.now() + KILLSTEAL_MOVE_BLOCK_MS;
        player.moveBlockedBy = killStealVictimName;
        player.moveBlockedById = killStealVictimId;
        const sec = Math.ceil(KILLSTEAL_MOVE_BLOCK_MS / 1000);
        this.send(player, { type: 'system', text: `${killStealVictimName}님이 당신의 이동을 방해중입니다. (${sec}초 후 이동가능)` });
      }
      this.scheduleRespawn(roomId, target.defId);
      return;
    }

    // 마법으로도 반격은 받는다 — attack 의 방어 감산 공식 그대로.
    const rawDmgIn = Math.floor(Math.random() * target.atk) + 1;
    const dmgIn = Math.max(1, rawDmgIn - this._totalDefense(player));
    player.hp = Math.max(0, player.hp - dmgIn);
    this.seg(player, [
      { text: target.name, cls: 'monster-name' },
      { text: `이(가) 반격해 ${dmgIn}의 피해를 입혔다. 체력: ${player.hp}/${player.maxHp}` },
    ]);

    if (player.hp <= 0) {
      const fromRoom = player.roomId;
      this.send(player, { type: 'system', text: '의식을 잃고 쓰러졌다...' });
      this.pushCombat(player, target, 'monster', 'me', null, spellEffect);
      this._respawnAtSquare(player);
      this._pushRoomMonsters(fromRoom);
      return;
    }
    this.pushCombat(player, target, 'monster', null, null, spellEffect);
    this.pushStatus(player);
    this._pushRoomMonsters(player.roomId);
  }

  // PvP: attacker hits target once. Defender does NOT auto-counter — they
  // must run their own `attack` to retaliate. This keeps each command's
  // effect explicit (no surprise damage from being passively present) and
  // mirrors how the input protocol expresses player intent.
  _attackPlayer(attacker, target) {
    if (attacker.id === target.id) {
      this.send(attacker, { type: 'system', text: '자신을 공격할 수는 없다.' });
      return;
    }

    attacker.combatTargetId = `p${target.id}`;
    // Same rationale as _attackMonster: close any lingering object-view panel
    // when the fight actually starts.
    this.send(attacker, { type: 'view', view: null });

    // PvP 도 PvE 와 같은 공격 공식 — base 3 + 장비 attack 합 + random.
    const dmgOut = Math.floor(Math.random() * 8) + 3 + this._totalAttack(attacker);
    const { killingBlow } = this.applyPlayerDamage(target, dmgOut);

    this.seg(attacker, [
      { text: '당신이 ' },
      { text: target.name, cls: 'tx-player' },
      { text: `님에게 ${dmgOut}의 피해를 입혔다.` },
    ]);
    this.seg(target, [
      { text: attacker.name, cls: 'tx-player' },
      { text: '님이 당신에게 ' },
      { text: `${dmgOut}의 피해를 입혔다. 체력: ${target.hp}/${target.maxHp}` },
    ]);

    // Observers in the same room get a public combat log line. Other
    // engaged attackers (combatTargetId === pX) see the panel update too.
    const engagementKey = `p${target.id}`;
    for (const p of this.players.values()) {
      if (p.id === attacker.id || p.id === target.id) continue;
      if (p.roomId !== attacker.roomId) continue;
      this.seg(p, [
        { text: attacker.name, cls: 'tx-player' },
        { text: '님이 ' },
        { text: target.name, cls: 'tx-player' },
        { text: `님에게 ${dmgOut}의 피해를 입혔다.` },
      ]);
      if (p.combatTargetId === engagementKey) {
        this.pushCombat(p, target, 'player', killingBlow ? 'foe' : null, killingBlow ? attacker.name : null);
        if (killingBlow) p.combatTargetId = null;
      }
    }

    // Attacker's panel: shows target as foe.
    this.pushCombat(attacker, target, 'player', killingBlow ? 'foe' : null);
    // Target's panel: shows attacker as foe (relative perspective). When the
    // target falls, their panel goes through the 'me'-fallen branch instead.
    if (!killingBlow) this.pushCombat(target, attacker, 'player');

    if (killingBlow) {
      this.seg(attacker, [
        { text: target.name, cls: 'tx-player' },
        { text: '님이 쓰러졌다!' },
      ]);
      this.send(target, { type: 'system', text: `${attacker.name}님에게 쓰러졌다...` });
      this.pushCombat(target, attacker, 'player', 'me', attacker.name);

      this.broadcastRoom(attacker.roomId, {
        type: 'text',
        segments: [
          { text: target.name, cls: 'tx-player' },
          { text: '님이 ' },
          { text: attacker.name, cls: 'tx-player' },
          { text: '님에게 쓰러졌다.' },
        ],
      }, attacker.id, target.id);

      attacker.combatTargetId = null;
      this._respawnAtSquare(target);
    }
  }

  // Shared respawn flow for both monster-killed and PvP-killed players.
  _respawnAtSquare(player) {
    const fromRoom = player.roomId;
    // Cancel any queued move — a pending direction tied to the pre-death
    // room would relocate the just-respawned player away from the square.
    if (player.pendingMove) {
      clearTimeout(player.pendingMove.timer);
      player.pendingMove = null;
    }
    if (player.pendingAttack) {
      clearTimeout(player.pendingAttack.timer);
      player.pendingAttack = null;
    }
    player.combatTargetId = null;
    player.downed = false;
    // Death clears any pending kill-steal block — the player is no longer in
    // the disputed room, so the anti-flee gate has nothing to enforce.
    player.moveBlockedUntil = 0;
    player.moveBlockedBy = null;
    player.moveBlockedById = null;
    player.hp = Math.floor(player.maxHp * 0.3);
    player.roomId = 'square';
    if (fromRoom !== 'square') {
      // Symmetric to the move case: anyone whose block was anchored to this
      // player's presence in fromRoom can move freely now.
      this._clearKillStealBlocksAgainst(player.id, fromRoom);
      this.broadcastRoom(fromRoom, { type: 'text', text: `${player.name}님이 사라졌다.` });
      this._pushRoomMonsters(fromRoom);
    }
    this.pushStatus(player);
    this.send(player, { type: 'system', text: '정신을 차려보니 광장이다. 체력이 조금 회복됐다.' });
    this.describeRoom(player);
    this.broadcastRoom('square', { type: 'text', text: `${player.name}님이 비틀거리며 나타났다.` }, player.id);
    this._pushRoomMonsters('square');
  }

  say(player, text) {
    if (!text) return;
    const now = Date.now();
    if (now - player.lastSayAt < SAY_COOLDOWN_MS) {
      // Per-player cooldown: rejected (not queued) so a flood doesn't pile up
      // delayed broadcasts. Single notice per blocked attempt.
      this.send(player, { type: 'system', text: '잠시 후 다시 말할 수 있습니다.' });
      return;
    }
    // Truncate, don't reject — long messages still convey intent. The cap
    // bounds the per-room broadcast cost regardless of payload size.
    const msg = text.length > SAY_MAX_LEN ? text.slice(0, SAY_MAX_LEN) : text;
    player.lastSayAt = now;
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}: "${msg}"` });
  }

  // --- helpers ---

  send(player, msg) {
    // Disconnected players (in grace) have socket=null. Sends are silently
    // dropped — they catch up via pushStatus/describeRoom on reattach.
    if (player.socket && player.socket.readyState === 1) {
      player.socket.send(JSON.stringify(msg));
    }
  }

  seg(player, segments) {
    this.send(player, { type: 'text', segments });
  }

  broadcastRoom(roomId, msg, ...exceptIds) {
    const payload = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.roomId !== roomId) continue;
      if (exceptIds.includes(p.id)) continue;
      if (p.socket && p.socket.readyState === 1) p.socket.send(payload);
    }
  }

  pushStatus(player) {
    const klassDef = CLASS_DEFS[player.klass] || CLASS_DEFS.novice;
    // 누적 exp 를 현재 레벨 구간 내 진행도로 변환해 클라이언트가 바로 바로
    // 그릴 수 있게 한다. 마지막 레벨에서는 expNext=0 으로 만렙 표시.
    const lvIdx = Math.min(player.level - 1, EXP_TABLE.length - 1);
    const baseExp = EXP_TABLE[lvIdx];
    const nextExp = lvIdx + 1 < EXP_TABLE.length ? EXP_TABLE[lvIdx + 1] : null;
    const expCur = Math.max(0, player.exp - baseExp);
    const expNext = nextExp == null ? 0 : Math.max(1, nextExp - baseExp);

    // 클라 마법 메뉴 채우기용 — 현재 레벨에서 시전 가능한 마법만 노출.
    // 새로 잠금해제된 마법은 _grantExp 가 system 라인으로 별도 안내.
    const spells = [];
    if (player.klass === 'mage') {
      for (const [id, s] of Object.entries(SPELL_DEFS)) {
        if (player.level >= s.minLevel) {
          spells.push({
            id, name: s.name, mpCost: s.mpCost, element: s.element, minLevel: s.minLevel,
          });
        }
      }
    }

    this.send(player, {
      type: 'status',
      status: {
        name: player.name,
        roomId: player.roomId,
        equipment: player.equipment,
        inventory: player.inventory,
        level: player.level,
        exp: expCur,
        expNext,
        hp: player.hp,
        maxHp: player.maxHp,
        mp: player.mp,
        maxMp: player.maxMp,
        klass: player.klass,
        klassName: klassDef.name,
        spells,
        // 광장에서 레벨 10 이상의 novice 만 전직 가능 — 클라 안내 배지에 사용.
        canChangeClass: player.klass === 'novice' && player.level >= 10 && player.roomId === 'square',
      },
    });
  }

  // `kind` is 'monster' | 'player' — describes the foe relative to the recipient.
  // `fallen` is 'foe' | 'me' | null — relative to the recipient too, so the
  // client can pick the right sprite/animation without knowing absolute identity.
  // `effect` (optional): 일회성 시각 효과(예: 마법 발사체). 클라이언트의
  // renderCombat 이 이 페이로드를 보고 cv-stage 위에 overlay 애니메이션을
  // 띄운다 — 마법 시전과 동시에 도착하는 counter-attack 메시지에 휘말려
  // overlay 가 지워지지 않도록 클라가 stage 만 선택적으로 교체한다(magic.md 「전투 패널 이펙트」 절).
  pushCombat(recipient, foe, kind, fallen = null, killerName = null, effect = null) {
    const foePayload = kind === 'monster'
      ? { kind, name: foe.name, defId: foe.defId, icon: foe.icon, hp: Math.max(0, foe.hp), maxHp: foe.maxHp }
      // Player foe carries `id` so the client can look up the cached sprite
      // delivered via prior `character_sprite` messages. Without it, custom
      // sprites can't be wired to the panel.
      : { kind, id: foe.id, name: foe.name, icon: foe.icon, hp: Math.max(0, foe.hp), maxHp: foe.maxHp };
    this.send(recipient, {
      type: 'combat',
      combat: {
        // Recipient's own id, so the client knows whose sprite to draw on the
        // "me" side from its character_sprite cache.
        // mp / maxMp 도 함께 — 전투 패널이 본인 쪽에 MP 바를 렌더(maxMp > 0
        // 인 직업, 즉 mage 한정). novice 는 maxMp=0 이라 클라가 자연스럽게 숨김.
        player: { id: recipient.id, name: recipient.name, icon: recipient.icon, hp: Math.max(0, recipient.hp), maxHp: recipient.maxHp, mp: Math.max(0, recipient.mp || 0), maxMp: recipient.maxMp || 0 },
        foe: foePayload,
        fallen,
        killerName, // when fallen==='foe' and killer != recipient, the killer's display name
        effect,
      },
    });
  }

  clearCombat(player) {
    this.send(player, { type: 'combat', combat: null });
  }
}
