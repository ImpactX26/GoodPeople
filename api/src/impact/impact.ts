/**
 * Donor impact (SRS §9): what a restaurant's donations did, from what actually happened in Luna, never from
 * what was listed (spec §21: impact counts use delivered servings, so nobody can inflate them by over-listing).
 * Feeds the impact certificate, the Luna Partner badge, the area leaderboard and the CSR/ESG report.
 *
 * Two numbers are estimates, and are labelled as such wherever they're shown (see docs/IMPACT-BASIS.md):
 *   - kg of food: listed amounts in kg are used as given; otherwise 350 g per served meal (Luna's assumption).
 *   - CO₂e avoided: 2.5 kg CO₂e per kg of food not wasted (FAO, Food Wastage Footprint, 2013:
 *     3.3 Gt CO₂e for about 1.3 Gt of food wasted a year).
 */
import { areaById } from "../matching/seed.ts";
import type { MatchingStore } from "../matching/store.ts";
import type { Listing, Share } from "../matching/types.ts";

export const KG_PER_SERVING = 0.35;
export const CO2E_PER_KG = 2.5;

const servingsOf = (lines: { servings: number }[]) => lines.reduce((n, x) => n + x.servings, 0);

export interface LogEntry {
  at: number;
  listingId: string;
  sourceListingId?: string;
  food: string;
  /** Servings that reached an NGO. */
  delivered: number;
  ngos: string[];
  /** Servings sent to a biogas plant (not food for people, but not landfill either). */
  biogas: number;
  outcome: "delivered" | "biogas" | "not_placed" | "in_progress";
}

export interface Impact {
  from: number;
  to: number;
  meals: number;
  deliveries: number;
  ngos: number;
  donations: number;
  biogasServings: number;
  kgSaved: number;
  co2eKg: number;
  log: LogEntry[];
}

/** kg of food in these servings: the donor's own kg when they gave the amount in kg, else the per-meal estimate. */
function kgOf(l: Listing, lines: { itemId: string; servings: number }[]) {
  let kg = 0;
  for (const ln of lines) {
    const item = l.items.find((i) => i.id === ln.itemId);
    const q = item?.quantity;
    kg += q && q.unit.toLowerCase() === "kg" && item!.servings > 0 ? (q.amount * ln.servings) / item!.servings : ln.servings * KG_PER_SERVING;
  }
  return kg;
}

export async function impactOf(store: MatchingStore, donorPhone: string, from: number, to: number): Promise<Impact> {
  const names = new Map((await store.list("recipient")).map((r) => [r.id, r.name]));
  const listings = (await store.list("listing", { donorPhone })).filter((l) => l.createdAt >= from && l.createdAt < to).sort((a, b) => a.createdAt - b.createdAt);
  const log: LogEntry[] = [];
  let meals = 0, deliveries = 0, gas = 0, kg = 0;
  const ngos = new Set<string>();
  for (const l of listings) {
    const shares: Share[] = await store.list("share", { listingId: l.id });
    const done = shares.filter((s) => s.status === "delivered");
    const bio = (await store.list("biogas", { listingId: l.id })).filter((b) => b.status === "collected");
    const delivered = done.reduce((n, s) => n + servingsOf(s.lines), 0);
    const biogas = bio.reduce((n, b) => n + servingsOf(b.lines), 0);
    meals += delivered;
    deliveries += done.length;
    gas += biogas;
    kg += done.reduce((n, s) => n + kgOf(l, s.lines), 0) + bio.reduce((n, b) => n + kgOf(l, b.lines), 0);
    for (const s of done) if (s.ngoId) ngos.add(s.ngoId);
    log.push({
      at: l.createdAt,
      listingId: l.id,
      sourceListingId: l.sourceListingId,
      food: l.items.map((i) => i.name ?? "food").join(", "),
      delivered,
      ngos: [...new Set(done.map((s) => names.get(s.ngoId ?? "") ?? "an NGO"))],
      biogas,
      outcome: delivered ? "delivered" : biogas ? "biogas" : l.status === "closed" ? "not_placed" : "in_progress",
    });
  }
  return { from, to, meals, deliveries, ngos: ngos.size, donations: listings.length, biogasServings: gas, kgSaved: Math.round(kg * 10) / 10, co2eKg: Math.round(kg * CO2E_PER_KG * 10) / 10, log };
}

const IST = 330 * 60_000;

/** India time month bounds for "2026-10". */
export function monthRange(month: string): { from: number; to: number } | null {
  const [ys, ms, extra] = month.split("-");
  if (extra !== undefined || ys?.length !== 4 || ms?.length !== 2) return null;
  const y = Number(ys), mo = Number(ms);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || mo < 1 || mo > 12) return null;
  return { from: Date.UTC(y, mo - 1, 1) - IST, to: Date.UTC(y, mo, 1) - IST };
}

export const thisMonth = (now: number) => new Date(now + IST).toISOString().slice(0, 7);

/** The Luna Partner badge: earned with the first donation that reached an NGO. */
export async function partnerSince(store: MatchingStore, donorPhone: string): Promise<number | null> {
  let first: number | null = null;
  for (const l of await store.list("listing", { donorPhone }))
    for (const s of await store.list("share", { listingId: l.id, status: "delivered" })) {
      const at = s.pickedUpAt ?? s.createdAt;
      if (first === null || at < first) first = at;
    }
  return first;
}

export interface Board {
  month: string;
  areas: { areaId: string; area: string; top: { donor: string; meals: number; deliveries: number; kg: number }[] }[];
}

/**
 * The monthly zero-waste leaderboard: per area, the restaurants whose food reached the most people (delivered
 * servings only). Public, so it carries the restaurant's name and numbers, never a phone or address.
 */
export async function leaderboard(store: MatchingStore, month: string, topN = 5): Promise<Board | null> {
  const range = monthRange(month);
  if (!range) return null;
  const tally = new Map<string, { areaId: string; donor: string; meals: number; deliveries: number; kg: number }>();
  for (const l of await store.list("listing")) {
    if (l.createdAt < range.from || l.createdAt >= range.to) continue;
    const done = await store.list("share", { listingId: l.id, status: "delivered" });
    if (!done.length) continue;
    const key = `${l.areaId}:${l.donorPhone}`;
    const t = tally.get(key) ?? { areaId: l.areaId, donor: l.donorName, meals: 0, deliveries: 0, kg: 0 };
    t.meals += done.reduce((n, s) => n + servingsOf(s.lines), 0);
    t.deliveries += done.length;
    t.kg += done.reduce((n, s) => n + kgOf(l, s.lines), 0);
    tally.set(key, t);
  }
  const byArea = new Map<string, { donor: string; meals: number; deliveries: number; kg: number }[]>();
  for (const t of tally.values()) byArea.set(t.areaId, [...(byArea.get(t.areaId) ?? []), { donor: t.donor, meals: t.meals, deliveries: t.deliveries, kg: Math.round(t.kg * 10) / 10 }]);
  const areas = [...byArea.entries()]
    .map(([areaId, rows]) => ({ areaId, area: areaById(areaId)?.name ?? areaId, top: rows.sort((a, b) => b.meals - a.meals || b.deliveries - a.deliveries).slice(0, topN) }))
    .sort((a, b) => b.top.reduce((n, r) => n + r.meals, 0) - a.top.reduce((n, r) => n + r.meals, 0));
  return { month, areas };
}
