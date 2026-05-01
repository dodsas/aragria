// store.js — 영속 스토어 단위 테스트.
// 격리: 각 test 마다 fresh tmp dir 로 _resetForTesting → 디스크 상태가
// 인접 test 에 새지 않도록.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  _resetForTesting(tmpDir);
  await initStore();
});

afterEach(async () => {
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

  // 같은 디렉터리로 모듈 상태만 리셋 — 디스크에서 다시 읽혀야 함.
  _resetForTesting(tmpDir);
  await initStore();

  const u = getUserByNaverId('n1');
  assert.ok(u, '재로딩 후 사용자 레코드 존재');
  assert.equal(u.nickname, '디스크');
  const ch = getCharacterFor('n1');
  assert.equal(ch.name, '디스크');
  assert.equal(ch.level, 5);
  assert.equal(ch.klass, 'mage');
});

test('flushNow: atomic rename — 부분 쓰기로 깨진 JSON 이 남지 않음', async () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  await flushNow();
  // .tmp 가 남아 있지 않아야 함(rename 으로 정리).
  const entries = await fs.readdir(tmpDir);
  const tmpLeftover = entries.find(f => f.endsWith('.tmp'));
  assert.equal(tmpLeftover, undefined);
  // 메인 파일은 valid JSON 으로 파싱 가능.
  const raw = await fs.readFile(path.join(tmpDir, 'users.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.byNaverId.n1);
});

test('initStore: 손상된 JSON 은 빈 상태로 폴백(서버 부팅 차단 안 함)', async () => {
  await fs.writeFile(path.join(tmpDir, 'users.json'), 'not a valid json{', 'utf8');
  _resetForTesting(tmpDir);
  // 손상된 파일은 의도된 케이스라 stderr 로그가 노이즈로 흘러나오지 않도록 stub.
  const origErr = console.error;
  console.error = () => {};
  try { await initStore(); } finally { console.error = origErr; }
  assert.equal(getUserByNaverId('anything'), null);
  // 새 로그인은 정상 동작.
  const u = loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  assert.ok(u.sessionToken);
});

test('재로그인은 character 를 보존', () => {
  loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  saveCharacterFor('n1', { name: 'A', level: 9 });
  const b = loginNaverUser({ providerUserId: 'n1', nickname: 'A' });
  assert.equal(getUserBySessionToken(b.sessionToken).character.level, 9);
});
