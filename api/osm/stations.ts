// OSM/Overpass proxy for charging-station queries.
//
// v1.07: previously src/services/chargingStations.ts called overpass-api.de and
// overpass.kumi.systems directly from the browser. That is fragile in two independent ways —
// overpass-api.de intermittently fails CORS preflight (no Access-Control-Allow-Origin header),
// and on some networks the browser gets an outright ERR_CONNECTION_REFUSED to both public
// mirrors (looks like a network-level block — firewall/DNS/VPN — rather than anything this app
// controls). Routing the request through our own backend removes both failure modes: a
// server-to-server fetch has no CORS concept, and it isn't subject to whatever is blocking the
// user's browser from reaching those hosts directly.
export const config = { maxDuration: 15 };

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const REQUEST_TIMEOUT_MS = 7500; // One bounded attempt. Endpoints are raced in parallel so
                                 // a dead first mirror cannot consume the whole Vercel budget.

const numberParam = (value: unknown): number | undefined => {
  if (Array.isArray(value)) value = value[0];
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const south = numberParam(req.query.south);
  const west = numberParam(req.query.west);
  const north = numberParam(req.query.north);
  const east = numberParam(req.query.east);
  if ([south, west, north, east].some(v => v === undefined)) {
    return res.status(400).json({ error: 'Missing or invalid bbox params (south, west, north, east required)' });
  }

  const query = `[out:json][timeout:20];(nwr["amenity"="charging_station"](${south},${west},${north},${east});nwr["man_made"="charge_point"](${south},${west},${north},${east});nwr["amenity"="fuel"]["fuel:electricity"="yes"](${south},${west},${north},${east}););out center tags;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const attempt = async (endpoint: string) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'VIGO-EV-Calculator/1.01 (charging-stations; OSM Overpass proxy)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    return response.json();
  };

  try {
    // Race the public mirrors. The first healthy response wins; one stalled mirror
    // therefore cannot make the Vercel function wait for another 7.5s sequentially.
    const data = await Promise.any(OVERPASS_ENDPOINTS.map(attempt));
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (e) {
    const reasons = e instanceof AggregateError
      ? e.errors.map((reason: unknown) => reason instanceof Error ? reason.message : String(reason)).join('; ')
      : (e instanceof Error ? e.message : String(e));
    console.error('[osm-proxy] all Overpass endpoints failed:', reasons);
    return res.status(502).json({
      error: 'OSM/Overpass unavailable',
      message: reasons,
    });
  } finally {
    clearTimeout(timer);
  }
}
