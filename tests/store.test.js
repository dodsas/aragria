// store.js — 영속 스토어 단위 테스트.
// 격리: 각 test 마다 fresh tmp dir 로 _resetForTesting → 디스크 상태가
// 인접 test 에 새지 않도록.

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
  clearSessionToken,
  saveCharacterFor,
  getCharacterFor,
  _resetForTesting,
} from '../server/store.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agria-store-'));
  await _resetForTesting(tmpDir);
  await initStore();
});

afterEach(async () => {
  // 다음 테스트가 새 tmpDir 로 init 하기 전에 현재 libsql 클라이언트를 닫아
  // 파일 핸들 / 백그라운드 sync timer 잔존을 막는다.
  await _resetForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('loginNaverUser: 신규 사용자 첫 로그인은 32-byte hex 토큰 발급 + character=null', () => {
  const u = loginNaverUser({ providerUserId: 'n1', nickname: '테스터' });
  assert.equal(u.provider, 'naver');
  assert.equal(u.providerUserId, 'n1');
  assert.equal(u.nickname, '테스터');
  assert.match(u.sessionToken, /^[a-f0-9]{64}$/);
  assert.equal(u.character, null);
});

test('loginNaverUser: 같은 사용자 재로그인은 토큰을 회전 — 옛 토큰 즉시 무효', () => {
  const a = loginNaverUser({ providerUserId: 'n1', nickname: '테스터' });
  const b = loginNaverUser({ providerUserId: 'n1', nickname: '테스터' });
  assert.notEqual(a.sessionToken, b.sessionToken);
  assert.equal(getUserBySessionToken(a.sessionToken), null);
  assert.ok(getUserBySessionToken(b.sessionToken));
});

test('loginNaverUser: 닉네임은 새 값으로 업데이트, 미지정이면 이전 값 유지', () => {
  loginNaverUser({ providerUserId: 'n1', nickname: '닉1' });
  loginNaverUser({ providerUserId: 'n1', nickname: '닉2' });
  assert.equal(getUserByNaverId('n1').nickname, '닉2');
  loginNaverUser({ providerUserId: 'n1', nickname: '' });
  assert.equal(getUserByNaverId('n1').nickname, '닉2');
});

test('getUserBySessionToken: 다른 사용자 토큰끼리 섞이지 않음', () => {
  const a = loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  const b = loginNaverUser({ providerUserId: 'n2', nickname: 'B' });
  assert.equal(getUserBySessionToken(a.sessionToken).providerUserId, 'n1');
  assert.equal(getUserBySessionToken(b.sessionToken).providerUserId, 'n2');
});

test('clearSessionToken: 로그아웃 후 토큰은 무효, 사용자/캐릭터 레코드는 보존', () => {
  const u = loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', { name: 'A', level: 7 });
  clearSessionToken('n1');
  assert.equal(getUserBySessionToken(u.sessionToken), null);
  assert.equal(getUserByNaverId('n1').sessionToken, null);
  assert.equal(getCharacterFor('n1').level, 7);
});

test('saveCharacterFor / getCharacterFor: 스냅샷 저장과 조회', () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', {
    name: '카이런', klass: 'mage', level: 12,
    inventory: [{ id: 'potion_hp', qty: 3 }],
    equipment: { weapon: { id: 'short_sword' } },
    roomId: 'square',
  });
  const ch = getCharacterFor('n1');
  assert.equal(ch.name, '카이런');
  assert.equal(ch.klass, 'mage');
  assert.equal(ch.level, 12);
  assert.equal(ch.inventory[0].id, 'potion_hp');
  assert.equal(ch.equipment.weapon.id, 'short_sword');
});

test('saveCharacterFor: 미등록 사용자 호출은 무시(no-op, throw 안 함)', () => {
  // throws 하면 게임 진행이 끊기므로 silent — 「인증된 player 만 저장」 의 단일성을 store 가 강제.
  saveCharacterFor('unknown_id', { name: 'x' });
  assert.equal(getCharacterFor('unknown_id'), null);
});

test('flushNow + initStore: 디스크 round-trip 으로 사용자/캐릭터 보존', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: '디스크' });
  saveCharacterFor('n1', { name: '디스크', level: 5, klass: 'mage' });
  await flushNow();

  // 같은 디렉터리로 모듈 상태만 리셋 — 로컬 SQLite 에서 다시 읽혀야 함.
  await _resetForTesting(tmpDir);
  await initStore();

  const u = getUserByNaverId('n1');
  assert.ok(u, '재로딩 후 사용자 레코드 존재');
  assert.equal(u.nickname, '디스크');
  const ch = getCharacterFor('n1');
  assert.equal(ch.name, '디스크');
  assert.equal(ch.level, 5);
  assert.equal(ch.klass, 'mage');
});

test('flushNow: 데이터가 로컬 SQLite (local.db) 에 영속됨', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', { name: 'A', level: 7 });
  await flushNow();

  // 별도 libsql 클라이언트로 같은 파일을 열어 row 직접 확인 — 우리 모듈
  // 캐시를 우회하므로 진짜 디스크에 도달했는지 검증한다.
  const dbPath = path.join(tmpDir, 'local.db');
  const stat = await fs.stat(dbPath);
  assert.ok(stat.size > 0, 'local.db 가 비어있지 않다');
  const c2 = createClient({ url: 'file:' + dbPath });
  try {
    const rs = await c2.execute('SELECT naver_id, nickname, character_json FROM users WHERE naver_id = ?', ['n1']);
    assert.equal(rs.rows.length, 1);
    assert.equal(rs.rows[0].nickname, 'A');
    const ch = JSON.parse(rs.rows[0].character_json);
    assert.equal(ch.level, 7);
  } finally {
    await c2.close();
  }
});

test('initStore: 옛 users.json 이 있으면 SQLite 로 1회 마이그레이션', async () => {
  // 직전 init 이 만든 SQLite 와 클라이언트를 정리한 뒤 「JSON 만 있는」 상태
  // 로 만들어 init 을 다시 돈다.
  await _resetForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agria-store-'));
  await fs.writeFile(path.join(tmpDir, 'users.json'), JSON.stringify({
    byNaverId: {
      legacy_user: {
        provider: 'naver',
        providerUserId: 'legacy_user',
        nickname: '레거시',
        sessionToken: 'legacy_token_xyz',
        sessionRotatedAt: 1000,
        character: { name: '레거시영웅', level: 3 },
        createdAt: 500,
        updatedAt: 500,
      },
    },
  }), 'utf8');

  await _resetForTesting(tmpDir);
  // 마이그레이션 성공 로그가 노이즈로 보이지 않도록 stub.
  const origLog = console.log;
  console.log = () => {};
  try { await initStore(); } finally { console.log = origLog; }

  const u = getUserByNaverId('legacy_user');
  assert.ok(u, '마이그레이션된 사용자 존재');
  assert.equal(u.nickname, '레거시');
  assert.equal(u.character.level, 3);
  // 토큰도 보존돼 같은 세션이 유지된다.
  assert.equal(getUserBySessionToken('legacy_token_xyz'), u);
});

test('재로그인은 character 를 보존', () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', { name: 'A', level: 9 });
  const b = loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  assert.equal(getUserBySessionToken(b.sessionToken).character.level, 9);
});
