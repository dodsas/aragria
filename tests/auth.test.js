// auth.js — OAuth 어댑터의 순수 부분 테스트.
// HTTP 라운드트립이 필요한 callback 흐름은 integration.test.js 가 다룬다.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNaverConfigured,
  readCookie,
  buildAuthorizeRedirect,
} from '../server/auth.js';

let savedEnv;
beforeEach(() => {
  savedEnv = {
    NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID,
    NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET,
    NAVER_CALLBACK_URL: process.env.NAVER_CALLBACK_URL,
  };
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('isNaverConfigured: id+secret 둘 다 있어야 true', () => {
  delete process.env.NAVER_CLIENT_ID;
  delete process.env.NAVER_CLIENT_SECRET;
  assert.equal(isNaverConfigured(), false);

  process.env.NAVER_CLIENT_ID = 'cid';
  assert.equal(isNaverConfigured(), false);

  process.env.NAVER_CLIENT_SECRET = 'csec';
  assert.equal(isNaverConfigured(), true);
});

test('readCookie: 단일 쿠키 추출', () => {
  const req = { headers: { cookie: 'agria_session=abc123' } };
  assert.equal(readCookie(req, 'agria_session'), 'abc123');
});

test('readCookie: 다중 쿠키에서 정확한 키만 추출', () => {
  const req = { headers: { cookie: 'foo=1; agria_session=xyz; bar=2' } };
  assert.equal(readCookie(req, 'agria_session'), 'xyz');
  assert.equal(readCookie(req, 'foo'), '1');
  assert.equal(readCookie(req, 'bar'), '2');
});

test('readCookie: 누락된 키 / 빈 헤더 / 비슷한 prefix 모두 안전', () => {
  assert.equal(readCookie({ headers: {} }, 'agria_session'), '');
  assert.equal(readCookie({ headers: { cookie: '' } }, 'agria_session'), '');
  // prefix 가 같지만 다른 키는 매치되면 안 됨.
  const req = { headers: { cookie: 'agria_sessionx=oops' } };
  assert.equal(readCookie(req, 'agria_session'), '');
});

test('readCookie: URL 인코딩된 값을 디코딩', () => {
  const req = { headers: { cookie: 'agria_session=' + encodeURIComponent('한글값+/=') } };
  assert.equal(readCookie(req, 'agria_session'), '한글값+/=');
});

test('buildAuthorizeRedirect: state 쿠키 + Naver authorize URL 합성', () => {
  process.env.NAVER_CLIENT_ID = 'test_cid';
  delete process.env.NAVER_CALLBACK_URL;

  const setCookies = [];
  const res = {
    getHeader: () => undefined,
    setHeader: (k, v) => { if (k === 'Set-Cookie') setCookies.push(v); },
  };
  const req = {
    headers: { host: 'localhost:3000' },
    socket: { encrypted: false },
  };
  const url = buildAuthorizeRedirect(req, res);

  // state 쿠키가 발급되어야 함 (CSRF 토큰).
  const stateCookie = setCookies.find(c => String(c).startsWith('agria_oauth_state='));
  assert.ok(stateCookie, 'state 쿠키 발급');

  // URL 은 Naver authorize 로 향하고 client_id/redirect_uri/state 가 모두 들어감.
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://nid.naver.com/oauth2.0/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'test_cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/naver/callback');
  assert.match(u.searchParams.get('state'), /^[a-f0-9]{32}$/);

  // state 쿠키 값이 URL 의 state 파라미터와 일치해야 콜백 검증이 통과.
  const cookieState = stateCookie.match(/agria_oauth_state=([^;]+)/)[1];
  assert.equal(decodeURIComponent(cookieState), u.searchParams.get('state'));
});

test('buildAuthorizeRedirect: NAVER_CALLBACK_URL env 가 host 헤더보다 우선', () => {
  process.env.NAVER_CLIENT_ID = 'test_cid';
  process.env.NAVER_CALLBACK_URL = 'https://prod.example.com/auth/naver/callback';

  const res = { getHeader: () => undefined, setHeader: () => {} };
  const req = { headers: { host: 'localhost:3000' }, socket: { encrypted: false } };
  const url = buildAuthorizeRedirect(req, res);
  const u = new URL(url);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://prod.example.com/auth/naver/callback');
});

test('buildAuthorizeRedirect: x-forwarded-proto 가 있으면 그 프로토콜로 합성', () => {
  process.env.NAVER_CLIENT_ID = 'test_cid';
  delete process.env.NAVER_CALLBACK_URL;
  const res = { getHeader: () => undefined, setHeader: () => {} };
  const req = {
    headers: { host: 'agria.example.com', 'x-forwarded-proto': 'https' },
    socket: { encrypted: false },
  };
  const url = buildAuthorizeRedirect(req, res);
  const u = new URL(url);
  assert.equal(
    u.searchParams.get('redirect_uri'),
    'https://agria.example.com/auth/naver/callback',
  );
});
