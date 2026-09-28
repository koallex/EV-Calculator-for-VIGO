import { getCurrentUser } from '../_lib/auth.js';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function dataKey(login: string) {
  return `vigo:userdata:${login.trim().toLowerCase()}`;
}

/**
 * Authenticated user data (sessions + settings) stored in Redis.
 * LocalStorage remains the offline cache; this is the durable account copy.
 *
 * GET  → { sessions, settings, updatedAt }
 * PUT  → body { sessions?, settings? } merges into stored blob
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getCurrentUser(req);
    if (!user?.login) return res.status(401).json({ error: 'Не авторизован.' });

    const key = dataKey(user.login);

    if (req.method === 'GET') {
      const raw = await redis.get(key);
      if (!raw) {
        return res.status(200).json({ sessions: null, settings: null, updatedAt: null });
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return res.status(200).json({
        sessions: Array.isArray(data.sessions) ? data.sessions : null,
        settings: data.settings && typeof data.settings === 'object' ? data.settings : null,
        updatedAt: data.updatedAt || null,
      });
    }

    // PUT
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const prevRaw = await redis.get(key);
    const prev =
      prevRaw == null
        ? {}
        : typeof prevRaw === 'string'
          ? JSON.parse(prevRaw)
          : prevRaw;

    const next = {
      sessions: Array.isArray(body.sessions) ? body.sessions : prev.sessions ?? null,
      settings:
        body.settings && typeof body.settings === 'object' ? body.settings : prev.settings ?? null,
      updatedAt: new Date().toISOString(),
    };

    // Soft size guard — history is the bulk of the payload.
    const encoded = JSON.stringify(next);
    if (encoded.length > 1_500_000) {
      return res.status(413).json({ error: 'Слишком большой объём данных.' });
    }

    await redis.set(key, next);
    return res.status(200).json({ ok: true, updatedAt: next.updatedAt });
  } catch (error) {
    console.error('User data error:', error);
    return res.status(500).json({ error: 'Не удалось обработать данные пользователя.' });
  }
}
