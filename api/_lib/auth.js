import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SESSION_TTL = 60 * 60 * 24 * 7;
const USERS_KEY = 'vigo:users';
const SESS_PREFIX = 'vigo:session:';

// Brute-force protection for /api/auth/login. Keyed by IP + attempted login so a single
// attacker can't rotate logins to dodge the limit, and one user's mistyped password can't
// lock out other users sharing the same IP (e.g. NAT/office network).
const LOGIN_ATTEMPTS_PREFIX = 'vigo:loginattempts:';
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60; // 15-minute rolling lockout window
const LOGIN_MAX_ATTEMPTS = 5;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function loginAttemptsKey(req, login) {
  const normalized = (login || '').trim().toLowerCase();
  return `${LOGIN_ATTEMPTS_PREFIX}${getClientIp(req)}:${normalized}`;
}

// Call before verifying the password. Returns { allowed, retryAfterSeconds }.
export async function checkLoginRateLimit(req, login) {
  const key = loginAttemptsKey(req, login);
  try {
    const count = Number((await redis.get(key)) || 0);
    if (count >= LOGIN_MAX_ATTEMPTS) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : LOGIN_ATTEMPT_WINDOW_SECONDS };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch {
    // If Redis is unreachable, fail open on rate limiting rather than locking everyone out —
    // authenticate() will still fail closed if Redis is genuinely down (getUsers() needs it too).
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

// Call after a failed password check.
export async function recordFailedLoginAttempt(req, login) {
  const key = loginAttemptsKey(req, login);
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, LOGIN_ATTEMPT_WINDOW_SECONDS);
  } catch {
    // Best-effort — a Redis hiccup here shouldn't break login entirely.
  }
}

// Call after a successful login to un-penalize a previously-mistyped-then-corrected password.
export async function clearLoginAttempts(req, login) {
  const key = loginAttemptsKey(req, login);
  try { await redis.del(key); } catch { /* best-effort */ }
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${b64u(salt)}$${b64u(hash)}`;
}

function verifyPassword(password, encoded) {
  if (!encoded || !encoded.startsWith('scrypt$')) return false;
  const parts = encoded.split('$');
  if (parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function getUsers() {
  return (await redis.get(USERS_KEY)) || {};
}

async function saveUsers(users) {
  await redis.set(USERS_KEY, users);
}

function cookieOptions(maxAge) {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function authenticate(login, password) {
  const normalized = login.trim().toLowerCase();
  const adminLogin = (process.env.ADMIN_LOGIN || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';

  if (adminLogin && adminPassword && normalized === adminLogin && password === adminPassword) {
    return { login: process.env.ADMIN_LOGIN.trim(), role: 'admin' };
  }

  const users = await getUsers();
  const record = users[normalized];
  if (!record || record.disabled) return null;
  if (!verifyPassword(password, record.passwordHash)) return null;
  return { login: record.login, role: 'user' };
}

export async function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await redis.set(`${SESS_PREFIX}${token}`, user, { ex: SESSION_TTL });
  return token;
}

export async function getSession(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)vigo_session=([^;]+)/);
  if (!match) return null;
  try { return await redis.get(`${SESS_PREFIX}${match[1]}`); } catch { return null; }
}

export function setSessionCookie(res, user) {
  return createSession(user).then(token => {
    res.setHeader('Set-Cookie', `vigo_session=${token}; ${cookieOptions(SESSION_TTL)}`);
  });
}

export async function clearSession(req, res) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)vigo_session=([^;]+)/);
  if (match) await redis.del(`${SESS_PREFIX}${match[1]}`);
  res.setHeader('Set-Cookie', `vigo_session=; ${cookieOptions(0)}`);
}

export async function requireAdmin(req, res) {
  const user = await getSession(req);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Доступ запрещён.' });
    return null;
  }
  return user;
}

export { getUsers, saveUsers, hashPassword };


export async function getCurrentUser(req) {
  return getSession(req);
}

export async function listUsers() {
  const users = await getUsers();
  return Object.values(users);
}

export async function createUser(login, password) {
  const normalized = login.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/i.test(login.trim())) {
    throw new Error('Логин: 3–40 символов, только латинские буквы, цифры, точка, дефис или подчёркивание.');
  }
  if (normalized === (process.env.ADMIN_LOGIN || '').trim().toLowerCase()) {
    throw new Error('Этот логин зарезервирован для администратора.');
  }
  if (password.length < 8) throw new Error('Пароль должен содержать минимум 8 символов.');
  const users = await getUsers();
  if (users[normalized]) throw new Error('Пользователь с таким логином уже существует.');
  const user = { login: login.trim(), role: 'user', passwordHash: hashPassword(password), createdAt: new Date().toISOString(), disabled: false };
  users[normalized] = user;
  await saveUsers(users);
  return user;
}

export async function deleteUser(login) {
  const normalized = login.trim().toLowerCase();
  const users = await getUsers();
  if (!users[normalized]) return false;
  delete users[normalized];
  await saveUsers(users);
  return true;
}
