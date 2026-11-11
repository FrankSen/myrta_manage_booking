import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { distanceKm, indexCentres, minDistanceKm, nearbyCentres } from '../src/domain/geo.ts';
import type { Centre } from '../src/domain/types.ts';

const all: Centre[] = JSON.parse(readFileSync(new URL('../data/nsw-test-centres.json', import.meta.url), 'utf8'));
const centres = indexCentres(all);
const SILVERWATER = 241;

describe('geo', () => {
  test('考点数据完整：110 个且坐标合理', () => {
    expect(all).toHaveLength(110);
    for (const c of all) {
      expect(c.lat).toBeLessThan(-28);
      expect(c.lat).toBeGreaterThan(-38);
      expect(c.lng).toBeGreaterThan(140);
    }
  });
  test('Silverwater 到 Auburn 约 2.2 公里', () => {
    const km = distanceKm(centres.get(SILVERWATER)!, centres.get(112)!);
    expect(km).toBeGreaterThan(2.0);
    expect(km).toBeLessThan(2.4);
  });
  test('同一个点距离为 0', () => {
    expect(minDistanceKm(SILVERWATER, [SILVERWATER], centres)).toBe(0);
  });
  test('未知考点抛错', () => {
    expect(() => minDistanceKm(99999, [SILVERWATER], centres)).toThrow('未知考点');
  });
  test('Silverwater 10 公里内正好 6 个考点，Auburn 最近', () => {
    const near = nearbyCentres([SILVERWATER], 10, centres);
    expect(near.map((c) => c.id)).toEqual([112, 601, 521, 621, 96, 20]);
  });
  test('多个目标考点时取最近距离，且不含目标本身', () => {
    const near = nearbyCentres([SILVERWATER, 112], 10, centres);
    expect(near.find((c) => c.id === 112)).toBeUndefined();
    expect(near.find((c) => c.id === SILVERWATER)).toBeUndefined();
  });
});
