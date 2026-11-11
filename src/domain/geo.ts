import type { Centre, CentreIndex } from './types.ts';

const EARTH_RADIUS_KM = 6371;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** 两点之间的直线距离（公里，大圆距离） */
export function distanceKm(a: Pick<Centre, 'lat' | 'lng'>, b: Pick<Centre, 'lat' | 'lng'>): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function indexCentres(list: readonly Centre[]): CentreIndex {
  return new Map(list.map((c) => [c.id, c]));
}

/** 某考点到一组目标考点的最近距离；考点不存在时抛错 */
export function minDistanceKm(centreId: number, targetIds: readonly number[], centres: CentreIndex): number {
  const c = centres.get(centreId);
  if (!c) throw new Error(`未知考点: ${centreId}`);
  let best = Infinity;
  for (const id of targetIds) {
    const t = centres.get(id);
    if (!t) throw new Error(`未知目标考点: ${id}`);
    best = Math.min(best, distanceKm(c, t));
  }
  return best;
}

/** 目标考点附近（不含目标本身）、在距离范围内的考点，按距离从近到远 */
export function nearbyCentres(
  targetIds: readonly number[],
  maxKm: number,
  centres: CentreIndex,
): Centre[] {
  const targets = new Set(targetIds);
  const result: { centre: Centre; km: number }[] = [];
  for (const c of centres.values()) {
    if (targets.has(c.id)) continue;
    const km = minDistanceKm(c.id, targetIds, centres);
    if (km <= maxKm) result.push({ centre: c, km });
  }
  return result.sort((a, b) => a.km - b.km || a.centre.id - b.centre.id).map((r) => r.centre);
}
