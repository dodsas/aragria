// Authoritative game state. Single in-memory world.
// All commands flow through Game.handleCommand(player, input).

import { MONSTER_RESPAWN_MS, DEFAULT_MONSTER_TIER, ATTACK_COOLDOWN_MS, MOVE_COOLDOWN_MS, KILLSTEAL_MOVE_BLOCK_MS } from './config.js';
import { loadZones } from './zones/index.js';

let nextPlayerId = 1;

// 룸/오브젝트/초기 스폰 콘텐츠는 zone 모듈에 분리되어 있다(server/zones/, zone.md).
// 부팅 시 한 번 머지하여 글로벌 사전을 만든다. 룩업 모델은 그대로 — ROOMS[id], OBJECTS[key].
const { rooms: ROOMS, objects: OBJECTS, spawns: INITIAL_SPAWNS } = loadZones();

// Monster definitions. `tier` controls respawn timing (see config.js).
// Tier 1 = lowest. Higher tiers can be added later with their own respawn ranges.
const MONSTER_DEFS = {
  goblin: {
    tier: 1,
    name: '고블린',
    icon: '🧌',
    desc: '작고 교활한 눈빛의 녹색 생명체. 녹슨 단검을 들고 있다.',
    hp: 20, maxHp: 20, atk: 5,
  },
  skeleton: {
    tier: 1,
    name: '해골 전사',
    icon: '☠',
    desc: '낡은 갑옷을 입은 뼈만 남은 전사. 텅 빈 눈구멍에서 붉은 빛이 흔들린다.',
    hp: 35, maxHp: 35, atk: 8,
  },
};

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
  };
}

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
      combatTargetId: null,
      downed: false,
      lastAttackAt: 0,
      lastMoveAt: 0,
      pendingMove: null,
      moveBlockedUntil: 0,
      moveBlockedBy: null,
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
    if (p.pendingMove) clearTimeout(p.pendingMove.timer);
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
        return this.attack(player, arg);
      case 'use':
      case '사용': case '사용하다': case '써': case '쓰다': case '먹다':
        return this.useItem(player, arg);
      case 'help':
      case '도움말': case '도움': case '명령어': case '명령':
        return this.send(player, { type: 'text', text: '명령: 보기 [대상], 이동 <방향>, 공격 <대상/플레이어>, 말 <내용>, 사용 <아이템>, 도움말' });
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

  // Resolution order: self-shortcuts → room objects → monsters → players in
  // the same room. Misses fall through to a "not found" system message.
  lookAt(player, target) {
    if (['나', '나를', '내가', 'me', 'self', '자신'].includes(target)) {
      return this._lookPlayer(player, player, true);
    }

    const room = ROOMS[player.roomId];
    const objKey = room.objects.find(o => {
      const obj = OBJECTS[o];
      return obj && (o === target || obj.name === target || obj.name.includes(target));
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

    const someone = [...this.players.values()].find(p =>
      p.roomId === player.roomId &&
      (p.name === target || p.name.includes(target) || String(p.id) === target)
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
    this.send(viewer, {
      type: 'text',
      text: isSelf ? '거울에 비친 자신을 본다.' : '또 다른 여행자다. 눈빛에 알 수 없는 의도가 비친다.',
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
      const remainSec = Math.ceil((player.moveBlockedUntil - now) / 1000);
      const blocker = player.moveBlockedBy || '누군가';
      this.send(player, { type: 'system', text: `${blocker}님이 당신의 이동을 방해중입니다. (${remainSec}초 후 이동가능)` });
      return;
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
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 ${d} 방향으로 떠났습니다.` }, player.id);
    player.roomId = next;
    this.broadcastRoom(player.roomId, { type: 'text', text: `${player.name}님이 도착했습니다.` }, player.id);
    this.clearCombat(player);
    player.combatTargetId = null;
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

  // Dispatcher: resolve the target by name/id, prefer monsters then players.
  // Self-targeting is rejected. Argless `attack` falls through to first live
  // monster (existing behavior); never auto-targets a player.
  //
  // Rate limit (ATTACK_COOLDOWN_MS) is enforced here, BEFORE target resolution,
  // so spam is rejected at the boundary regardless of whether a target exists.
  // The server is authoritative — see `command.md`.
  attack(player, arg) {
    const now = Date.now();
    const elapsed = now - player.lastAttackAt;
    if (elapsed < ATTACK_COOLDOWN_MS) {
      const remain = ATTACK_COOLDOWN_MS - elapsed;
      this.send(player, { type: 'system', text: `아직 다음 공격 준비가 끝나지 않았다. (${remain}ms)` });
      return;
    }
    player.lastAttackAt = now;

    const monsters = this.roomMonsters.get(player.roomId) || [];

    if (arg) {
      const monster = monsters.find(m => !m.dead && (m.name.includes(arg) || m.defId === arg));
      if (monster) return this._attackMonster(player, monster);

      const other = [...this.players.values()].find(p =>
        p.id !== player.id && p.roomId === player.roomId && !p.downed &&
        (p.name === arg || p.name.includes(arg) || String(p.id) === arg)
      );
      if (other) return this._attackPlayer(player, other);

      this.send(player, { type: 'system', text: `'${arg}'을(를) 찾을 수 없습니다.` });
      return;
    }

    const monster = monsters.find(m => !m.dead);
    if (monster) return this._attackMonster(player, monster);
    this.send(player, { type: 'system', text: '공격할 대상이 없습니다.' });
  }

  _attackMonster(player, target) {
    player.combatTargetId = `m${target.id}`;

    const hasWeapon = !!player.equipment.weapon;
    const dmgOut = Math.floor(Math.random() * 8) + (hasWeapon ? 8 : 3);
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
        if (!killStealVictimName) killStealVictimName = p.name;
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
      if (killStealVictimName) {
        // Anti-grief: kill-stealer can't immediately walk away. Cancel any
        // queued move first — otherwise it would auto-fire under the block.
        if (player.pendingMove) {
          clearTimeout(player.pendingMove.timer);
          player.pendingMove = null;
        }
        player.moveBlockedUntil = Date.now() + KILLSTEAL_MOVE_BLOCK_MS;
        player.moveBlockedBy = killStealVictimName;
        const sec = Math.ceil(KILLSTEAL_MOVE_BLOCK_MS / 1000);
        this.send(player, { type: 'system', text: `${killStealVictimName}님이 당신의 이동을 방해중입니다. (${sec}초 후 이동가능)` });
      }
      this.scheduleRespawn(roomId, target.defId);
      return;
    }

    // Counter-attack only retaliates against the player who landed this hit.
    const dmgIn = Math.floor(Math.random() * target.atk) + 1;
    player.hp = Math.max(0, player.hp - dmgIn);
    this.seg(player, [
      { text: target.name, cls: 'monster-name' },
      { text: `이(가) 반격해 ${dmgIn}의 피해를 입혔다. 체력: ${player.hp}/${player.maxHp}` },
    ]);

    if (player.hp <= 0) {
      this.send(player, { type: 'system', text: '의식을 잃고 쓰러졌다...' });
      this.pushCombat(player, target, 'monster', 'me');
      this._respawnAtSquare(player);
      return;
    }
    this.pushCombat(player, target, 'monster');
    this.pushStatus(player);
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

    const hasWeapon = !!attacker.equipment.weapon;
    const dmgOut = Math.floor(Math.random() * 8) + (hasWeapon ? 8 : 3);
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
    player.combatTargetId = null;
    player.downed = false;
    // Death clears any pending kill-steal block — the player is no longer in
    // the disputed room, so the anti-flee gate has nothing to enforce.
    player.moveBlockedUntil = 0;
    player.moveBlockedBy = null;
    player.hp = Math.floor(player.maxHp * 0.3);
    player.roomId = 'square';
    if (fromRoom !== 'square') {
      this.broadcastRoom(fromRoom, { type: 'text', text: `${player.name}님이 사라졌다.` });
    }
    this.pushStatus(player);
    this.send(player, { type: 'system', text: '정신을 차려보니 광장이다. 체력이 조금 회복됐다.' });
    this.describeRoom(player);
    this.broadcastRoom('square', { type: 'text', text: `${player.name}님이 비틀거리며 나타났다.` }, player.id);
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

  broadcastRoom(roomId, msg, ...exceptIds) {
    const payload = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.roomId !== roomId) continue;
      if (exceptIds.includes(p.id)) continue;
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

  // `kind` is 'monster' | 'player' — describes the foe relative to the recipient.
  // `fallen` is 'foe' | 'me' | null — relative to the recipient too, so the
  // client can pick the right sprite/animation without knowing absolute identity.
  pushCombat(recipient, foe, kind, fallen = null, killerName = null) {
    const foePayload = kind === 'monster'
      ? { kind, name: foe.name, defId: foe.defId, icon: foe.icon, hp: Math.max(0, foe.hp), maxHp: foe.maxHp }
      : { kind, name: foe.name, icon: foe.icon, hp: Math.max(0, foe.hp), maxHp: foe.maxHp };
    this.send(recipient, {
      type: 'combat',
      combat: {
        player: { name: recipient.name, icon: recipient.icon, hp: Math.max(0, recipient.hp), maxHp: recipient.maxHp },
        foe: foePayload,
        fallen,
        killerName, // when fallen==='foe' and killer != recipient, the killer's display name
      },
    });
  }

  clearCombat(player) {
    this.send(player, { type: 'combat', combat: null });
  }
}
