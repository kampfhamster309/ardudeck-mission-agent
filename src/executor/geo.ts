export type LatLon = [number, number];

/** Metres between two points (equirectangular; fine at lawn scale). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dn = (lat2 - lat1) * 111_320;
  const de = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dn, de);
}

/** Ray casting; polygon as [lat, lon] points. */
export function insidePolygon(lat: number, lon: number, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]!;
    const [yj, xj] = poly[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
