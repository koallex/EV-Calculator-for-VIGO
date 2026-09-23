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
  // Current public global instances. Private.coffee is the successor to the old
  // kumi.systems endpoint; VK Maps also publishes a global Overpass instance.
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

// Race the public mirrors instead of waiting 7-9s for one dead mirror and only then
// trying another. This keeps the Vercel function comfortably inside the Hobby limit.
const REQUEST_TIMEOUT_MS = 7000;

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

  const attempt = async (endpoint: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'EV-Calculator-for-VIGO/1.01 (charging-station lookup)',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const settled = await Promise.allSettled(OVERPASS_ENDPOINTS.map(endpoint => attempt(endpoint)));
  const success = settled.find((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled');
  if (success) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(success.value);
  }

  const errors = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
  console.error('[osm-proxy] all Overpass endpoints failed:', errors);
  return res.status(502).json({
    error: 'OSM/Overpass unavailable',
    message: errors.join(' | '),
  });
}
