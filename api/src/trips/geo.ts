import type { LatLng, TripPoint } from "./types.ts";
import { TRIP_CONFIG as C } from "./config.ts";
const R = 6_371_000;
const rad = (n: number) => n * Math.PI / 180;
export function distance(a: LatLng, b: LatLng): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}
/** Local metre projection; searches only near prior progress to avoid crossing-road jumps. */
export function project(point: LatLng, path: LatLng[], minIndex = 0, maxIndex = path.length - 2) {
  let best = { point, distanceM: Infinity, index: 0, fraction: 0, progressM: 0 };
  let progressM = 0;
  const xScale = Math.cos(rad(point.lat));
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1], length = distance(a, b);
    if (i >= minIndex && i <= maxIndex) {
      const dx = (b.lng - a.lng) * xScale, dy = b.lat - a.lat;
      const t = Math.max(0, Math.min(1, (((point.lng - a.lng) * xScale) * dx + (point.lat - a.lat) * dy) / (dx * dx + dy * dy || 1)));
      const p = interpolate(a, b, t), d = distance(point, p);
      if (d < best.distanceM) best = { point: p, distanceM: d, index: i, fraction: t, progressM: progressM + length * t };
    }
    progressM += length;
  }
  return best;
}
export function along(path: LatLng[], metres: number): LatLng {
  for (let i = 0; i < path.length - 1; i++) {
    const d = distance(path[i], path[i + 1]);
    if (metres <= d) return interpolate(path[i], path[i + 1], Math.max(0, metres / (d || 1)));
    metres -= d;
  }
  return path.at(-1) ?? { lat: 0, lng: 0 };
}
export function pathLength(path: LatLng[]) {
  return path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0);
}
/** Interpolate along road geometry so a new fix does not cut diagonally across a turn. */
export function smoothPosition(from: LatLng, to: LatLng, path: LatLng[], amount: number): LatLng {
  const start = project(from, path), end = project(to, path);
  if (start.distanceM <= C.snapM && end.distanceM <= C.snapM && end.progressM >= start.progressM)
    return along(path, start.progressM + (end.progressM - start.progressM) * amount);
  return interpolate(from, to, amount);
}
/** Presentation-only prediction. Raw GPS remains the record and geofence input. */
export function predict(point: TripPoint, path: LatLng[], now: number): LatLng {
  const age = now - point.at;
  if (age < 0 || age > C.staleMs || point.accuracyM > C.snapM) return point;
  const p = project(point, path);
  if (p.distanceM > C.snapM || point.speedMps === null || point.speedMps <= 0) return point;
  // Never coast around a corner before a real fix confirms the turn.
  const remainingSegment = distance(p.point, path[p.index + 1]);
  const travel = Math.min(remainingSegment, Math.min(age, C.predictionMs) / 1000 * Math.min(point.speedMps, C.maxSpeedMps));
  return along(path, p.progressM + travel);
}
export function validPoint(value: unknown): value is TripPoint {
  if (!value || typeof value !== "object") return false;
  const p = value as TripPoint;
  return Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180
    && Number.isFinite(p.at) && Number.isFinite(p.accuracyM) && p.accuracyM >= 0
    && (p.speedMps === null || Number.isFinite(p.speedMps) && p.speedMps >= 0)
    && (p.heading === null || Number.isFinite(p.heading) && p.heading >= 0 && p.heading < 360);
}
export function decodePolyline(encoded: string): LatLng[] {
  const path: LatLng[] = [];
  let i = 0, lat = 0, lng = 0;
  const read = () => {
    let result = 0, shift = 0, b: number;
    do {
      if (i >= encoded.length || shift > 30) throw new Error("Invalid route geometry.");
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 31) << shift;
      shift += 5;
    } while (b >= 32);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) { lat += read(); lng += read(); path.push({ lat: lat / 1e5, lng: lng / 1e5 }); }
  return path;
}
