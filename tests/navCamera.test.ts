import { CourseSmoother, angleDelta, wrapPi, routeHeadingAhead, azimuthSignFromNorthVector, azimuthForCourse, zoomForSpeed, DEFAULT_COURSE_OPTIONS } from '../src/utils/navCamera';
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

ok(angleDelta(350, 10) === 20 && angleDelta(10, 350) === -20 && Math.abs(angleDelta(0, 180)) === 180, 'angleDelta wraps');
ok(Math.abs(wrapPi(3 * Math.PI / 2) + Math.PI / 2) < 1e-9, 'wrapPi');

// 1) Smoother: car turns from 170° to 190° through south (the wrap that used to spin the map) then a full U-turn
{
  const s = new CourseSmoother(); s.step(170, 0.033, 60);
  let prev = s.current!, maxStep = 0, t = 0;
  const seq = [190, 190, 190, 350, 350, 350];
  for (const tgt of seq) for (let i = 0; i < 90; i++) { const v = s.step(tgt, 0.033, 60)!; maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v; t += 0.033; }
  const capPerFrame = DEFAULT_COURSE_OPTIONS.maxRateDegS * 0.033;
  ok(maxStep <= capPerFrame + 1e-9, `rate cap holds: max step ${maxStep.toFixed(2)}° <= ${capPerFrame.toFixed(2)}°/frame`);
  ok(Math.abs(angleDelta(prev, 350)) < 5, `converges to target through wrap (end ${prev.toFixed(1)}°)`);
}
// 2) Noise: heading jitter ±6° around 90° at speed
{
  const s = new CourseSmoother(); s.step(90, 0.033, 60);
  let lo = 999, hi = -999; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 900; i++) { const v = s.step(90 + (rnd() - 0.5) * 12, 0.033, 60)!; if (i > 100) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  ok(hi - lo < 4, `jitter ±6° is damped to ${(hi - lo).toFixed(2)}° swing`);
}
// 3) Standing still: garbage headings must not move the map
{
  const s = new CourseSmoother(); s.step(45, 0.033, 60);
  for (let i = 0; i < 300; i++) s.step((i * 37) % 360, 0.033, 2);
  ok(s.current === 45, 'frozen below 7 km/h regardless of target noise');
}
// 4) Out-and-back route: on the way back the match must stay on the return leg (heading ~270), not snap to the outbound leg (~90)
{
  const out: [number, number][] = []; for (let i = 0; i <= 100; i++) out.push([53.9, 27.5 + i * 0.0005]);
  const back: [number, number][] = []; for (let i = 100; i >= 0; i--) back.push([53.90002, 27.5 + i * 0.0005]); // ~2 m apart
  const route = [...out, ...back];
  let hint: number | null = null, bad = 0, checks = 0;
  for (let i = 0; i < route.length - 5; i += 2) {
    const r = routeHeadingAhead(route, route[i][0] - 0.00002, route[i][1], hint); if (!r) { bad++; continue; }
    hint = r.idx; if (i > 105) { checks++; if (Math.abs(angleDelta(r.heading, 270)) > 20) bad++; }
  }
  ok(bad === 0 && checks > 40, `out-and-back route keeps return-leg heading (${checks} checks, ${bad} bad)`);
}
// 4b) control: same track but no history (full scan every time) — this is the old behaviour and must be caught as bad
{
  const out: [number, number][] = []; for (let i = 0; i <= 100; i++) out.push([53.9, 27.5 + i * 0.0005]);
  const back: [number, number][] = []; for (let i = 100; i >= 0; i--) back.push([53.90002, 27.5 + i * 0.0005]);
  const route = [...out, ...back]; let bad = 0;
  for (let i = 106; i < route.length - 5; i += 2) { const r = routeHeadingAhead(route, route[i][0] - 0.00002, route[i][1], null); if (r && Math.abs(angleDelta(r.heading, 270)) > 20) bad++; }
  ok(bad > 0, `control: without history the match flips to the wrong leg (${bad} bad) — test is meaningful`);
}
// 5) look-ahead smooths vertex zig-zag
{
  const pts: [number, number][] = []; for (let i = 0; i < 200; i++) pts.push([53.9 + i * 0.00004, 27.5 + (i % 2) * 0.000004]);
  const r = routeHeadingAhead(pts, pts[50][0], pts[50][1], null)!;
  ok(Math.abs(angleDelta(r.heading, 0)) < 3, `zig-zag polyline gives stable heading (${r.heading.toFixed(1)}°)`);
}
// 6) sign detection
ok(azimuthSignFromNorthVector(-100, 3) === 1, 'north left => +1');
ok(azimuthSignFromNorthVector(100, -3) === -1, 'north right => -1');
ok(azimuthSignFromNorthVector(0, -100) === 0, 'north still up => unusable (0)');
ok(azimuthSignFromNorthVector(1, 1) === 0, 'tiny vector => unusable (0)');
ok(Math.abs(azimuthForCourse(90, 1) - Math.PI / 2) < 1e-9 && Math.abs(azimuthForCourse(90, -1) + Math.PI / 2) < 1e-9, 'azimuthForCourse sign');
ok(Math.abs(azimuthForCourse(270, 1) + Math.PI / 2) < 1e-9, 'azimuth stays within ±π');
ok(zoomForSpeed(0) > zoomForSpeed(60) && zoomForSpeed(60) > zoomForSpeed(120), 'zoom decreases with speed');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
