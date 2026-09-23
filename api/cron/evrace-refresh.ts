// Forces a full live re-fetch of the EVRACE registry and persists it to Redis, regardless of
// current cache freshness. Wired up in vercel.json to run once a day (Vercel Hobby only allows
// daily cron schedules — see https://vercel.com/docs/cron-jobs/usage-and-pricing). This exists
// so the cache is kept warm even without user traffic; in normal operation the
// stale-while-revalidate refresh in api/_lib/evrace.ts already keeps it warm as users hit
// /api/evrace/stations, so this is mainly a safety net (and a way to warm the cache right after
// a fresh deploy, since a brand-new Redis key means the very first real user request would
// otherwise have to wait on a live fetch).
//
// Can also be triggered manually, e.g. right after deploying:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/evrace-refresh
import { forceRefreshEvraceCache } from '../_lib/evrace';

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
  // Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on scheduled cron
  // invocations when the CRON_SECRET env var is set. If it isn't set, allow the call through
  // (useful for local dev), but this endpoint should not be left open on a public deployment.
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
