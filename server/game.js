// Authoritative game state. Single in-memory world.
// All commands flow through Game.handleCommand(player, input).

let nextPlayerId = 1;

// Forest is a 5×5 grid: forest_<col>_<row>, col/row in 0..4.
// Rooms are generated procedurally; FOREST_OVERRIDES supplies prose & object
// placement for the few "named" landmarks. Generic squares get fallback text.
const FOREST_SIZE = 5;
const FOREST_OVERRIDES = {
  '0_0': {
    name: '숲 입구',
    desc: '신전 동쪽의 숲 가장자리. 울창한 나무들이 빛을 가리기 시작한다.',
    objects: ['forest_signpost'],
  },
  '4_0': {
    name: '북동 안개',
    desc: '짙은 안개가 깔린 숲의 북동쪽 끝. 나무 사이로 바람 소리만 들린다.',
  },
  '3_1': {
    name: '옹달샘',
    desc: '맑은 물이 솟는 작은 샘. 이끼 낀 바위에 둘러싸여 있다.',
    objects: ['spring'],
  },
  '2_2': {
    name: '숲 광장',
    desc: '거대한 고목이 하늘을 떠받치는 둥근 빈터. 잎 사이로 햇빛이 내려앉는다.',
    objects: ['ancient_tree'],
  },
  '1_3': {
    name: '버섯 군락',
    desc: '낙엽 위로 핏빛 갓의 버섯이 줄지어 자라 있다.',
    objects: ['mushrooms'],
  },
  '0_4': {
    name: '부서진 사당',
    desc: '돌기둥이 무너진 작은 사당터. 이끼가 모든 것을 덮고 있다.',
    objects: ['stone_pillar'],
  },
  '4_4': {
    name: '숲의 심장',
    desc: '숲의 가장 깊은 곳. 짙은 그늘 속에 검은 돌 제단이 서 있다.',
    objects: ['forest_altar'],
  },
};

function buildForestRooms() {
  const out = {};
  for (let r = 0; r < FOREST_SIZE; r++) {
    for (let c = 0; c < FOREST_SIZE; c++) {
      const id = `forest_${c}_${r}`;
      const exits = {};
      if (r > 0) exits.north = `forest_${c}_${r - 1}`;
      if (r < FOREST_SIZE - 1) exits.south = `forest_${c}_${r + 1}`;
      if (c > 0) exits.west = `forest_${c - 1}_${r}`;
      if (c < FOREST_SIZE - 1) exits.east = `forest_${c + 1}_${r}`;
      if (c === 0 && r === 0) exits.west = 'temple';

      const ov = FOREST_OVERRIDES[`${c}_${r}`] || {};
      out[id] = {
        id,
        name: ov.name || `숲 (${c},${r})`,
        desc: ov.desc || '울창한 나무들 사이로 좁은 길이 이어진다.',
        exits,
        objects: ov.objects || [],
      };
    }
  }
  return out;
}

const ROOMS = {
  square: {
    id: 'square',
    name: '아라그리아 광장',
    desc: '돌로 포장된 넓은 광장이다. 분수에서 물이 흐르고, 북쪽으로 시장이, 동쪽으로 신전이 보인다.',
    exits: { north: 'market', east: 'temple' },
    objects: ['fountain', 'crystal'],
  },
  market: {
    id: 'market',
    name: '시장 거리',
    desc: '상인들의 외침이 가득한 좁은 거리. 남쪽으로 광장이 있다.',
    exits: { south: 'square' },
    objects: ['stall'],
  },
  temple: {
    id: 'temple',
    name: '낡은 신전',
    desc: '먼지 쌓인 석상이 줄지어 서 있다. 서쪽으로 광장이, 동쪽으로 울창한 숲이 보인다.',
    exits: { west: 'square', east: 'forest_0_0' },
    objects: ['statue'],
  },
  ...buildForestRooms(),
};

const MONSTER_DEFS = {
  goblin: {
    name: '고블린',
    icon: '👹',
    desc: '작고 교활한 눈빛의 녹색 생명체. 녹슨 단검을 들고 있다.',
    hp: 20, maxHp: 20, atk: 5,
  },
  skeleton: {
    name: '해골 전사',
    icon: '💀',
    desc: '낡은 갑옷을 입은 뼈만 남은 전사. 텅 빈 눈구멍에서 붉은 빛이 흔들린다.',
    hp: 35, maxHp: 35, atk: 8,
  },
};

let nextMonsterId = 1;
function spawnMonster(defId) {
  const def = MONSTER_DEFS[defId];
  return { id: nextMonsterId++, defId, name: def.name, icon: def.icon, hp: def.hp, maxHp: def.maxHp, atk: def.atk };
}

// Objects with `view` get UI rendering on `look`. Without `view`, prose only.
const OBJECTS = {
  fountain: {
    name: '분수',
    desc: '맑은 물이 끊임없이 솟아오른다.',
    // prose only — no `view`
  },
  crystal: {
    name: '수정 조각상',
    desc: '광장 한가운데 박힌 푸른 수정. 안쪽에서 빛이 맥박처럼 뛴다.',
    view: {
      icon: '◆',
      title: '아라그리아의 수정',
      tags: ['신성', '고대유물'],
      stats: [
        { label: '마나 공명', value: 87, max: 100 },
        { label: '균열도', value: 12, max: 100 },
      ],
      lore: '천 년 전, 첫 왕이 이곳에 박아 넣었다고 전해진다.',
    },
  },
  stall: {
    name: '노점',
    desc: '먹을거리와 잡화가 어지러이 쌓여 있다.',
  },
  statue: {
    name: '석상',
    desc: '얼굴이 깎여나간 옛 신의 석상.',
    view: {
      icon: '☖',
      title: '잊혀진 신의 석상',
      tags: ['고대', '훼손'],
      stats: [
        { label: '봉인 강도', value: 3, max: 100 },
      ],
      lore: '이름은 더 이상 누구도 기억하지 못한다.',
    },
  },
  forest_signpost: {
    name: '나무 표지판',
    desc: '낡은 나무 표지판에 서툰 글씨로 "숲 안쪽엔 들어가지 마시오"라 새겨져 있다.',
  },
  ancient_tree: {
    name: '고목',
    desc: '천 년은 됐을 법한 거대한 나무. 줄기에 사람 형상의 뒤틀린 흉터가 있다.',
    view: {
      icon: '✤',
      title: '천 년의 고목',
      tags: ['신성', '자연'],
      stats: [
        { label: '수령', value: 92, max: 100 },
        { label: '정령 친화', value: 64, max: 100 },
      ],
      lore: '뿌리가 어디까지 뻗어 있는지 누구도 모른다.',
    },
  },
  spring: {
    name: '옹달샘',
    desc: '바닥의 자갈까지 비치는 맑은 샘물. 한 모금 마시면 피로가 가시는 듯하다.',
  },
  mushrooms: {
    name: '핏빛 버섯',
    desc: '핏빛 갓의 버섯이 군락을 이루고 있다. 만지면 위험할지도 모른다.',
  },
  stone_pillar: {
    name: '부서진 돌기둥',
    desc: '깨진 돌기둥에 잊혀진 룬 문양이 새겨져 있다.',
    view: {
      icon: '⚱',
      title: '잊혀진 사당의 돌기둥',
      tags: ['고대', '훼손'],
      stats: [
        { label: '룬 잔존', value: 21, max: 100 },
      ],
      lore: '문양은 지워졌지만, 신성의 기운은 아직 머문다.',
    },
  },
  forest_altar: {
    name: '검은 제단',
    desc: '숲 속에 외따로 선 검은 돌 제단. 표면에 마른 핏자국이 남아 있다.',
    view: {
      icon: '☗',
      title: '숲의 검은 제단',
      tags: ['금기', '의식'],
      stats: [
        { label: '봉인', value: 4, max: 100 },
        { label: '오염', value: 88, max: 100 },
      ],
      lore: '여기서 무언가가 깨어나고 있다.',
    },
  },
};

const STARTING_EQUIPMENT = () => ({
  head: null,
  body: { id: 'tunic', name: '낡은 튜닉', icon: '⛊' },
  weapon: { id: 'short_sword', name: '단검', icon: '†' },
  offhand: null,
  feet: { id: 'boots', name: '가죽 부츠', icon: '⛢' },
});

const STARTING_INVENTORY = () => ([
  { id: 'potion_hp', name: '체력 물약', icon: '❦', qty: 3 },
  { id: 'bread', name: '빵', icon: '⌬', qty: 2 },
  { id: 'rope', name: '밧줄', icon: '∽', qty: 1 },
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
    this.roomMonsters = new Map();
    this._spawnMonsters();
  }

  _spawnMonsters() {
    this.roomMonsters.set('market', [spawnMonster('goblin')]);
    this.roomMonsters.set('temple', [spawnMonster('skeleton')]);
  }

  addPlayer(socket) {
    const id = nextPlayerId++;
    const player = {
      id,
      name: `여행자${id}`,
      socket,
      roomId: 'square',
      hp: 100,
      maxHp: 100,
      icon: '🧙',
      equipment: STARTING_EQUIPMENT(),
      inventory: STARTING_INVENTORY(),
    };
    this.players.set(id, player);

    this.send(player, { type: 'system', text: `아라그리아에 오신 것을 환영합니다, ${player.name}.` });
    this.pushStatus(player);
    this.describeRoom(player);
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 이곳에 도착했습니다.` }, player.id);
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.broadcastRoom(p.roomId, { type: 'text', text: `${p.name}님이 떠났습니다.` });
  }

  handleCommand(player, raw) {
    const input = String(raw || '').trim();
    if (!input) return;
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
        return this.attackMonster(player, arg);
      case 'use':
      case '사용': case '사용하다': case '써': case '쓰다': case '먹다':
        return this.useItem(player, arg);
      case 'help':
      case '도움말': case '도움': case '명령어': case '명령':
        return this.send(player, { type: 'text', text: '명령: 보기 [대상], 이동 <방향>, 공격 <대상>, 말 <내용>, 사용 <아이템>, 도움말' });
      default:
        if (['north','south','east','west','n','s','e','w','북','남','동','서','북쪽','남쪽','동쪽','서쪽'].includes(cmd)) {
          return this.move(player, cmd);
        }
        this.send(player, { type: 'system', text: `알 수 없는 명령: ${cmd}` });
    }
  }

  describeRoom(player) {
    const room = ROOMS[player.roomId];
    const exits = Object.keys(room.exits).join(', ') || '(없음)';
    const objs = room.objects.map(o => OBJECTS[o]?.name).filter(Boolean).join(', ') || '(없음)';
    const others = [...this.players.values()]
      .filter(p => p.roomId === room.id && p.id !== player.id)
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
  }

  lookAt(player, target) {
    const room = ROOMS[player.roomId];
    const objKey = room.objects.find(o => {
      const obj = OBJECTS[o];
      return obj && (o === target || obj.name === target || obj.name.includes(target));
    });
    // also search monsters
    if (!objKey) {
      const monsters = this.roomMonsters.get(player.roomId) || [];
      const monster = monsters.find(m => m.name.includes(target) || m.defId === target);
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
      this.send(player, { type: 'system', text: `'${target}'을(를) 찾을 수 없습니다.` });
      return;
    }
    const obj = OBJECTS[objKey];
    this.send(player, { type: 'text', text: obj.desc });
    if (obj.view) {
      this.send(player, { type: 'view', view: { ...obj.view, name: obj.name } });
    } else {
      this.send(player, { type: 'view', view: null });
    }
  }

  move(player, dir) {
    const map = { n: 'north', s: 'south', e: 'east', w: 'west', '북': 'north', '남': 'south', '동': 'east', '서': 'west', '북쪽': 'north', '남쪽': 'south', '동쪽': 'east', '서쪽': 'west' };
    const d = map[dir] || dir;
    const room = ROOMS[player.roomId];
    const next = room.exits[d];
    if (!next) {
      this.send(player, { type: 'system', text: '그 방향으로는 갈 수 없습니다.' });
      return;
    }
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 ${d} 방향으로 떠났습니다.` }, player.id);
    player.roomId = next;
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 도착했습니다.` }, player.id);
    this.clearCombat(player);
    this.pushStatus(player);
    this.describeRoom(player);
  }

  useItem(player, arg) {
    if (!arg) {
      this.send(player, { type: 'system', text: '사용할 아이템을 지정하세요.' });
      return;
    }
    const idx = player.inventory.findIndex(
      it => it.id === arg || it.name === arg || it.name.includes(arg)
    );
    if (idx === -1) {
      this.send(player, { type: 'system', text: `'${arg}'을(를) 소지하고 있지 않습니다.` });
      return;
    }
    const item = player.inventory[idx];
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
  }

  attackMonster(player, arg) {
    const monsters = this.roomMonsters.get(player.roomId) || [];
    const target = arg
      ? monsters.find(m => m.name.includes(arg) || m.defId === arg)
      : monsters[0];

    if (!target) {
      this.send(player, { type: 'system', text: arg ? `'${arg}'을(를) 찾을 수 없습니다.` : '공격할 대상이 없습니다.' });
      return;
    }

    const hasWeapon = !!player.equipment.weapon;
    const dmgOut = Math.floor(Math.random() * 8) + (hasWeapon ? 8 : 3);
    target.hp -= dmgOut;
    this.seg(player, [
      { text: '당신이 ' },
      { text: target.name, cls: 'monster-name' },
      { text: `에게 ${dmgOut}의 피해를 입혔다.` },
    ]);

    if (target.hp <= 0) {
      const list = this.roomMonsters.get(player.roomId);
      list.splice(list.indexOf(target), 1);
      this.seg(player, [{ text: target.name, cls: 'monster-name' }, { text: '이(가) 쓰러졌다!' }]);
      this.pushCombat(player, target, 'monster');
      return;
    }

    const dmgIn = Math.floor(Math.random() * target.atk) + 1;
    player.hp = Math.max(0, player.hp - dmgIn);
    this.seg(player, [
      { text: target.name, cls: 'monster-name' },
      { text: `이(가) 반격해 ${dmgIn}의 피해를 입혔다. 체력: ${player.hp}/${player.maxHp}` },
    ]);

    if (player.hp <= 0) {
      this.send(player, { type: 'system', text: '의식을 잃고 쓰러졌다...' });
      this.pushCombat(player, target, 'player');
      player.hp = Math.floor(player.maxHp * 0.3);
      player.roomId = 'square';
      this.pushStatus(player);
      this.send(player, { type: 'system', text: '정신을 차려보니 광장이다. 체력이 조금 회복됐다.' });
      this.describeRoom(player);
      return;
    }
    this.pushCombat(player, target);
    this.pushStatus(player);
  }

  say(player, text) {
    if (!text) return;
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}: "${text}"` });
  }

  // --- helpers ---

  send(player, msg) {
    if (player.socket.readyState === 1) player.socket.send(JSON.stringify(msg));
  }

  seg(player, segments) {
    this.send(player, { type: 'text', segments });
  }

  broadcastRoom(roomId, msg, exceptId = null) {
    const payload = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.roomId !== roomId) continue;
      if (p.id === exceptId) continue;
      if (p.socket.readyState === 1) p.socket.send(payload);
    }
  }

  pushStatus(player) {
    this.send(player, {
      type: 'status',
      status: {
        name: player.name,
        roomId: player.roomId,
        equipment: player.equipment,
        inventory: player.inventory,
      },
    });
  }

  pushCombat(player, monster, fallen = null) {
    this.send(player, {
      type: 'combat',
      combat: {
        player: { name: player.name, icon: player.icon, hp: Math.max(0, player.hp), maxHp: player.maxHp },
        monster: { name: monster.name, icon: monster.icon, hp: Math.max(0, monster.hp), maxHp: monster.maxHp },
        fallen, // 'monster' | 'player' | null
      },
    });
  }

  clearCombat(player) {
    this.send(player, { type: 'combat', combat: null });
  }
}
