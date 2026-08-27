import { Redis } from '@upstash/redis';
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export type AuthRole = 'admin' | 'user';
export interface AuthUser {
  login: string;
  role: AuthRole;
}

export interface StoredUser {
  login: string;
  passwordHash: string;
  createdAt: string;
  disabled?: boolean;
}

const getRedis = () => Redis.fromEnv();
const USER_SET = 'evigo:users';
const userKey = (login: string) => `evigo:user:${login.toLowerCase()}`;
const SESSION_COOKIE = 'evigo_session';
const SESSION_DAYS = 7;

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error('AUTH_SECRET must be configured and contain at least 32 characters.');
  }
  return value;
}

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [algorithm, salt, encodedHash] = encoded.split('$');
    if (algorithm !== 'scrypt' || !salt || !encodedHash) return false;
    const expected = Buffer.from(encodedHash, 'base64url');
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function createSession(user: AuthUser): string {
  const payload = encodePayload({
    ...user,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  return `${payload}.${sign(payload)}`;
}

function verifySession(token: string | undefined): AuthUser | null {
  if (!token) return null;
  try {
    const [payload, signature] = token.split('.');
    if (!payload || !signature || sign(payload) !== signature) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthUser & { exp: number };
    if (!parsed.login || !parsed.role || parsed.exp < Date.now()) return null;
    return { login: parsed.login, role: parsed.role };
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader = ''): Record<string, string> {
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join('='))])
  );
}

export function setSessionCookie(res: any, user: AuthUser): void {
  const token = createSession(user);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure}`
  );
}

export function clearSessionCookie(res: any): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

export async function getCurrentUser(req: any): Promise<AuthUser | null> {
  const cookies = parseCookies(req.headers?.cookie);
  const user = verifySession(cookies[SESSION_COOKIE]);
  if (!user) return null;

  if (user.role === 'admin') {
    if (user.login !== normalizeLogin(process.env.ADMIN_LOGIN || '')) return null;
    return user;
  }

  const stored = await getRedis().get<StoredUser>(userKey(user.login));
  if (!stored || stored.disabled || stored.login !== user.login) return null;
  return { login: stored.login, role: 'user' };
}

export async function authenticate(login: string, password: string): Promise<AuthUser | null> {
  const normalized = normalizeLogin(login);
  const adminLogin = normalizeLogin(process.env.ADMIN_LOGIN || '');

  // The administrator password is kept only as a Vercel Environment Variable.
  // It is never exposed to the browser, GitHub, Redis, or the client bundle.
  if (normalized && normalized === adminLogin) {
    // .trim() guards against a stray trailing newline/space that Vercel's
    // dashboard sometimes keeps when a value is pasted from a clipboard/manager.
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (!adminPassword) throw new Error('ADMIN_PASSWORD must be configured.');

    // Compare fixed-length HMAC digests rather than the raw passwords directly.
    // This avoids the length check short-circuiting on any accidental
    // whitespace difference, and avoids leaking password length via timing.
    const expected = Buffer.from(sign(adminPassword), 'base64url');
    const actual = Buffer.from(sign(password), 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { login: normalized, role: 'admin' };
  }

  const stored = await getRedis().get<StoredUser>(userKey(normalized));
  if (!stored || stored.disabled || !verifyPassword(password, stored.passwordHash)) return null;
  return { login: stored.login, role: 'user' };
}

export async function listUsers(): Promise<StoredUser[]> {
  const logins = await getRedis().smembers<string[]>(USER_SET);
  if (!logins.length) return [];
  const users = await Promise.all(
    logins.map((login) => getRedis().get<StoredUser>(userKey(login)))
  );
  return users.filter((u): u is StoredUser => Boolean(u));
}

export async function createUser(login: string, password: string): Promise<StoredUser> {
  const normalized = normalizeLogin(login);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalized)) {
    throw new Error('Логин: 3–32 символа, только a-z, 0-9, точка, _ или -.');
  }
  if (password.length < 8) throw new Error('Пароль должен содержать минимум 8 символов.');

  const adminLogin = normalizeLogin(process.env.ADMIN_LOGIN || '');
  if (normalized === adminLogin) throw new Error('Этот логин зарезервирован для администратора.');

  const key = userKey(normalized);
  const existing = await getRedis().get<StoredUser>(key);
  if (existing) throw new Error('Пользователь с таким логином уже существует.');

  const user: StoredUser = {
    login: normalized,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await getRedis().set(key, user);
  await getRedis().sadd(USER_SET, normalized);
  return user;
}

export async function deleteUser(login: string): Promise<boolean> {
  const normalized = normalizeLogin(login);
  const deleted = await getRedis().del(userKey(normalized));
  await getRedis().srem(USER_SET, normalized);
  return deleted > 0;
}
