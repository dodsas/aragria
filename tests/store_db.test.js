// store.js — DB 레이어 테스트.
// store.test.js 가 user-facing API (login/character) 를 검증한다면 이 파일은
// 그 아래의 SQLite 스키마·UPSERT·batch flush·debounce·마이그레이션 분기를
// 직접 readback 해 본다. 임의의 동일 사용자 N 회 mark 가 1 row 로 압축되는지,
// 캐릭터 JSON blob 이 유니코드/중첩까지 무손실로 round-trip 하는지처럼
// 「API 통과」 만으로는 잡히지 않는 회귀를 가둔다.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  initStore,
  flushNow,
  loginNaverUser,
  getUserByNaverId,
  getUserBySessionToken,
  saveCharacterFor,
  clearSessionToken,
  _resetForTesting,
} from '../server/store.js';

let tmpDir;

// 우리 모듈 캐시를 우회해 같은 local.db 를 별도 클라이언트로 직접 읽는다.
async function dbReadback(callback) {
  const c = createClient({ url: 'file:' + path.join(tmpDir, 'local.db') });
  try { return await callback(c); }
  finally { await c.close(); }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agria-store-db-'));
  await _resetForTesting(tmpDir);
  await initStore();
});

afterEach(async () => {
  await _resetForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('스키마: users 테이블과 session_token 인덱스가 init 직후 존재', async () => {
  await dbReadback(async (c) => {
    const tbl = await c.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    );
    assert.equal(tbl.rows.length, 1);
    const idx = await c.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_session_token'"
    );
    assert.equal(idx.rows.length, 1);
  });
});

test('스키마: users 컬럼이 모두 존재 (PRAGMA table_info)', async () => {
  // 컬럼 하나가 빠진 채 배포되면 INSERT 가 런타임에 실패해 사용자 데이터가
  // 유실된다 — 차라리 부팅 직후 잡히도록 형상 자체를 가드한다.
  await dbReadback(async (c) => {
    const rs = await c.execute('PRAGMA table_info(users)');
    const cols = rs.rows.map((r) => r.name).sort();
    assert.deepEqual(cols, [
      'character_json', 'created_at', 'naver_id', 'nickname', 'provider',
      'session_rotated_at', 'session_token', 'updated_at',
    ]);
  });
});

test('UPSERT: 동일 사용자 재로그인은 row 를 덮어쓸 뿐 추가하지 않음', async () => {
  // 같은 id 로 N 번 mark 해도 dirty Set 이 dedup → batch 가 1 statement → row 1.
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  loginNaverUser({ providerUserId: 'n1', nickname: 'B' });
  const last = loginNaverUser({ providerUserId: 'n1', nickname: 'C' });
  await flushNow();

  await dbReadback(async (c) => {
    const cnt = await c.execute('SELECT COUNT(*) AS n FROM users');
    assert.equal(Number(cnt.rows[0].n), 1);
    const r = await c.execute(
      'SELECT nickname, session_token FROM users WHERE naver_id = ?',
      ['n1'],
    );
    assert.equal(r.rows[0].nickname, 'C');
    assert.equal(r.rows[0].session_token, last.sessionToken);
  });
});

test('flushNow: dirty 가 비어 있으면 disk no-op', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  await flushNow();
  // 같은 row 의 updated_at 이 두 번째 flushNow 로는 변하지 않아야 한다 —
  // dirty 가 비었으니 batch 자체가 호출되지 않는다.
  const before = await dbReadback(async (c) => {
    const r = await c.execute('SELECT updated_at FROM users WHERE naver_id=?', ['n1']);
    return Number(r.rows[0].updated_at);
  });
  await flushNow();
  await flushNow();
  const after = await dbReadback(async (c) => {
    const r = await c.execute('SELECT updated_at FROM users WHERE naver_id=?', ['n1']);
    return Number(r.rows[0].updated_at);
  });
  assert.equal(after, before);
});

test('flushNow: 한 번 호출로 여러 dirty 사용자를 batch 로 영속', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  loginNaverUser({ providerUserId: 'n2', nickname: 'B' });
  loginNaverUser({ providerUserId: 'n3', nickname: 'C' });
  saveCharacterFor('n1', { level: 1 });
  saveCharacterFor('n2', { level: 2 });
  saveCharacterFor('n3', { level: 3 });
  await flushNow();

  await dbReadback(async (c) => {
    const rs = await c.execute(
      'SELECT naver_id, nickname, character_json FROM users ORDER BY naver_id'
    );
    assert.equal(rs.rows.length, 3);
    assert.deepEqual(rs.rows.map((r) => r.naver_id), ['n1', 'n2', 'n3']);
    assert.deepEqual(rs.rows.map((r) => r.nickname), ['A', 'B', 'C']);
    assert.deepEqual(
      rs.rows.map((r) => JSON.parse(r.character_json).level),
      [1, 2, 3],
    );
  });
});

test('saveCharacterFor(null): character_json 컬럼이 NULL 로 영속', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', { name: 'A', level: 5 });
  await flushNow();
  saveCharacterFor('n1', null);
  await flushNow();

  await dbReadback(async (c) => {
    const rs = await c.execute(
      'SELECT character_json FROM users WHERE naver_id = ?', ['n1'],
    );
    assert.equal(rs.rows[0].character_json, null);
  });
});

test('character_json: 한글·이모지·중첩·특수문자가 round-trip 무손실', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: '주인공' });
  const snapshot = {
    name: '카이런 ⚡',
    desc: 'line1\nline2\t"quoted" \\backslash',
    klass: 'mage',
    inventory: [
      { id: 'potion_hp', qty: 3, meta: { rare: true, tags: ['희귀', 'consumable'] } },
      { id: 'sword', qty: 1, meta: null },
    ],
    spells: ['fireball', '얼음창', 'magic missile'],
    nested: { a: { b: { c: 42, d: [1, 2, 3] } } },
  };
  saveCharacterFor('n1', snapshot);
  await flushNow();

  // disk → reloadStateFromDb → 메모리 재구성. 같은 디렉터리로 reset+init.
  await _resetForTesting(tmpDir);
  await initStore();
  const u = getUserByNaverId('n1');
  assert.deepEqual(u.character, snapshot);
});

test('clearSessionToken: 디스크 row 의 session_token 컬럼이 NULL 로 영속', async () => {
  // 메모리에서 토큰이 사라지는 것은 store.test.js 가 검증. 여기선 「flush 이후
  // 정말 디스크까지 닿는가」 — 다른 디바이스에서 로그인했을 때 옛 토큰이
  // 백엔드 재기동 후에도 살아남으면 안 된다.
  const u = loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', { level: 7 });
  await flushNow();
  clearSessionToken('n1');
  await flushNow();

  await dbReadback(async (c) => {
    const rs = await c.execute(
      'SELECT session_token, character_json FROM users WHERE naver_id = ?',
      ['n1'],
    );
    assert.equal(rs.rows[0].session_token, null);
    // 캐릭터는 보존돼야 — 「로그아웃 ≠ 캐릭터 삭제」.
    assert.equal(JSON.parse(rs.rows[0].character_json).level, 7);
  });

  // 메모리 cache 도 disk 도 같은 토큰을 모르게 됐는지.
  assert.equal(getUserBySessionToken(u.sessionToken), null);
});

test('clearSessionToken: 미등록 사용자 호출은 no-op (throw 없음)', () => {
  // 비인증 요청에서 logout 이 와도 게임이 끊기면 안 됨.
  clearSessionToken('does_not_exist');
  assert.equal(getUserByNaverId('does_not_exist'), null);
});

test('initStore: 두 번 호출해도 idempotent (스키마 재실행·데이터 손실 없음)', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', { level: 9 });
  await flushNow();
  // 같은 모듈 인스턴스에서 재호출 — `initialized` 가드로 no-op.
  await initStore();
  await initStore();
  const u = getUserByNaverId('n1');
  assert.equal(u.nickname, 'A');
  assert.equal(u.character.level, 9);
});

test('마이그레이션: SQLite 가 비어있지 않으면 옛 users.json 은 무시', async () => {
  // (1) 일반 init 으로 SQLite 에 사용자 한 명 영속.
  loginNaverUser({ providerUserId: 'existing', nickname: '먼저' });
  await flushNow();
  await _resetForTesting();

  // (2) 같은 디렉터리에 users.json 을 떨어뜨려도 — DB 에 row 가 있으니
  //     migrateLegacyJsonIfPresent 분기는 진입조차 하지 않아야 한다.
  await fs.writeFile(path.join(tmpDir, 'users.json'), JSON.stringify({
    byNaverId: {
      legacy: {
        provider: 'naver', providerUserId: 'legacy', nickname: '레거시',
        sessionToken: 'tok', sessionRotatedAt: 1, character: null,
        createdAt: 1, updatedAt: 1,
      },
    },
  }), 'utf8');

  await _resetForTesting(tmpDir);
  await initStore();

  assert.ok(getUserByNaverId('existing'), '기존 사용자는 보존');
  assert.equal(getUserByNaverId('legacy'), null, 'JSON 사용자는 마이그되지 않음');

  // 디스크 readback 으로 한 번 더 — row 가 1개여야 함.
  await dbReadback(async (c) => {
    const rs = await c.execute('SELECT COUNT(*) AS n FROM users');
    assert.equal(Number(rs.rows[0].n), 1);
  });
});

test('마이그레이션: users.json 이 손상돼 있어도 init 은 성공 (skip + warn)', async () => {
  // 부팅이 깨지면 운영이 통째로 다운된다. 마이그레이션은 best-effort.
  await _resetForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agria-store-db-'));
  await fs.writeFile(path.join(tmpDir, 'users.json'), '{ this is not json', 'utf8');

  await _resetForTesting(tmpDir);
  // 손상 경고 노이즈 억제.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await initStore();
  } finally {
    console.warn = origWarn;
  }

  // SQLite 는 비었지만 schema 는 정상이어야 — 새 로그인이 성공해야 함.
  const u = loginNaverUser({ providerUserId: 'fresh', nickname: '새사람' });
  await flushNow();
  await dbReadback(async (c) => {
    const rs = await c.execute('SELECT nickname FROM users');
    assert.equal(rs.rows.length, 1);
    assert.equal(rs.rows[0].nickname, '새사람');
  });
  assert.match(u.sessionToken, /^[a-f0-9]{64}$/);
});
