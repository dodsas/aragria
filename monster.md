# Monster System

This document is the contract for how monsters are defined, spawned, and respawned in Aragria. Game logic lives in `server/game.js`; tunable knobs live in `server/config.js`.

## Definition

Monsters are declared in `MONSTER_DEFS` (in `server/game.js`). Each entry has:

| field   | type   | meaning                                                                 |
|---------|--------|-------------------------------------------------------------------------|
| `tier`  | number | Difficulty tier — currently only `1` (lowest) exists. Drives respawn.   |
| `name`  | string | Display name.                                                           |
| `icon`  | string | Single-glyph icon shown in the combat view (and elsewhere).             |
| `desc`  | string | Prose shown when the monster is `look`ed at.                            |
| `hp`    | number | Starting HP at spawn.                                                   |
| `maxHp` | number | Maximum HP (used for the HP bar denominator).                           |
| `atk`   | number | Damage rolled on counter-attack (`floor(random*atk) + 1`).              |

A spawned monster carries a copy of these fields plus a unique `id` and `defId` (the key it was spawned from).

## Tiers

Tiers segment monsters by difficulty and govern respawn timing. Higher tiers can be added later; for now only tier 1 is defined.

| tier | description                | examples              |
|------|----------------------------|-----------------------|
| 1    | Common, low-stakes mobs.   | 고블린, 해골 전사     |

## Respawn

When a monster is killed, the slain monster is removed from its room, and a fresh instance of the same `defId` is scheduled to respawn into the **same room** after a random delay drawn from the tier's range.

Respawn ranges live in `server/config.js`:

```js
export const MONSTER_RESPAWN_MS = {
  1: [10_000, 30_000],   // tier 1: 10s–30s
};
```

The delay is uniform: `min + floor(random * (max - min + 1))`. To change tier 1 respawn timing, edit only `MONSTER_RESPAWN_MS`. Game code never hardcodes timings.

When the monster respawns, players currently in the room receive a single `text` message segment announcing its appearance (no broadcast to the rest of the world).

## Adding a new monster

1. Add an entry to `MONSTER_DEFS` with all required fields, including `tier`.
2. Place it into a room by adding `{ roomId: '<roomId>', defId: '<defId>' }` to the `spawns` array of the appropriate zone module under `server/zones/` (see `zone.md`).
3. If introducing a new tier, also add a `MONSTER_RESPAWN_MS[<tier>]` entry in `server/config.js`.

That's it — no client-side changes are required. Icons render via the existing `combat` message protocol.

## Concurrency (shared HP across attackers)

A spawned monster's HP is **room-shared**: every player attacking the same instance reduces the same `monster.hp`, and the new value is broadcast in real time to every player currently engaged with that monster. Two travelers hitting the same skeleton see the same HP bar drain.

This is the contract — `server/game.js` must keep the following invariants:

- **Atomic damage application.** All HP mutation goes through `Game.applyMonsterDamage(monster, dmg)`. It performs a single read-modify-write — read `monster.hp`, clamp `max(0, hp - dmg)`, set the killing-blow flag — inside one synchronous block. Node's single-threaded event loop guarantees no other attack handler interleaves, so the read and write cannot race. Do not mutate `monster.hp` directly anywhere else.
- **Exactly-once kill credit.** `applyMonsterDamage` returns `{ killingBlow: true }` only for the call that drives HP from positive to zero, and at that moment flips `monster.dead = true`. Subsequent attacks (even ones queued in the same tick) see `dead === true`, are filtered out by `attackMonster`'s target search (`!m.dead`), and never schedule a second respawn. One monster instance → one kill, one respawn timer.
- **Engagement set tracks who sees live HP.** Each player carries `player.combatTargetId`, set when they `attack` a monster and cleared when they (a) move to another room, (b) die, or (c) the targeted monster falls. After damage is applied, `attackMonster` iterates `players` once and pushes a `combat` HP update to every player whose `combatTargetId === monster.id`. Fan-out is bounded by the engaged group, not the room or the world — important for the 1k-concurrent target.
- **Counter-attack is per-attacker, HP is shared.** The monster only retaliates against the player who landed *this* hit. Other engaged players watch the HP drop on their combat panel but take no damage from the broadcast. Damage taken is private; damage dealt is public.
- **Respawned monsters are new instances.** Respawn allocates a fresh `id` via `nextMonsterId++`. Stale `combatTargetId` values from before the kill never collide with the new monster — engaged players must `attack` again to re-engage.

When adding a new combat-related action (DoT, AoE, channeled spells), route every HP mutation through `applyMonsterDamage` and broadcast to the engagement set the same way. Do not introduce a parallel mutation path — it will silently break exactly-once kill credit and the live HP guarantee.

## Icons

Icons are text glyphs (single emoji or symbol). Pick one that visually communicates the monster's nature; the combat view scales it as a sprite. If no Unicode glyph fits, fall back to a typographic symbol (e.g. `☠`, `✦`).
