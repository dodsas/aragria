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
