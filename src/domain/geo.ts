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
