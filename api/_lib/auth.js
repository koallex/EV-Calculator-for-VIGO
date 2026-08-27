import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SESSION_TTL = 60 * 60 * 24 * 7;
const USERS_KEY = 'vigo:users';
const SESS_PREFIX = 'vigo:session:';

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
  const match = raw.match(/(?:^|;\\s*)vigo_session=([^;]+)/);
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
  const match = raw.match(/(?:^|;\\s*)vigo_session=([^;]+)/);
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
