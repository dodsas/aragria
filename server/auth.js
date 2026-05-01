// 네이버 OAuth 2.0 (간편 로그인) 어댑터.
// 흐름:
//   1) /auth/naver/login  → state 발급(쿠키 저장) + Naver authorize 로 302
//   2) /auth/naver/callback?code=&state=
//        - state 쿠키와 비교(CSRF)
//        - access_token 교환 (POST /oauth2.0/token)
//        - 프로필 조회 (GET /v1/nid/me)
//        - store.loginNaverUser() 로 단일 활성 sessionToken 회전
//        - agria_session 쿠키(httpOnly, SameSite=Lax) 발급 후 / 로 302
//   3) /auth/me      → 현재 세션 사용자 (없으면 401)
//   4) POST /auth/logout → 토큰 무효화 + 쿠키 제거
//
// env:
//   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET — 네이버 앱 등록에서 발급
//   NAVER_CALLBACK_URL — `${ORIGIN}/auth/naver/callback` 형태. 미지정이면
//                       요청의 host 헤더에서 자동 합성(개발 편의).
//   SESSION_COOKIE_SECURE — 'true' 면 Secure 플래그를 강제(프록시 뒤 https 환경).
//
// 네이버 토큰 응답 / 프로필 스키마는 공식 문서 기준으로 보수적으로만 파싱한다.

import crypto from 'node:crypto';
import {
  loginNaverUser,
  getUserBySessionToken,
  clearSessionToken,
  flushNow,
} from './store.js';

const NAVER_AUTHORIZE_URL = 'https://nid.naver.com/oauth2.0/authorize';
const NAVER_TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';
const NAVER_PROFILE_URL = 'https://openapi.naver.com/v1/nid/me';

const SESSION_COOKIE = 'agria_session';
const STATE_COOKIE = 'agria_oauth_state';
// 30 일. 사용자가 다른 디바이스에서 로그인할 때까지 유지 — 로그인 회전이
// 일어나면 토큰 비교에서 mismatch 가 되어 자연스럽게 만료 처리된다.
const SESSION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;
const STATE_COOKIE_MAX_AGE_SEC = 600;

export function isNaverConfigured() {
  return !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
}

// 요청 cookie 헤더에서 한 키만 뽑아낸다. cookie-parser 미사용 — 의존성 추가
// 비용이 크지 않지만 1~2개 쿠키만 다루므로 vanilla 가 더 명료.
export function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`Path=${opts.path || '/'}`);
  parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure ?? cookieSecureDefault()) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const next = prev ? (Array.isArray(prev) ? [...prev, parts.join('; ')] : [prev, parts.join('; ')]) : parts.join('; ');
  res.setHeader('Set-Cookie', next);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

function cookieSecureDefault() {
  // Render 등 프록시 뒤에서 https 종단되는 환경은 명시적 토글로 켠다.
  return process.env.SESSION_COOKIE_SECURE === 'true';
}

// 콜백 URL 합성 — env 가 우선, 없으면 요청의 host 헤더로 폴백.
function callbackUrl(req) {
  if (process.env.NAVER_CALLBACK_URL) return process.env.NAVER_CALLBACK_URL;
  const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'));
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/auth/naver/callback`;
}

export function buildAuthorizeRedirect(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, state, { maxAge: STATE_COOKIE_MAX_AGE_SEC });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.NAVER_CLIENT_ID,
    redirect_uri: callbackUrl(req),
    state,
  });
  return `${NAVER_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code, state, req) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.NAVER_CLIENT_ID,
    client_secret: process.env.NAVER_CLIENT_SECRET,
    code,
    state,
    redirect_uri: callbackUrl(req),
  });
  const r = await fetch(`${NAVER_TOKEN_URL}?${params.toString()}`, { method: 'GET' });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('no access_token in response');
  return j.access_token;
}

async function fetchNaverProfile(accessToken) {
  const r = await fetch(NAVER_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`profile endpoint ${r.status}`);
  const j = await r.json();
  if (j.resultcode !== '00' || !j.response) throw new Error(`profile bad result ${j.resultcode}`);
  return j.response; // { id, nickname, name, email, ... }
}

// 콜백 핸들러. user 가 인증되면 sessionToken 을 회전하고 cookie 로 발급 후
// `/` 로 302. 실패 시는 짧은 에러 페이지(자동 포맷, 의도적으로 정보 최소화).
export async function handleCallback(req, res) {
  const url = new URL(req.url, 'http://x');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = readCookie(req, STATE_COOKIE);
  clearCookie(res, STATE_COOKIE);

  if (!code || !state || !cookieState || state !== cookieState) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>로그인 실패</h1><p>요청이 유효하지 않습니다.</p><p><a href="/">돌아가기</a></p>');
    return;
  }

  try {
    const accessToken = await exchangeCodeForToken(code, state, req);
    const profile = await fetchNaverProfile(accessToken);
    const rec = loginNaverUser({
      providerUserId: profile.id,
      nickname: profile.nickname || profile.name || '',
    });
    // 로그인은 「유실 안 되는」 변경 — 즉시 flush. 다음 줄에서 만든 cookie 가
    // disk 의 sessionToken 과 빠르게 매칭되도록.
    await flushNow();
    setCookie(res, SESSION_COOKIE, rec.sessionToken, { maxAge: SESSION_COOKIE_MAX_AGE_SEC });
    res.statusCode = 302;
    res.setHeader('Location', '/');
    res.end();
  } catch (err) {
    console.error('[auth] callback failed:', err.message);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>로그인 실패</h1><p>네이버 인증 중 오류가 발생했습니다.</p><p><a href="/">돌아가기</a></p>');
  }
}

export function handleLoginRedirect(req, res) {
  if (!isNaverConfigured()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>네이버 로그인 비활성화</h1><p>NAVER_CLIENT_ID 가 설정되지 않았습니다.</p>');
    return;
  }
  const target = buildAuthorizeRedirect(req, res);
  res.statusCode = 302;
  res.setHeader('Location', target);
  res.end();
}

export function handleMe(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  const user = getUserBySessionToken(token);
  if (!user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    provider: user.provider,
    nickname: user.nickname,
    hasCharacter: !!user.character,
  }));
}

export async function handleLogout(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  const user = getUserBySessionToken(token);
  if (user) {
    clearSessionToken(user.providerUserId);
    await flushNow();
  }
  clearCookie(res, SESSION_COOKIE);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

// WS 업그레이드에서 세션 쿠키로 사용자 식별. 인증되지 않은 경우 null.
export function authenticateWsRequest(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const user = getUserBySessionToken(token);
  if (!user) return null;
  return {
    naverId: user.providerUserId,
    nickname: user.nickname,
    sessionToken: token,
  };
}
