import test from 'node:test';
import assert from 'node:assert/strict';
import { nextZoom, MAP_ZOOM_MIN, MAP_ZOOM_MAX, MAP_ZOOM_DEFAULT } from '../src/utils/mapZoom';

test('целый зум: шаг ровно на 1 уровень', () => {
  assert.equal(nextZoom(12, 1), 13);
  assert.equal(nextZoom(12, -1), 11);
});

test('дробный зум после щипка приводится к целому уровню в сторону нажатия', () => {
  assert.equal(nextZoom(12.37, 1), 13);
  assert.equal(nextZoom(12.37, -1), 12);
  assert.equal(nextZoom(12.99, 1), 13);
  assert.equal(nextZoom(12.01, -1), 12);
});

test('границы диапазона не пересекаются', () => {
  assert.equal(nextZoom(MAP_ZOOM_MAX, 1), MAP_ZOOM_MAX);
  assert.equal(nextZoom(MAP_ZOOM_MAX - 0.4, 1), MAP_ZOOM_MAX);
  assert.equal(nextZoom(MAP_ZOOM_MIN, -1), MAP_ZOOM_MIN);
  assert.equal(nextZoom(MAP_ZOOM_MIN + 0.4, -1), MAP_ZOOM_MIN);
});

test('некорректное значение (NaN / undefined с карты) не ломает шаг', () => {
  assert.equal(nextZoom(NaN, 1), MAP_ZOOM_DEFAULT + 1);
  assert.equal(nextZoom(Infinity, -1), MAP_ZOOM_DEFAULT - 1);
});

test('серия нажатий «+» поднимается по одному уровню и упирается в максимум', () => {
  let z = 16.4;
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) { z = nextZoom(z, 1); seen.push(z); }
  assert.deepEqual(seen, [17, 18, 19, 19, 19]);
});
