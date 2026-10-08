/**
 * Approximate road distances and travel times. No paid maps API: straight-line
 * distance × a road factor, and a fixed speed per travel mode.
 */
import { config } from "../config.ts";
import type { LatLng, Travel } from "../types.ts";

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function straightKm(a: LatLng, b: LatLng) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

export function distanceKm(a: LatLng, b: LatLng) {
  return straightKm(a, b) * config.roadFactor;
}

export function etaMs(km: number, travel: Travel) {
  return (km / config.speedKmh[travel]) * 3_600_000;
}

const MODE: Record<Travel, string> = {
  two_wheeler: "driving",
  car: "driving",
  bicycle: "bicycling",
  foot: "walking",
  transit: "transit",
};

/** Free Google Maps directions link for turn-by-turn. */
export function mapsLink(origin: LatLng, dest: LatLng, travel: Travel = "two_wheeler") {
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=${MODE[travel]}`;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
