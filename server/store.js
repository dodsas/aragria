// 파일 기반 영속 스토어. 단일 JSON 파일(`data/users.json`)에 모든 계정과
// 그 계정에 묶인 캐릭터 스냅샷을 같이 둔다. 1k 동시 접속 목표 안에서는
// 메모리에 통째로 들고 있어도 안전하고, 저장은 dirty 플래그 + debounce 로
// 묶어 디스크 I/O 가 한 번에 한 명꼴로 폭발하지 않도록 한다.
//
// 스키마:
//   users.json = { byNaverId: { [naverId]: UserRec } }
//   UserRec = {
//     provider: 'naver',
//     providerUserId: string,
//     nickname: string,
//     // 단일 활성 세션 토큰. 다른 디바이스에서 로그인하면 새 토큰으로 회전,
//     // 기존 토큰은 즉시 무효 — 이전 디바이스의 WS 는 다음 valid 검사에서 거절됨.
//     sessionToken: string|null,
//     sessionRotatedAt: number,
//     // 한 계정당 캐릭터 1 — 신규 직업/멀티 캐릭터가 들어오면 array 로 확장.
//     character: CharacterSnap|null,
//     createdAt: number,
//     updatedAt: number,
//   }
//   CharacterSnap = {
//     name, description, klass, level, exp,
//     hp, maxHp, mp, maxMp,
//     equipment, inventory,
//     roomId, spriteSvg,
//   }

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 경로는 런타임에 결정 — AGRIA_DATA_DIR env 가 있으면 그 경로(테스트 격리용),
// 없으면 기본 data/. const 로 한번에 캡처하면 테스트가 환경변수를 바꿔도 반영
// 안 되므로 함수로 둔다.
function dataDir() {
  return process.env.AGRIA_DATA_DIR || path.join(__dirname, '..', 'data');
}
function usersFile() {
  return path.join(dataDir(), 'users.json');
}

const FLUSH_DEBOUNCE_MS = 1500;

let state = { byNaverId: {} };
let dirty = false;
let flushTimer = null;
let flushPromise = null;
let initialized = false;

async function ensureDir() {
  try { await fs.mkdir(dataDir(), { recursive: true }); } catch {}
}

export async function initStore() {
  if (initialized) return;
  await ensureDir();
  try {
    const raw = await fs.readFile(usersFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.byNaverId) {
      state = parsed;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] load failed:', err.message);
  }
  initialized = true;
}

// 즉시 디스크 flush. 종료 직전·로그인/세션 회전처럼 「유실되면 안 되는」
// 변경이 있을 때 호출. 일반 게임 진행(레벨업·이동 등)은 markDirty + 디바운스로 묶음.
export async function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (flushPromise) { await flushPromise; }
  flushPromise = (async () => {
    try {
      await ensureDir();
      const target = usersFile();
      const tmp = target + '.tmp';
      const json = JSON.stringify(state, null, 2);
      await fs.writeFile(tmp, json, 'utf8');
      await fs.rename(tmp, target);
      dirty = false;
    } catch (err) {
      console.error('[store] flush failed:', err.message);
    } finally {
      flushPromise = null;
    }
  })();
  await flushPromise;
}

function markDirty() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty) flushNow().catch(() => {});
  }, FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

export function getUserByNaverId(naverId) {
  if (!naverId) return null;
  return state.byNaverId[String(naverId)] || null;
}

export function getUserBySessionToken(token) {
  if (!token) return null;
  for (const u of Object.values(state.byNaverId)) {
    if (u.sessionToken && u.sessionToken === token) return u;
  }
  return null;
}

// 네이버 콜백 시 호출. 새 sessionToken 으로 회전하고 닉네임을 업데이트.
// 이전 token 은 자연스럽게 무효 — 다른 디바이스의 WS 는 다음 검사에서 끊긴다.
export function loginNaverUser({ providerUserId, nickname }) {
  const id = String(providerUserId);
  const now = Date.now();
  const existing = state.byNaverId[id];
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const rec = existing
    ? { ...existing, nickname: nickname || existing.nickname, sessionToken, sessionRotatedAt: now, updatedAt: now }
    : {
        provider: 'naver',
        providerUserId: id,
        nickname: nickname || '',
        sessionToken,
        sessionRotatedAt: now,
        character: null,
        createdAt: now,
        updatedAt: now,
      };
  state.byNaverId[id] = rec;
  markDirty();
  return rec;
}

export function clearSessionToken(naverId) {
  const id = String(naverId);
  const u = state.byNaverId[id];
  if (!u) return;
  u.sessionToken = null;
  u.updatedAt = Date.now();
  markDirty();
}

// 캐릭터 스냅샷을 통째로 저장. partial merge 가 아니라 전체 교체 —
// 호출자가 player 객체에서 필요한 필드만 추려 넘기게 해 형상 통제 단일화.
export function saveCharacterFor(naverId, snapshot) {
  const id = String(naverId);
  const u = state.byNaverId[id];
  if (!u) return;
  u.character = snapshot ? { ...snapshot } : null;
  u.updatedAt = Date.now();
  markDirty();
}

export function getCharacterFor(naverId) {
  const u = getUserByNaverId(naverId);
  return u?.character || null;
}

// 테스트 전용 — 모듈 in-memory 상태와 디스크 핸들 타이머를 깨끗이 비우고
// optional 로 새 데이터 디렉터리를 가리키도록. 운영 코드에서는 호출 금지.
export function _resetForTesting(newDataDir) {
  state = { byNaverId: {} };
  dirty = false;
  initialized = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushPromise = null;
  if (newDataDir) process.env.AGRIA_DATA_DIR = newDataDir;
}

// 종료 시 잔여 dirty flush 보장. SIGINT/SIGTERM 둘 다 받아 한 번씩.
export function bindShutdownFlush() {
  let bound = false;
  const handler = async () => {
    if (bound) return;
    bound = true;
    try { await flushNow(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
