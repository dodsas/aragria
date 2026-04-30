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
2. Place it into a room by adding `this.roomMonsters.set('<roomId>', [spawnMonster('<defId>')])` inside `Game._spawnMonsters()`.
3. If introducing a new tier, also add a `MONSTER_RESPAWN_MS[<tier>]` entry in `server/config.js`.

That's it — no client-side changes are required. Icons render via the existing `combat` message protocol.

## Icons

Icons are text glyphs (single emoji or symbol). Pick one that visually communicates the monster's nature; the combat view scales it as a sprite. If no Unicode glyph fits, fall back to a typographic symbol (e.g. `☠`, `✦`).
