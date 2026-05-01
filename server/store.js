// 영속 스토어 — Turso/libsql embedded replica.
//
// 모드:
//   - TURSO_DATABASE_URL 가 있으면 embedded replica: 로컬 SQLite 가 primary
//     와 sync, 읽기는 로컬(< 1ms), 쓰기는 primary 로 forward.
//   - env 가 없으면 standalone 로컬 SQLite (`data/local.db`). 개발용.
//
// API 는 이전 JSON 파일 기반과 동일 — 호출자(auth.js, game.js)는 변경 없음.
// 메모리 hot 캐시(`state.byNaverId`)는 그대로 유지: WS attach·인증 검증 같은
// hot path 가 SQL 라운드트립 없이 객체 룩업으로 끝나도록. 디바운스(1.5s) 로
// 묶인 백그라운드 flush 가 dirty 사용자만 batch UPSERT 한다.
//
// 스키마:
//   users(naver_id PK, provider, nickname, session_token,
//         session_rotated_at, character_json, created_at, updated_at)
//
// 마이그레이션: 부팅 시 SQLite 가 비어 있고 옛 `users.json` 이 존재하면
// 그 내용을 한 번 SQLite 로 import (positive once-off). 로컬 dev 의 기존
// JSON 데이터를 잃지 않도록.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 경로는 런타임에 결정 — AGRIA_DATA_DIR env 가 있으면 그 경로(테스트 격리용),
// 없으면 기본 data/.
function dataDir() {
  return process.env.AGRIA_DATA_DIR || path.join(__dirname, '..', 'data');
}
function localDbPath() {
  return path.join(dataDir(), 'local.db');
}

const FLUSH_DEBOUNCE_MS = 1500;

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS users (
  naver_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  session_token TEXT,
  session_rotated_at INTEGER NOT NULL,
  character_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const SESSION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_users_session_token ON users(session_token)`;

let state = { byNaverId: {} };
let dirtyUserIds = new Set();
let flushTimer = null;
let flushPromise = null;
let initialized = false;
let client = null;

async function ensureDir() {
  try { await fs.mkdir(dataDir(), { recursive: true }); } catch {}
}

export async function initStore() {
  if (initialized) return;
  await ensureDir();

  const config = { url: 'file:' + localDbPath() };
  if (process.env.TURSO_DATABASE_URL) {
    config.syncUrl = process.env.TURSO_DATABASE_URL;
    if (process.env.TURSO_AUTH_TOKEN) config.authToken = process.env.TURSO_AUTH_TOKEN;
  }
  client = createClient(config);

  // 첫 sync — 원격 primary 의 최신 상태를 로컬 replica 로 가져온다. Render
  // free 처럼 ephemeral fs 환경에선 매 부팅마다 local.db 가 새로 만들어지지만
  // 이 sync 한 번으로 그동안의 모든 데이터가 즉시 복구된다. syncUrl 이 없는
  // standalone 모드는 sync 자체가 의미 없어 skip.
  if (config.syncUrl) {
    try { await client.sync(); }
    catch (err) { console.warn('[store] initial sync failed:', err.message); }
  }

  await client.execute(SCHEMA_SQL);
  await client.execute(SESSION_INDEX_SQL);

  // 1회 마이그레이션: 옛 JSON 파일 기반 데이터가 있고 SQLite 가 비어 있을
  // 때만. 개발 환경에서 이전 캐릭터들이 그대로 살아남도록.
  const before = await client.execute('SELECT COUNT(*) AS n FROM users');
  if (Number(before.rows[0].n) === 0) {
    await migrateLegacyJsonIfPresent();
  }

  await reloadStateFromDb();
  initialized = true;
}

async function migrateLegacyJsonIfPresent() {
  const legacyPath = path.join(dataDir(), 'users.json');
  let raw;
  try { raw = await fs.readFile(legacyPath, 'utf8'); }
  catch { return; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    console.warn('[store] legacy users.json present but unparseable, skipping migration');
    return;
  }
  if (!parsed?.byNaverId) return;
  const stmts = [];
  for (const u of Object.values(parsed.byNaverId)) {
    if (!u || !u.providerUserId) continue;
    stmts.push(buildUpsertStatement(u));
  }
  if (stmts.length === 0) return;
  await client.batch(stmts);
  console.log(`[store] migrated ${stmts.length} user(s) from legacy users.json`);
}

async function reloadStateFromDb() {
  state = { byNaverId: {} };
  const rs = await client.execute(
    'SELECT naver_id, provider, nickname, session_token, session_rotated_at, character_json, created_at, updated_at FROM users'
  );
  for (const row of rs.rows) {
    state.byNaverId[row.naver_id] = {
      provider: row.provider,
      providerUserId: row.naver_id,
      nickname: row.nickname || '',
      sessionToken: row.session_token,
      sessionRotatedAt: Number(row.session_rotated_at),
      character: row.character_json ? JSON.parse(row.character_json) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

function buildUpsertStatement(u) {
  return {
    sql: `INSERT INTO users (naver_id, provider, nickname, session_token, session_rotated_at, character_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(naver_id) DO UPDATE SET
            provider = excluded.provider,
            nickname = excluded.nickname,
            session_token = excluded.session_token,
            session_rotated_at = excluded.session_rotated_at,
            character_json = excluded.character_json,
            updated_at = excluded.updated_at`,
    args: [
      String(u.providerUserId),
      u.provider || 'naver',
      u.nickname || '',
      u.sessionToken || null,
      Number(u.sessionRotatedAt) || Date.now(),
      u.character ? JSON.stringify(u.character) : null,
      Number(u.createdAt) || Date.now(),
      Number(u.updatedAt) || Date.now(),
    ],
  };
}

// 즉시 디스크/원격 flush. 종료 직전·로그인/세션 회전처럼 「유실되면 안 되는」
// 변경이 있을 때 호출. 일반 게임 진행은 markDirty 로 디바운스에 묶인다.
export async function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (flushPromise) { await flushPromise; }
  if (!client || dirtyUserIds.size === 0) return;

  const ids = [...dirtyUserIds];
  dirtyUserIds = new Set();

  flushPromise = (async () => {
    try {
      const stmts = ids.map(id => {
        const u = state.byNaverId[id];
        return u
          ? buildUpsertStatement(u)
          : { sql: 'DELETE FROM users WHERE naver_id = ?', args: [id] };
      });
      await client.batch(stmts);
    } catch (err) {
      console.error('[store] flush failed:', err.message);
      // 실패 시 dirty 복원 — 다음 timer 가 재시도.
      for (const id of ids) dirtyUserIds.add(id);
    }
  })();
  await flushPromise;
  flushPromise = null;
}

function markDirty(naverId) {
  if (!naverId) return;
  dirtyUserIds.add(String(naverId));
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirtyUserIds.size) flushNow().catch(() => {});
  }, FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

export function getUserByNaverId(naverId) {
  if (!naverId) return null;
  return state.byNaverId[String(naverId)] || null;
}

// 메모리 hot 캐시를 선형 스캔. 사용자 수가 1k 정도까지는 마이크로초 단위로 끝나
// SQL 인덱스 룩업(밀리초)보다 빠르다 — WS connect 마다 호출되므로 hot path.
export function getUserBySessionToken(token) {
  if (!token) return null;
  for (const u of Object.values(state.byNaverId)) {
    if (u.sessionToken && u.sessionToken === token) return u;
  }
  return null;
}

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
  markDirty(id);
  return rec;
}

export function clearSessionToken(naverId) {
  const id = String(naverId);
  const u = state.byNaverId[id];
  if (!u) return;
  u.sessionToken = null;
  u.updatedAt = Date.now();
  markDirty(id);
}

// 캐릭터 스냅샷을 통째로 저장. partial merge 가 아니라 전체 교체 —
// 호출자가 player 객체에서 필요한 필드만 추려 넘기게 해 형상 통제 단일화.
export function saveCharacterFor(naverId, snapshot) {
  const id = String(naverId);
  const u = state.byNaverId[id];
  if (!u) return;
  u.character = snapshot ? { ...snapshot } : null;
  u.updatedAt = Date.now();
  markDirty(id);
}

export function getCharacterFor(naverId) {
  const u = getUserByNaverId(naverId);
  return u?.character || null;
}

// 테스트 전용 — libsql 클라이언트를 닫고 모든 in-memory 상태를 비운다.
// optional 로 새 데이터 디렉터리를 가리키도록. 운영 코드에서는 호출 금지.
export async function _resetForTesting(newDataDir) {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
  }
  state = { byNaverId: {} };
  dirtyUserIds = new Set();
  initialized = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushPromise = null;
  if (newDataDir) process.env.AGRIA_DATA_DIR = newDataDir;
}

// 종료 시 잔여 dirty flush + 클라이언트 close. SIGINT/SIGTERM 둘 다 받아 한 번씩.
export function bindShutdownFlush() {
  let bound = false;
  const handler = async () => {
    if (bound) return;
    bound = true;
    try { await flushNow(); } catch {}
    try { if (client) await client.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
