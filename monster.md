# Monster System

This document is the contract for how monsters are defined, spawned, and respawned in Aragria. Game logic lives in `server/game.js`; tunable knobs live in `server/config.js`.

## Definition

Monsters are declared in `MONSTER_DEFS` (in `server/game.js`). Each entry has:

| field   | type   | meaning                                                                 |
|---------|--------|-------------------------------------------------------------------------|
| `tier`  | number | Difficulty tier — currently only `1` (lowest) exists. Drives respawn.   |
| `name`  | string | Display name.                                                           |
| `icon`  | string | **Fallback** glyph for the combat view. Used only when no SVG sprite is registered for `defId` (see [Sprite](#sprite-svg)). Always set one — the client falls back to it for unknown monsters. |
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

1. Add an entry to `MONSTER_DEFS` with all required fields, including `tier`. Always set `icon` to a sensible emoji/glyph fallback even if you intend to ship a sprite.
2. Place it into a room by adding `{ roomId: '<roomId>', defId: '<defId>' }` to the `spawns` array of the appropriate zone module under `server/zones/` (see `zone.md`).
3. If introducing a new tier, also add a `MONSTER_RESPAWN_MS[<tier>]` entry in `server/config.js`.
4. **Author an SVG sprite** for the monster following the [Sprite (SVG)](#sprite-svg) section below, and register it in `MONSTER_SPRITES` (in `public/client.js`). Without this step the monster falls back to its `icon` glyph in combat — acceptable temporarily, but every monster shipped to players should have a sprite.

The server protocol carries `defId` in the `combat` payload; the client picks the sprite by `defId` lookup. No new message types are needed.

## Concurrency (shared HP across attackers)

A spawned monster's HP is **room-shared**: every player attacking the same instance reduces the same `monster.hp`, and the new value is broadcast in real time to every player currently engaged with that monster. Two travelers hitting the same skeleton see the same HP bar drain.

This is the contract — `server/game.js` must keep the following invariants:

- **Atomic damage application.** All HP mutation goes through `Game.applyMonsterDamage(monster, dmg)`. It performs a single read-modify-write — read `monster.hp`, clamp `max(0, hp - dmg)`, set the killing-blow flag — inside one synchronous block. Node's single-threaded event loop guarantees no other attack handler interleaves, so the read and write cannot race. Do not mutate `monster.hp` directly anywhere else.
- **Exactly-once kill credit.** `applyMonsterDamage` returns `{ killingBlow: true }` only for the call that drives HP from positive to zero, and at that moment flips `monster.dead = true`. Subsequent attacks (even ones queued in the same tick) see `dead === true`, are filtered out by `attackMonster`'s target search (`!m.dead`), and never schedule a second respawn. One monster instance → one kill, one respawn timer.
- **Engagement set tracks who sees live HP.** Each player carries `player.combatTargetId`, set when they `attack` a monster and cleared when they (a) move to another room, (b) die, or (c) the targeted monster falls. After damage is applied, `attackMonster` iterates `players` once and pushes a `combat` HP update to every player whose `combatTargetId === monster.id`. Fan-out is bounded by the engaged group, not the room or the world — important for the 1k-concurrent target.
- **Counter-attack is per-attacker, HP is shared.** The monster only retaliates against the player who landed *this* hit. Other engaged players watch the HP drop on their combat panel but take no damage from the broadcast. Damage taken is private; damage dealt is public.
- **Respawned monsters are new instances.** Respawn allocates a fresh `id` via `nextMonsterId++`. Stale `combatTargetId` values from before the kill never collide with the new monster — engaged players must `attack` again to re-engage.

When adding a new combat-related action (DoT, AoE, channeled spells), route every HP mutation through `applyMonsterDamage` and broadcast to the engagement set the same way. Do not introduce a parallel mutation path — it will silently break exactly-once kill credit and the live HP guarantee.

## Sprite (SVG)

Each shipped monster has an inline SVG sprite drawn in `public/client.js`. Sprites are the primary combat visual; the `icon` glyph is a fallback for unregistered monsters only. **Every new monster needs a sprite — read this whole section before authoring one.**

### Where it lives

- Sprite functions are top-level `function <defId>SpriteSvg()` declarations in `public/client.js`. Each returns an SVG string.
- They are registered in the `MONSTER_SPRITES` map (also in `client.js`), keyed by `defId`:
  ```js
  const MONSTER_SPRITES = {
    goblin:   () => goblinSpriteSvg(),
    skeleton: () => skeletonSpriteSvg(),
  };
  ```
- `makeCombatActor` looks up `MONSTER_SPRITES[actor.defId]` for any foe; on hit it sets `cv-sprite-svg` and inlines the returned markup. On miss, it renders `actor.icon` instead.

### Canvas contract

| field          | value                                              |
|----------------|----------------------------------------------------|
| `viewBox`      | `0 0 100 140` (width 100, height 140)              |
| Display size   | 86 × 120 px (set by `.cv-sprite-svg` in `style.css`)|
| Aspect         | Roughly 5:7 portrait — characters stand upright    |
| Floor line     | The actor's feet should sit near `y ≈ 132`. The view's shadow ellipse is rendered just below at the bottom of the sprite container. |
| Headroom       | Hats/helmets/horns may use `y` down to ~2; do not clip at the top edge. Weapon tips and plumes can extend to the right edge (`x ≈ 95`). |
| Width margin   | Keep body silhouette within `x ∈ [18, 82]`. The outer 18px on each side is reserved for raised arms, props, and the foe-mirror flip not pushing the head off-canvas. |

### Foe mirroring (do not pre-flip)

The CSS rule `#combat-view .cv-foe .cv-sprite-svg svg { transform: scaleX(-1); }` automatically horizontal-mirrors **every** foe sprite at render time. **Author monsters facing the viewer (or facing right); the mirror handles "facing the player on the left" for free.** Do not pre-flip the artwork — you will end up with the back of the monster.

The player sprite is rendered without the mirror (see `cv-me`), so the player faces forward as drawn.

### Layering order

Inside the SVG, paint back-to-front:

1. Background props that hang behind the body — capes, banners, large staves planted behind.
2. Lower body — legs, loincloth, robe skirt.
3. Belt / sash / pelvis plate.
4. Torso — rib cage, body fill, body shading.
5. Shoulder armor / pauldrons.
6. Far arm (the one furthest from the viewer in 3/4 pose). For full-frontal poses, both arms.
7. Neck.
8. Head / skull.
9. Facial details (eye sockets, eyes, nose, teeth, mouth).
10. Headgear — helmet rim, hat brim, horns, plumes.
11. Near arm + held weapon (drawn last so the weapon visually overlaps the body).

The two existing canonical sprites — `goblinSpriteSvg` and `skeletonSpriteSvg` — follow this order. Read them as templates before writing new ones.

### Visual style

The sprite is shown at 86×120 with a drop shadow and a subtle bobbing animation. It is **not** pixel art and **not** a render — it is a flat-shaded vector silhouette that has to read at thumbnail size.

- **Limit the palette.** Aim for 3–5 fill colors per monster plus a near-black outline (`#1a0a0a` to `#2a2520` range). Goblin: skin green, loincloth brown, dagger silver, eye accents. Skeleton: bone, armor grey, cape dark red, sword silver, eye glow.
- **Outline strokes** at `stroke-width: 0.6–0.8` on body parts give the silhouette enough contrast against the dark combat backdrop. Use sparingly on inner details — too many lines turn into mud at 86px.
- **One highlight, one shadow.** A single shading path (`fill="<darker tone>" opacity="0.5"`) over the torso gives volume without requiring real gradients.
- **Eyes are the focal point.** Use a tiny bright inner color (`#e84020` for goblin, the `skEye` radial gradient for skeleton) over a dark socket. This is what reads as "alive and menacing" at small size.
- **Carry a prop.** A dagger, sword, club, or bow that breaks the body silhouette makes the monster recognizable instantly. Author it in the **right hand** (i.e. raised on the monster's right side as drawn) so that after the foe-mirror flip, the prop appears between the monster and the player on the left of the screen — exactly where a threat should feel.
- **Avoid `<text>` elements.** Font rendering varies; build everything from paths, lines, polygons, ellipses, and circles.
- **Avoid full SMIL animation.** A small `<animate>` on an eye glow is fine (skeleton uses one); whole-body animation conflicts with the wrapper's bob/shake transforms.

### State handling (already provided — do not duplicate)

| State    | Where it's handled                                                                | What you need to draw |
|----------|-----------------------------------------------------------------------------------|-----------------------|
| Idle bob | `.cv-sprite { animation: cv-bob ... }` translates the whole sprite vertically.    | Nothing extra.        |
| Hurt     | `.cv-actor.cv-hurt .cv-sprite { animation: cv-shake ... }` applies a shake/rotate.| Nothing extra.        |
| Fallen   | `.cv-actor.cv-fallen .cv-sprite { filter: grayscale(1) brightness(0.5); transform: rotate(±12deg); }`. The client also short-circuits SVG rendering for fallen actors and renders a `✝` glyph instead. | Nothing extra. Do not author a "knocked down" variant. |
| Mirror   | CSS-applied for foes (see above).                                                 | Author forward-facing.|

### Defs and IDs

Inline `<defs>` with gradients/filters is fine, but **prefix every `id` with the monster's `defId`** to avoid collisions (multiple sprites can be in the DOM simultaneously across a session, and the player sprite shares the document). Examples in the existing sprites: `pcRobe`, `pcHat` (player), `skEye` (skeleton). Bad: `id="grad1"`. Good: `id="goblinSkin"`.

### Reference sprites

When in doubt, copy the structure of:

- `goblinSpriteSvg` — green humanoid, loincloth, dagger, pointed ears, fanged grin. Demonstrates basic body construction, weapon prop, and face read.
- `skeletonSpriteSvg` — armored skeleton, sword raised, tattered cape, glowing eyes via radial gradient. Demonstrates back layer (cape), pauldrons, and the eye-glow technique.

## Icon (fallback glyph)

The `icon` field is rendered only when `MONSTER_SPRITES[defId]` is missing. Pick a single emoji or typographic symbol that approximates the monster's silhouette (e.g. `🧌`, `☠`, `✦`). It is shown at 56px in the same combat slot the sprite would occupy. Treat it as the "art is in progress" placeholder — every monster shipped to players should graduate to a sprite.
