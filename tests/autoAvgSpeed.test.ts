import { estimateAutoAvgSpeed, freeFlowSpeedKmH, type AutoSpeedPoint } from '../src/utils/autoAvgSpeed';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

/** Маршрут из блоков [длина км, скорость OSRM], точки каждые ~1 км. */
const route = (blocks: [number, number][]): AutoSpeedPoint[] => {
  const pts: AutoSpeedPoint[] = [{ distanceFromStartKm: 0, roadSpeedKmH: blocks[0][1], roadSegmentLengthKm: blocks[0][0] }];
  let km = 0;
  for (const [len, v] of blocks) {
    const n = Math.max(1, Math.round(len));
    for (let i = 1; i <= n; i++) pts.push({ distanceFromStartKm: km + (len * i) / n, roadSpeedKmH: v, roadSegmentLengthKm: len });
    km += len;
  }
  return pts;
};
const avg = (b: [number, number][], max: number) => estimateAutoAvgSpeed(route(b), max)!.avgSpeedKmH;

const city: [number, number][] = [[20, 28]];
const regional: [number, number][] = [[5, 30], [60, 70], [5, 30]];
const mixed: [number, number][] = [[5, 30], [30, 70], [30, 95], [5, 30]];
const motorway: [number, number][] = [[100, 95]];

ok(freeFlowSpeedKmH(30) === 30, 'город: свободная скорость = скорость OSRM');
ok(freeFlowSpeedKmH(60) === 90 && freeFlowSpeedKmH(45) === 45, 'границы перехода 45→60 стыкуются без скачка');

// Чувствительность к максимуму
ok(avg(regional, 90) < avg(regional, 110) && avg(regional, 110) <= avg(regional, 130), 'выше максимум → не ниже средняя');
// Чувствительность к маршруту
ok(avg(city, 120) < avg(regional, 120) && avg(regional, 120) < avg(motorway, 120), 'город < региональная < трасса при одном максимуме');
ok(avg(mixed, 120) > avg(regional, 120), 'больше скоростных участков → выше средняя');
// Ограничения
ok(avg(motorway, 100) <= 95, 'средняя не превышает максимум − запас (100 → ≤ 95)');
ok(avg(city, 150) === 28, 'в городе максимум ни на что не влияет');
ok(avg(regional, 40) <= 35, 'очень низкий максимум ограничивает среднюю');
// Правдоподобие
const r = avg(regional, 120);
ok(r >= 65 && r <= 95, `региональный маршрут при максимуме 120 даёт правдоподобное значение (${r})`);
// Короткие шаги не считаются открытой дорогой
const noisy: AutoSpeedPoint[] = route([[30, 30]]).map((p, i) => i % 3 === 0 ? { ...p, roadSpeedKmH: 90, roadSegmentLengthKm: 0.1 } : p);
ok(estimateAutoAvgSpeed(noisy, 120)!.avgSpeedKmH < 45, 'короткие «быстрые» шаги не разгоняют городской маршрут');
// Нет данных
ok(estimateAutoAvgSpeed([], 120) === null && estimateAutoAvgSpeed(null, 120) === null, 'нет точек → null');
ok(estimateAutoAvgSpeed(route([[10, 60]]).map((p) => ({ ...p, roadSpeedKmH: undefined })), 120) === null, 'нет скоростей участков → null');
ok(estimateAutoAvgSpeed(route(regional), NaN) === null, 'некорректный максимум → null');
// Доля скоростных участков
ok(estimateAutoAvgSpeed(route(motorway), 120)!.fastShare > 0.9 && estimateAutoAvgSpeed(route(city), 120)!.fastShare === 0, 'fastShare: трасса ≈1, город = 0');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
