/**
 * Donor incentives (SRS §9): impact, the Luna Partner badge, the leaderboard, the CSR/ESG report and surprise
 * bags. Shapes mirror api/src/impact/. kg and CO₂e are estimates (docs/IMPACT-BASIS.md); screens say so.
 */
import { api } from "./api";
import { getSession } from "./auth";
export type { DonationLabel } from "../../../../api/src/impact/label";

const token = () => getSession()?.token ?? null;

export interface ImpactNumbers {
  from: number;
  to: number;
  meals: number;
  deliveries: number;
  ngos: number;
  donations: number;
  biogasServings: number;
  kgSaved: number;
  co2eKg: number;
}
export interface Method { kgPerServing: number; co2ePerKg: number }

export interface MyImpact {
  name: string;
  area: string | null;
  fssai: string | null;
  month: string;
  monthly: ImpactNumbers;
  allTime: ImpactNumbers;
  partnerSince: number | null;
  rank: { area: string; position: number; of: number } | null;
  method: Method;
}
export const myImpact = (month?: string) => api<MyImpact>(`/agents/impact/me${month ? `?month=${month}` : ""}`, { token: token() });

export interface LogEntry { at: number; listingId: string; sourceListingId?: string; food: string; delivered: number; ngos: string[]; biogas: number; outcome: "delivered" | "biogas" | "not_placed" | "in_progress" }
export type Report = ImpactNumbers & { name: string; area: string | null; fssai: string | null; generatedAt: number; partnerSince: number | null; log: LogEntry[]; method: Method };
export const impactReport = (from: number, to: number) => api<Report>(`/agents/impact/report?from=${from}&to=${to}`, { token: token() });

export interface Board { month: string; areas: { areaId: string; area: string; top: { donor: string; meals: number; deliveries: number; kg: number }[] }[] }
export const leaderboard = (month: string) => api<Board>(`/agents/impact/leaderboard?month=${month}`);

export interface Bag {
  id: string;
  donorName: string;
  area: string;
  address: string;
  lat: number;
  lng: number;
  title: string;
  contents: string;
  diet: "veg" | "egg" | "nonveg";
  count: number;
  left: number;
  price: number;
  worth: number;
  pickupFrom: number;
  pickupUntil: number;
  status: "open" | "closed";
  km?: number | null;
}
export interface Hold { id: string; name: string; phone: string; code: string; status: "reserved" | "collected" | "cancelled"; createdAt: number; collectedAt?: number }
export const openBags = (near?: { lat: number; lng: number }) => api<Bag[]>(`/agents/bags${near ? `?lat=${near.lat}&lng=${near.lng}` : ""}`);
export const reserveBag = (id: string, name: string, phone: string) =>
  api<{ code: string; holdId: string; bag: Bag }>(`/agents/bags/${id}/reserve`, { method: "POST", body: JSON.stringify({ name, phone }) });
export const myBags = () => api<(Bag & { holds: Hold[] })[]>("/agents/bags/mine", { token: token() });
export const postBag = (b: { title: string; contents: string; diet: Bag["diet"]; count: number; price: number; worth: number; pickupFrom: number; pickupUntil: number; address?: string; lat?: number; lng?: number; area?: string }) =>
  api<Bag>("/agents/bags", { method: "POST", token: token(), body: JSON.stringify(b) });
export const bagCollected = (id: string, holdId: string, code: string) => api<{ ok: true }>(`/agents/bags/${id}/holds/${holdId}/collected`, { method: "POST", token: token(), body: JSON.stringify({ code }) });
export const closeBag = (id: string) => api<{ ok: true }>(`/agents/bags/${id}/close`, { method: "POST", token: token(), body: "{}" });

/** "2026-10" for this month (India time), and the month before. */
export function months(now = Date.now()) {
  const ist = new Date(now + 330 * 60_000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth();
  const fmt = (yy: number, mm: number) => `${yy}-${String(mm + 1).padStart(2, "0")}`;
  return { current: fmt(y, m), previous: m === 0 ? fmt(y - 1, 11) : fmt(y, m - 1) };
}
export const monthName = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
};
