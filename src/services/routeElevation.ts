export interface RoutePoint { lat:number; lon:number; elevationM:number; distanceFromStartKm:number; }
export interface RouteElevationData { name:string; distanceKm:number; points:RoutePoint[]; startElevationM:number; endElevationM:number; elevationGainM:number; elevationLossM:number; grossClimbEnergyKwh:number; recoveredEnergyKwh:number; netElevationEnergyKwh:number; elevationAvailable:boolean; elevationNote?:string; }
export interface RouteProgress { stage:'geocoding'|'routing'|'sampling'|'elevation'|'calculating'; message:string; completed?:number; total?:number; }
const EARTH_RADIUS_M=6371000, DEFAULT_MASS_KG=1600, GRAVITY=9.80665, DRIVETRAIN_EFFICIENCY=.90, REGEN_EFFICIENCY=.65, NOISE_THRESHOLD_M=3;
// Open-Meteo's elevation endpoint accepts up to 100 coordinate pairs per request — batching at that
// size means even our longest routes (≤200 points) need only 1–2 requests instead of dozens.
const ELEVATION_BATCH_SIZE=100;
const ELEVATION_CACHE_PREFIX='ev_elevation_cache_v1:';
const ELEVATION_CACHE_TTL_MS=30*24*60*60*1000; // 30 days — terrain doesn't change, so a stale cache is still correct
const ELEVATION_COOLDOWN_KEY='ev_elevation_api_cooldown_until_v1';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

// Thrown specifically for HTTP 429 (daily quota exhausted) so callers can tell "quota is gone,
// degrade gracefully" apart from "something is actually broken, surface an error".
class ElevationLimitError extends Error { constructor(msg:string){ super(msg); this.name='ElevationLimitError'; } }

export const geocodeAddress=async(query:string)=>{const res=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=${encodeURIComponent(query)}`,{headers:{Accept:'application/json'}});if(!res.ok)throw new Error(`Не удалось найти адрес (${res.status})`);const d=await res.json();if(!Array.isArray(d)||!d[0])throw new Error('Адрес не найден');return{lat:Number(d[0].lat),lon:Number(d[0].lon),displayName:String(d[0].display_name||query)}};
export const fetchDrivingRoute=async(aLat:number,aLon:number,bLat:number,bLon:number)=>{const res=await fetch(`https://router.project-osrm.org/route/v1/driving/${aLon},${aLat};${bLon},${bLat}?overview=full&geometries=geojson&steps=false`);if(!res.ok)throw new Error(`Не удалось построить маршрут (${res.status})`);const d=await res.json(),r=d?.routes?.[0];if(!r?.geometry?.coordinates?.length)throw new Error('Маршрут не найден');return{distanceKm:Number(r.distance)/1000,coords:r.geometry.coordinates as [number,number][]}};
const haversineM=(a:[number,number],b:[number,number])=>{const[lo1,la1]=a,[lo2,la2]=b,dLa=(la2-la1)*Math.PI/180,dLo=(lo2-lo1)*Math.PI/180,x=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;return 2*EARTH_RADIUS_M*Math.asin(Math.min(1,Math.sqrt(x)))};

// Sample by travelled distance, not by geometry vertex count. Point budget is tiered by trip length:
// short trips get finer resolution (relative to their length), long trips are capped hard so that,
// combined with ELEVATION_BATCH_SIZE=100, we never need more than 2 elevation requests per route.
export const sampleRouteByDistance=(coords:[number,number][],distanceKm:number)=>{
  if(coords.length<2)return coords;
  const maxPoints = distanceKm<=100?75:distanceKm<=300?100:200;
  const target=Math.min(maxPoints,Math.max(24,Math.ceil(distanceKm/(distanceKm>150?1:distanceKm>30?.5:.25))+1));
  const totalM=coords.slice(1).reduce((s,c,i)=>s+haversineM(coords[i],c),0),step=totalM/Math.max(1,target-1);
  const out:[number,number][]=[coords[0]];let acc=0,next=step;
  for(let i=1;i<coords.length-1;i++){acc+=haversineM(coords[i-1],coords[i]);if(acc>=next){out.push(coords[i]);next+=step}}
  out.push(coords[coords.length-1]);
  return out;
};

// ---- Elevation profile cache -------------------------------------------------------------------
// Keyed on rounded start/end coordinates, independent of SOC/speed/climate/weather — those never
// change the terrain, so re-running the calculator for the same A→B trip should never re-hit the API.
interface CachedElevationProfile { coords:[number,number][]; elevations:number[]; savedAt:number; }
const roundCoord=(v:number)=>Math.round(v*10000)/10000; // ~11 m — plenty to identify "the same route"
const cacheKeyFor=(aLat:number,aLon:number,bLat:number,bLon:number)=>`${ELEVATION_CACHE_PREFIX}${roundCoord(aLat)},${roundCoord(aLon)}-${roundCoord(bLat)},${roundCoord(bLon)}`;
const readElevationCache=(key:string):CachedElevationProfile|null=>{
  try{
    const raw=localStorage.getItem(key); if(!raw)return null;
    const parsed=JSON.parse(raw) as CachedElevationProfile;
    if(!Array.isArray(parsed?.elevations)||!parsed.elevations.length||Date.now()-parsed.savedAt>ELEVATION_CACHE_TTL_MS){localStorage.removeItem(key);return null}
    return parsed;
  }catch{return null}
};
const writeElevationCache=(key:string,data:CachedElevationProfile)=>{try{localStorage.setItem(key,JSON.stringify(data))}catch{/* storage full/unavailable — caching is best-effort, safe to skip */}};

// ---- Daily-quota cooldown ------------------------------------------------------------------------
// Once we hit 429 we stop calling the elevation API entirely until Open-Meteo's quota resets, instead
// of burning further requests (and time) on retries that are guaranteed to fail.
const getCooldownUntil=():number=>{try{return Number(localStorage.getItem(ELEVATION_COOLDOWN_KEY)||0)}catch{return 0}};
const armElevationCooldown=()=>{try{const next=new Date();next.setUTCHours(24,0,0,0);localStorage.setItem(ELEVATION_COOLDOWN_KEY,String(next.getTime()))}catch{/* ignore */}};
const isElevationOnCooldown=()=>Date.now()<getCooldownUntil();

async function elevationBatch(batch:[number,number][],attempt=0):Promise<number[]>{
  const lat=batch.map(([,y])=>y.toFixed(5)).join(','),lon=batch.map(([x])=>x.toFixed(5)).join(',');
  try{
    const res=await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    if(!res.ok){
      if(res.status===429){armElevationCooldown();throw new ElevationLimitError('Дневной лимит запросов к API высот исчерпан')}
      if(res.status>=500&&attempt<2){await sleep(700*(attempt+1));return elevationBatch(batch,attempt+1)}
      const text=await res.text().catch(()=>''),suffix=text?` — ${text.slice(0,100)}`:'';
      throw new Error(`API высот: ${res.status}${suffix}`);
    }
    const d=await res.json();
    if(!Array.isArray(d.elevation)||d.elevation.length!==batch.length)throw new Error('API высот вернул неполные данные');
    const values=d.elevation.map(Number);
    if(values.some(v=>!Number.isFinite(v)))throw new Error('API высот вернул некорректные значения');
    return values;
  }catch(e){
    if(e instanceof ElevationLimitError)throw e;
    if(e instanceof TypeError&&attempt<2){await sleep(700*(attempt+1));return elevationBatch(batch,attempt+1)}
    throw e;
  }
}

export const fetchElevationProfile=async(coords:[number,number][],distanceKm:number,onProgress?:(p:RouteProgress)=>void)=>{
  const sampled=sampleRouteByDistance(coords,distanceKm),elevations:number[]=[];
  for(let i=0;i<sampled.length;i+=ELEVATION_BATCH_SIZE){
    const batch=sampled.slice(i,i+ELEVATION_BATCH_SIZE);
    onProgress?.({stage:'elevation',message:`Загружаем профиль высот: ${Math.min(i+batch.length,sampled.length)}/${sampled.length} точек`,completed:Math.min(i+batch.length,sampled.length),total:sampled.length});
    elevations.push(...await elevationBatch(batch));
    if(i+ELEVATION_BATCH_SIZE<sampled.length)await sleep(180);
  }
  return{coords:sampled,elevations};
};

export const computeElevationGainLoss=(e:number[],threshold=NOISE_THRESHOLD_M)=>{let gain=0,loss=0,anchor=e[0];for(let i=1;i<e.length;i++){const delta=e[i]-anchor;if(delta>=threshold){gain+=delta;anchor=e[i]}else if(delta<=-threshold){loss+=-delta;anchor=e[i]}}return{gainM:Math.round(gain),lossM:Math.round(loss)}};
export const calculateElevationEnergy=(gain:number,loss:number,massKg=DEFAULT_MASS_KG)=>{const k=1/3600000,climb=massKg*GRAVITY*Math.max(0,gain)*k/DRIVETRAIN_EFFICIENCY,recovered=massKg*GRAVITY*Math.max(0,loss)*k*REGEN_EFFICIENCY;return{grossClimbEnergyKwh:Number(climb.toFixed(2)),recoveredEnergyKwh:Number(recovered.toFixed(2)),netElevationEnergyKwh:Number((climb-recovered).toFixed(2))}};

const ELEVATION_UNAVAILABLE_NOTE='Рельеф временно недоступен — расчёт выполнен без его влияния';

export const buildRouteElevation=async(aLat:number,aLon:number,bLat:number,bLon:number,name='Маршрут',onProgress?:(p:RouteProgress)=>void):Promise<RouteElevationData>=>{
  onProgress?.({stage:'routing',message:'Строим автомобильный маршрут…'});
  const route=await fetchDrivingRoute(aLat,aLon,bLat,bLon);
  onProgress?.({stage:'sampling',message:'Выбираем точки по расстоянию…'});

  const cacheKey=cacheKeyFor(aLat,aLon,bLat,bLon);
  const cached=readElevationCache(cacheKey);
  let profile:{coords:[number,number][];elevations:number[]};
  let elevationAvailable=true, elevationNote:string|undefined;

  if(cached){
    // Same A→B trip already has a saved elevation profile — reuse it, no API call needed even
    // though SOC/speed/climate/weather inputs may all be different this time.
    onProgress?.({stage:'elevation',message:'Профиль высот — из кэша'});
    profile={coords:cached.coords,elevations:cached.elevations};
  }else if(isElevationOnCooldown()){
    // Quota was exhausted earlier in the session — don't spend another request just to get another 429.
    elevationAvailable=false; elevationNote=ELEVATION_UNAVAILABLE_NOTE;
    onProgress?.({stage:'elevation',message:elevationNote});
    const flat=sampleRouteByDistance(route.coords,route.distanceKm);
    profile={coords:flat,elevations:flat.map(()=>0)};
  }else{
    try{
      profile=await fetchElevationProfile(route.coords,route.distanceKm,onProgress);
      writeElevationCache(cacheKey,{coords:profile.coords,elevations:profile.elevations,savedAt:Date.now()});
    }catch(e){
      if(e instanceof ElevationLimitError){
        // Daily limit hit just now: don't fail the whole trip calculation — continue with a flat
        // (zero elevation-delta) profile and tell the user plainly what happened.
        elevationAvailable=false; elevationNote=ELEVATION_UNAVAILABLE_NOTE;
        const flat=sampleRouteByDistance(route.coords,route.distanceKm);
        profile={coords:flat,elevations:flat.map(()=>0)};
      }else throw e;
    }
  }

  onProgress?.({stage:'calculating',message:'Считаем подъёмы, спуски и рекуперацию…'});
  let cum=0;
  const points=profile.coords.map((c,i)=>{if(i>0)cum+=haversineM(profile.coords[i-1],c);return{lon:c[0],lat:c[1],elevationM:profile.elevations[i],distanceFromStartKm:Number((cum/1000).toFixed(2))}});
  const{gainM,lossM}=computeElevationGainLoss(profile.elevations),energy=calculateElevationEnergy(gainM,lossM);
  return{name,distanceKm:Number(route.distanceKm.toFixed(1)),points,startElevationM:profile.elevations[0],endElevationM:profile.elevations.at(-1)!,elevationGainM:gainM,elevationLossM:lossM,...energy,elevationAvailable,elevationNote};
};
