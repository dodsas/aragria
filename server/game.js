// Authoritative game state. Single in-memory world.
// All commands flow through Game.handleCommand(player, input).

let nextPlayerId = 1;

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
    desc: '먼지 쌓인 석상이 줄지어 서 있다. 서쪽으로 광장이 있다.',
    exits: { west: 'square' },
    objects: ['statue'],
  },
};

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

export class Game {
  constructor() {
    this.players = new Map(); // id -> player
  }

  addPlayer(socket) {
    const id = nextPlayerId++;
    const player = {
      id,
      name: `여행자${id}`,
      socket,
      roomId: 'square',
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
      case 'look':
      case 'l':
      case '보기':
        return arg ? this.lookAt(player, arg) : this.describeRoom(player);
      case 'go':
      case 'move':
      case '이동':
        return this.move(player, arg);
      case 'say':
      case '말':
        return this.say(player, arg);
      case 'help':
      case '도움말':
        return this.send(player, { type: 'text', text: '명령: look [대상], go <방향>, say <말>, help' });
      default:
        // direction shorthand
        if (['north', 'south', 'east', 'west', 'n', 's', 'e', 'w', '북', '남', '동', '서'].includes(cmd)) {
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
    if (others) this.send(player, { type: 'text', text: `이곳에 있는 사람: ${others}` });
    this.send(player, { type: 'text', text: `출구: ${exits}` });
    // Looking at the room itself clears any object-view panel.
    this.send(player, { type: 'view', view: null });
  }

  lookAt(player, target) {
    const room = ROOMS[player.roomId];
    const objKey = room.objects.find(o => {
      const obj = OBJECTS[o];
      return obj && (o === target || obj.name === target || obj.name.includes(target));
    });
    if (!objKey) {
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
    const map = { n: 'north', s: 'south', e: 'east', w: 'west', '북': 'north', '남': 'south', '동': 'east', '서': 'west' };
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
    this.describeRoom(player);
  }

  say(player, text) {
    if (!text) return;
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}: "${text}"` });
  }

  // --- helpers ---

  send(player, msg) {
    if (player.socket.readyState === 1) {
      player.socket.send(JSON.stringify(msg));
    }
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
        equipment: player.equipment,
        inventory: player.inventory,
      },
    });
  }
}
