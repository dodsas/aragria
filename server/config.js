// Game configuration knobs. Tweak values here without touching game logic.

// Monster respawn delays per tier, in milliseconds: [minMs, maxMs] inclusive.
// A killed monster of `tier` respawns in its original room after a random
// delay drawn uniformly from this range.
export const MONSTER_RESPAWN_MS = {
  1: [10_000, 30_000],
};

// Default tier used when a monster definition omits `tier`.
export const DEFAULT_MONSTER_TIER = 1;

// Minimum interval (ms) between consecutive `attack` commands for a single
// player. The server is authoritative — clients may render a cooldown UI for
// usability, but any attack arriving before this many ms have elapsed since
// the player's previous attack is rejected. Tampered clients gain nothing.
export const ATTACK_COOLDOWN_MS = 1000;

// Minimum interval (ms) between consecutive map transitions for a single
// player. Same authority model as ATTACK_COOLDOWN_MS — enforced server-side
// in Game.move; rejected moves only produce a system message and do not
// change the player's room. WASD key-repeat at 20–30 Hz is naturally absorbed
// by this gate without separate throttling.
export const MOVE_COOLDOWN_MS = 500;

// Duration (ms) that a kill-stealer is blocked from leaving the room. Triggered
// when player A lands the killing blow on a monster that another player B was
// engaged with (B's combatTargetId pointed at the same monster). For the
// duration, A's `move` is rejected with a notice naming B as the obstructor.
// Anti-grief: prevents a kill-stealer from immediately fleeing the room.
export const KILLSTEAL_MOVE_BLOCK_MS = 5000;
