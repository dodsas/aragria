// Game configuration knobs. Tweak values here without touching game logic.

// Monster respawn delays per tier, in milliseconds: [minMs, maxMs] inclusive.
// A killed monster of `tier` respawns in its original room after a random
// delay drawn uniformly from this range.
export const MONSTER_RESPAWN_MS = {
  1: [10_000, 30_000],
  // tier 2: 보스급 — 2~5분. 짧으면 같은 자리에 재출현이 너무 잦아 위협감이 사라진다.
  2: [120_000, 300_000],
};

// Default tier used when a monster definition omits `tier`.
export const DEFAULT_MONSTER_TIER = 1;

// 몬스터 자가 회복 틱 주기(ms). 너무 짧으면 같은 룸 N명 × 룸 수만큼 1초 안에
// 다중 broadcast가 누적되고, 너무 길면 회복이 끊겨 보인다. 1초가 자연스럽고
// 1k 동시 접속 목표에도 안전.
export const MONSTER_REGEN_TICK_MS = 1000;

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

// 등록 절차 활성/비활성 토글. true면 신규 접속자에게 welcome 모달을 띄워
// 이름·특징을 받고, false면 모달 없이 `방랑자-{id}` + 디폴트 묘사로 즉시
// 자동 등록한다. 비활성화는 데모/시연·자동화 테스트·프로필 수집을 일시적으로
// 끄고 싶을 때 사용. 클라이언트는 이 플래그를 모르며, welcome 메시지의 유무가
// 그대로 신호 역할을 한다.
export const REGISTRATION_ENABLED = false;

// 자동 등록 시 사용할 디폴트 묘사. DESC_MIN_LEN 이상이어야 하고, 분류기가
// "wanderer" archetype + "leather" 팔레트로 안정적으로 매핑할 수 있는 한국어
// 키워드(떠돌이)를 포함한다.
export const AUTO_REGISTER_DESC = '낯선 곳에 막 도착한 떠돌이.';

// Length bounds for the adventurer name (in characters, after trim).
export const NAME_MIN_LEN = 1;
export const NAME_MAX_LEN = 16;

// Length bounds for the character description provided at registration. The
// description feeds the sprite generator, so it needs enough detail to be
// distinctive but is capped to keep the prompt cheap and predictable.
export const DESC_MIN_LEN = 5;
export const DESC_MAX_LEN = 200;
