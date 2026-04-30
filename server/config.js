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

// --- Hardening / abuse defenses ---

// Maximum WebSocket frame size accepted from a client. The wire protocol's
// largest legitimate message is a `say` with SAY_MAX_LEN chars plus a few
// bytes of JSON envelope — 4 KiB is comfortable headroom and rejects flood
// attempts at the WS layer before they reach the JSON parser.
export const WS_MAX_PAYLOAD = 4096;

// Hard cap on the `input` string carried inside a `cmd` message. Cuts off
// pathological commands like a megabyte-long `look` arg before tokenization.
export const INPUT_MAX_LEN = 500;

// Maximum text length of a single `say` message (excluding the `say ` prefix).
// Longer `say` content is truncated, not rejected.
export const SAY_MAX_LEN = 200;

// Per-player `say` cooldown (ms). Independent of the global command bucket so
// chat feels snappy under normal use but can't be flooded.
export const SAY_COOLDOWN_MS = 600;

// Per-player command-rate token bucket. RATE = sustained commands/sec, BURST
// = max consecutive commands without waiting. Hit at handleCommand entry —
// covers `look`/`use`/`help`/etc. that have no per-command cooldown.
export const CMD_RATE_PER_SEC = 8;
export const CMD_BURST = 16;

// Per-IP WebSocket connection rate. New `connection` events from an IP that
// already opened CONN_RATE_LIMIT sockets within CONN_RATE_WINDOW_MS are
// rejected with close code 4003 before a player is allocated.
export const CONN_RATE_WINDOW_MS = 10_000;
export const CONN_RATE_LIMIT = 6;

// Reconnect grace (ms). When a socket closes, the player object is NOT
// immediately removed — it stays in-world until the grace expires, so a
// reconnect with the same session id (sid) can reattach without losing
// in-flight penalties (kill-steal block, reduced HP, etc.). Long enough to
// outlive KILLSTEAL_MOVE_BLOCK_MS so the obvious bypass — disconnect to dodge
// the block — fails: the block is still active when the same sid returns.
export const RECONNECT_GRACE_MS = 30_000;

// --- Character creation ---

// Length bounds for the adventurer name (in characters, after trim).
export const NAME_MIN_LEN = 1;
export const NAME_MAX_LEN = 16;

// Length bounds for the character description provided at registration. The
// description feeds the sprite generator, so it needs enough detail to be
// distinctive but is capped to keep the prompt cheap and predictable.
export const DESC_MIN_LEN = 5;
export const DESC_MAX_LEN = 200;
