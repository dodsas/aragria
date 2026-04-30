// Game configuration knobs. Tweak values here without touching game logic.

// Monster respawn delays per tier, in milliseconds: [minMs, maxMs] inclusive.
// A killed monster of `tier` respawns in its original room after a random
// delay drawn uniformly from this range.
export const MONSTER_RESPAWN_MS = {
  1: [10_000, 30_000],
};

// Default tier used when a monster definition omits `tier`.
export const DEFAULT_MONSTER_TIER = 1;
