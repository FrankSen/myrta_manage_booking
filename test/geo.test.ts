import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { distanceKm, indexCentres } from '../src/domain/geo.ts';
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
});
