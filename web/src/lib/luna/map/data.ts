/**
 * Food Heat Map client. The data comes from the Luna API (`/map/*`); the
 * types here mirror `api/src/map/model.ts`. All of it is SAMPLE data for now.
 */
import { api } from "../api";

export const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export const SLOT_COUNT = 8;
/** 3-hour windows: 00–03 … 21–24 */
export const SLOT_LABELS = ["00–03", "03–06", "06–09", "09–12", "12–15", "15–18", "18–21", "21–24"];
export const WINDOWS = DAYS.length * SLOT_COUNT;

export type DonorKind = "restaurant" | "caterer" | "hotel" | "household";

export interface Ngo {
  name: string;
  type: "NGO" | "Shelter" | "Orphanage" | "Old-age home" | "Community fridge";
  mealsPerDay: number;
  fridge: boolean;
}

export interface Donor {
  name: string;
  kind: DonorKind;
}

export interface Area {
  id: string;
  name: string;
  lng: number;
  lat: number;
  surplus: Record<DonorKind, number>;
  ngos: Ngo[];
  estimatedNeed?: number;
  reach: number;
  donors: Donor[];
}

export interface WindowStats {
  surplus: number;
  need: number;
  received: number;
  short: number;
  gapRatio: number;
  isGap: boolean;
}

export type Snapshot = Record<string, WindowStats>;

export interface Hex {
  id: number;
  areaId: string;
  weight: number;
  ring: [number, number][];
}

export interface AreaWeek {
  area: Area;
  surplus: number;
  need: number;
  received: number;
  short: number;
  worst: { day: number; slot: number; short: number };
  gapWindows: number;
}

export interface RailEntry {
  areaId: string;
  name: string;
  short: number;
  worst: { day: number; slot: number; short: number };
  gapWindows: number;
}

export interface MapWeek {
  areas: Area[];
  hexes: Hex[];
  /** One snapshot per window, index = day * 8 + slot. */
  windows: Snapshot[];
  /** City-wide meals short per window, for the time tape. */
  series: number[];
  /** This week's most underserved areas. */
  top: RailEntry[];
}

export interface AreaDetail {
  area: Area;
  week: AreaWeek;
  trend: { label: string; pct: number }[];
  topDonors: (Donor & { mealsPerWeek: number })[];
}

export function getMapWeek() {
  return api<MapWeek>("/map/week");
}

export function getAreaDetail(id: string) {
  return api<AreaDetail>(`/map/areas/${encodeURIComponent(id)}`);
}

export function dailyNeed(a: Area) {
  return a.ngos.length ? a.ngos.reduce((n, g) => n + g.mealsPerDay, 0) : (a.estimatedNeed ?? 0);
}

export function windowIndex(day: number, slot: number) {
  return day * SLOT_COUNT + slot;
}
export function fromIndex(i: number) {
  return { day: Math.floor(i / SLOT_COUNT), slot: i % SLOT_COUNT };
}
export function windowLabel(i: number) {
  const { day, slot } = fromIndex(i);
  const [a, b] = SLOT_LABELS[slot].split("–");
  return `${DAYS[day]} ${a}:00–${b}:00`;
}
export function windowShort(day: number, slot: number) {
  return `${DAYS[day]} ${SLOT_LABELS[slot]}`;
}
