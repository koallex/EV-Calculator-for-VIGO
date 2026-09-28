import { getCurrentUser } from '../_lib/auth.js';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function dataKey(login: string) {
  return `vigo:userdata:${login.trim().toLowerCase()}`;
}

function fingerprint(s: any) {
  return `${s?.date}|${s?.distanceKm}|${s?.startSoc}|${s?.endSoc}|${s?.title || ''}`;
}

/**
 * Authenticated user data (sessions + settings) stored in Redis.
 * LocalStorage remains the offline cache; this is the durable account copy.
 *
 * GET  → { sessions, settings, updatedAt }
 * PUT  → body { sessions?, settings? } merges sessions by id/fingerprint
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

    // PUT — merge sessions by id (and fingerprint for id-less rows).
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const prevRaw = await redis.get(key);
    const prev =
      prevRaw == null
        ? {}
        : typeof prevRaw === 'string'
          ? JSON.parse(prevRaw)
          : prevRaw;

    let sessions = prev.sessions ?? null;
    if (Array.isArray(body.sessions)) {
      const byId = new Map<string, any>();
      const prints = new Set<string>();
      for (const s of Array.isArray(prev.sessions) ? prev.sessions : []) {
        if (s?.id) byId.set(String(s.id), s);
        prints.add(fingerprint(s));
      }
      for (const s of body.sessions) {
        if (!s || typeof s !== 'object') continue;
        if (s.id && byId.has(String(s.id))) {
          const old = byId.get(String(s.id));
          const newer =
            (s.createdAt || 0) >= (old?.createdAt || 0) ? { ...old, ...s } : { ...s, ...old };
          byId.set(String(s.id), newer);
        } else if (s.id) {
          byId.set(String(s.id), s);
          prints.add(fingerprint(s));
        } else if (!prints.has(fingerprint(s))) {
          byId.set(`srv-${Date.now()}-${byId.size}`, { ...s, id: `srv-${Date.now()}-${byId.size}` });
          prints.add(fingerprint(s));
        }
      }
      sessions = Array.from(byId.values()).sort(
        (a, b) => (b?.createdAt || 0) - (a?.createdAt || 0),
      );
    }

    const next = {
      sessions,
      settings:
        body.settings && typeof body.settings === 'object'
          ? { ...(prev.settings || {}), ...body.settings }
          : prev.settings ?? null,
      updatedAt: new Date().toISOString(),
    };

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
