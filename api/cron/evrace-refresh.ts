// Daily (or manual) EVRACE snapshot refresh → Upstash Redis.
//
// Vercel Hobby: one cron per day. After a fresh deploy, trigger once manually so the
// first user request does not see an empty registry:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/evrace-refresh
//
// Refresh is sequential with delays (Cloudflare rate-limits parallel scrapes).
import { forceRefreshEvraceCache } from '../_lib/evrace';

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${expected}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const result = await forceRefreshEvraceCache();
    return res.status(200).json({
      ok: true,
      totalGroups: result.totalGroups,
      groupsFetched: result.groups.length,
      failedPages: result.failedPages,
      fetchedAt: result.fetchedAt,
    });
  } catch (error) {
    console.error('[evrace] cron refresh failed:', error);
    return res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
