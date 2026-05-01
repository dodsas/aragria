# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Agria

Agria is a browser-based **text-MUD style multiplayer web game**.

### Product spec (authoritative)

- **Concurrency target:** ~1,000 simultaneous players on a single instance. All design decisions (data structures, broadcast patterns, message size) must hold up at this scale. Avoid per-tick O(n²) work over the player set.
- **Presentation is text-first.** The main viewport is a scrolling textual log (think classic MUD / Zork). Most world interaction is described in prose, not rendered.
- **Sidebar status panel** (fixed position, **left** side of viewport) shows the player's:
  - Equipment slots (head, body, weapon, etc.)
  - Inventory item list
  This panel is always visible and updates reactively as the server pushes status changes. See `ui_main.md` for the layout contract and the rules to follow when changing it.
- **Selective UI rendering for "looked-at" objects.** When the player examines a specific object (e.g. `look crystal`), if the server marks that object as having a `view` payload, the client renders a structured UI representation of it (image/icon, stats, structured fields) instead of — or alongside — the prose description. Most objects have only prose; only flagged objects get UI treatment.
- **Simple iconography** accompanies sidebar entries and the object-view panel. Text remains primary.

### Architecture

```
Browser (vanilla HTML/CSS/JS)
   │   WebSocket  (JSON messages)
   ▼
Node.js process
   ├── Express        — serves /public static assets
   └── ws.Server      — game protocol, attached to same HTTP server
        └── Game      — in-memory world state, players, rooms, objects
```

- **Single Node process** holds authoritative game state in memory. No DB in the skeleton; persistence is a later concern.
- **Message protocol** is JSON over WebSocket. Every message has a `type` field. Server→client types so far: `text`, `status`, `view`, `system`. Client→server: `cmd` (with `input` string). Keep this protocol the contract — don't bypass it with ad-hoc messages.
- **Rendering split on the client:**
  - `text` → append line to log pane.
  - `status` → re-render sidebar.
  - `view` → render structured panel for the looked-at object. Sending `view: null` clears it.
- **Object UI gating:** an object is "UI-renderable" iff it defines a `view` field in its definition. The `look` command checks this and emits `view` accordingly. New content authors opt in by adding `view` data, not by touching client code.

### Input modes (client)

The client has two input modes, toggled with **ESC**:

- `typing` — default. The prompt is focused; Enter submits commands.
- `move` — the prompt is disabled; **WASD** sends `go north/west/south/east` (W=N, A=W, S=S, D=E).

The server is unaware of modes — WASD is a thin client wrapper that emits the same `cmd` messages as text input. See `movement.md` for the full contract, rate-limit considerations at 1k concurrent, and rationale.

### 소스 & 문서 인덱스

**소스 레이아웃**

- `server/index.js` — HTTP + WebSocket bootstrap, connection lifecycle.
- `server/game.js` — world, players, rooms, objects, command dispatch. The single source of truth for game logic.
- `server/config.js` — tunable knobs (monster respawn timings, etc.). Edit values here, not in `game.js`.
- `server/zones/` — map content split per zone (`town.js`, `forest.js`, ...) plus `index.js` loader. Add new zones here, not in `game.js`. See `zone.md`.
- `public/index.html`, `public/style.css`, `public/client.js` — the entire client. No build step.

**문서 카테고리.** 11 개 md 파일은 모두 프로젝트 루트에 평평하게 둔다(코드 주석에서 `magic.md` 같이 bare 파일명으로 참조하기 쉽게). 카테고리는 「어디서 같이 보면 되는지」 의 인덱스로만 의미가 있다 — 새 문서를 추가할 때 아래에 한 줄 끼워 넣고 짧은 한 줄 요약만 붙인다.

*게임 시스템 — 진행·전투의 단일 진실원*

- `class.md` — 직업 시스템(novice/mage), 전직 규칙(광장 + 레벨 10), 레벨/EXP 테이블, 새 직업 추가 절차.
- `magic.md` — 마법 정의·시전 게이트·element 색 매트릭스·다단어 한국어 spell 입력 파서(`_matchSpellPrefix`), 새 마법 추가 절차.
- `equipment.md` — 아이템 단일 진실원 ITEM_DEFS·드랍 매트릭스·attack/defense 데미지 공식·equip/unequip 명령·새 아이템 추가 절차.
- `monster.md` — monster definition schema, tier system, and respawn rules.

*입력·프로토콜 — 클라→서버 입력 정책*

- `command.md` — server-authoritative input rate limits (attack cooldown, etc.).
- `movement.md` — movement input modes (text vs WASD) and key mapping.

*클라이언트 — 화면 구성과 모바일 컨트롤*

- `ui_main.md` — sidebar layout contract (position, structure, status protocol).
- `touch_controls.md` — 모바일 하단 d-pad + 계층형 액션 패드(공격/봐/마법 → 타깃 선택), `room_monsters` 페이로드 확장.

*월드 콘텐츠 — 맵·존*

- `zone.md` — zone module schema (rooms/objects/spawns), loader contract, how to add new zones.

*인프라 — 게임 외 서버 부품*

- `auth.md` — 네이버 OAuth 로그인·세션 토큰 회전(다른 디바이스 로그인 시 단일성 보장)·Turso(libsql) embedded replica 영속성(`data/local.db` + 원격 primary)·env(NAVER_CLIENT_ID/SECRET, NAVER_CALLBACK_URL, SESSION_COOKIE_SECURE, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN).
- `llm.md` — LLM dispatcher / provider matrix, env vars, how to add a new per-situation generator.

### Commands

- `npm start` — run the server (port 3000 by default, override via `PORT`).
- `npm run dev` — run with `node --watch` for auto-reload on server file changes.
- `npm test` — `node --test 'tests/*.test.js'`. 인증·스토어·HTTP/WS 통합 테스트가 들어 있다(`tests/store.test.js`, `tests/auth.test.js`, `tests/integration.test.js`). 통합 테스트는 실제 `server/index.js` 를 임의 포트에 띄우고 `AGRIA_DATA_DIR` 로 격리된 tmp 디렉터리를 가리키게 한다 — 새 기능을 추가할 때 같은 패턴(서브프로세스 + tmp dir + WS 클라이언트)을 따른다.

### Conventions

- ES modules everywhere (`"type": "module"` in `package.json`).
- Server code is plain JS (no TS, no transpile). Keep it that way unless the user asks otherwise.
- Frontend is plain JS — no framework, no bundler. If the UI needs grow past what vanilla can carry, raise it before reaching for React/Vue.
- Broadcasting: prefer pushing only to affected players (same room, same party) rather than blasting all sockets, given the 1k-concurrent target.
