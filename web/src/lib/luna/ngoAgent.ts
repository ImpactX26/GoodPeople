/**
 * Client for the NGO Matching Agent (Python FastAPI, `luna_ngo/`, run with `python run.py`).
 * Separate from the Railway API: set NEXT_PUBLIC_NGO_API_URL per environment.
 */
import { ApiError } from "./api";

export const NGO_API_URL = (process.env.NEXT_PUBLIC_NGO_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

/** Self-listed NGOs and real confirmations live in LIVE mode. */
export const MODE = "LIVE";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${NGO_API_URL}${path}`, {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, "Can’t reach the NGO agent. Is it running? (python run.py)");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new ApiError(res.status, typeof detail === "string" ? detail : "The NGO agent refused that request.");
  }
  return data as T;
}

// ---------------------------------------------------------------- NGOs

export type Urgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type NgoStatus = "ACTIVE" | "AT_CAPACITY" | "CLOSED" | "UNAVAILABLE";

export interface Ngo {
  ngo_id: string;
  name: string;
  address?: string | null;
  location: { latitude: number; longitude: number };
  service_area_km: number;
  capacity: { daily_meal_capacity: number; available_capacity_today: number };
  current_demand: { meals_needed: number; urgency: Urgency };
  food_preferences: string[];
  accepted_categories: string[];
  dietary_constraints: string[];
  receiving_hours: { start: string; end: string };
  active_donations: number;
  donations_received_today: number;
  population_served?: number | null;
  reliability: { source: string; [k: string]: unknown };
  history?: Record<string, unknown>;
  contact?: { phone?: string | null; webhook_url?: string | null };
  status: NgoStatus;
  data_source: "LIVE" | "DEMO_SYNTHETIC";
  /** Today's listing: changes to the defaults above that apply until midnight. */
  today?: TodayPlan | null;
  /** From GET /api/ngos/:id: whether `today` is for today. */
  today_active?: boolean;
}

export interface TodayPlan {
  date?: string;
  meals_needed?: number | null;
  urgency?: Urgency | null;
  available_capacity_today?: number | null;
  receiving_hours?: { start: string; end: string } | null;
}

/** The listing the agent uses today: defaults with today's changes on top. */
export function effectiveNgo(n: Ngo): Ngo {
  const t = n.today_active ? n.today : null;
  if (!t) return n;
  return {
    ...n,
    current_demand: { meals_needed: t.meals_needed ?? n.current_demand.meals_needed, urgency: t.urgency ?? n.current_demand.urgency },
    capacity: { ...n.capacity, available_capacity_today: Math.min(t.available_capacity_today ?? n.capacity.available_capacity_today, n.capacity.daily_meal_capacity) },
    receiving_hours: t.receiving_hours ?? n.receiving_hours,
  };
}

export const setToday = (ngoId: string, plan: TodayPlan) =>
  call<{ today: TodayPlan }>(`/api/ngos/${encodeURIComponent(ngoId)}/today?mode=${MODE}`, { method: "PUT", body: JSON.stringify(plan) });
export const clearToday = (ngoId: string) =>
  call<{ today: null }>(`/api/ngos/${encodeURIComponent(ngoId)}/today?mode=${MODE}`, { method: "DELETE" });

/** An NGO listed by a signed-in Luna account is keyed by that account's phone. */
export function ngoIdFor(phone: string) {
  return `NGO-${phone}`;
}

export const listNgos = () => call<{ ngos: Ngo[] }>(`/api/ngos?mode=${MODE}`).then((r) => r.ngos);

export async function getNgo(ngoId: string): Promise<Ngo | null> {
  try {
    return await call<Ngo>(`/api/ngos/${encodeURIComponent(ngoId)}?mode=${MODE}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export const saveNgo = (ngo: Ngo) =>
  call<Ngo>(`/api/ngos?mode=${MODE}`, { method: "POST", body: JSON.stringify(ngo) });

export const setNgoStatus = (ngoId: string, status: NgoStatus) =>
  call(`/api/ngos/${encodeURIComponent(ngoId)}/status?mode=${MODE}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });

// ---------------------------------------------------------------- delivery (NGO sends a partner; two codes)

/** The accepting NGO sends a delivery partner: a Luna volunteer account with this phone. */
export const assignPartner = (matchId: string, body: { ngo_id: string; partner_name: string; partner_phone: string }) =>
  call<{ assigned: boolean; partner_name: string }>(`/api/ngo-agent/${encodeURIComponent(matchId)}/partner`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export interface PartnerTask {
  match_id: string;
  ngo_id: string;
  stage: "to_pickup" | "to_drop" | "delivered";
  quantity: number;
  food_name?: string | null;
  food_category?: string | null;
  pickup: { name: string; location?: { latitude: number; longitude: number } | null };
  drop: { name: string; address?: string | null; location?: { latitude: number; longitude: number } | null };
  bring?: string | null;
  eta_at?: string | null;
  assigned_at?: string | null;
  picked_up_at?: string | null;
  delivered_at?: string | null;
}

export const listPartnerTasks = (phone: string) =>
  call<PartnerTask[]>(`/api/partner/tasks?mode=${MODE}&phone=${encodeURIComponent(phone)}`);

/** At the restaurant: the code shown on the donor's screen. */
export const confirmPickup = (matchId: string, partnerPhone: string, otp: string) =>
  call<{ verified: boolean; reason?: string }>(`/api/ngo-agent/${encodeURIComponent(matchId)}/pickup`, {
    method: "POST",
    body: JSON.stringify({ partner_phone: partnerPhone, otp }),
  });

/** At the NGO: the code shown on the NGO's screen. */
export const confirmDrop = (matchId: string, ngoId: string, otp: string) =>
  call<{ verified: boolean; reason?: string }>(`/api/ngo-agent/${encodeURIComponent(matchId)}/verify-otp`, {
    method: "POST",
    body: JSON.stringify({ ngo_id: ngoId, otp }),
  });

/** Directions link (opens Google Maps on the phone). */
export const mapsLink = (loc?: { latitude: number; longitude: number } | null) =>
  loc ? `https://www.google.com/maps/dir/?api=1&destination=${loc.latitude},${loc.longitude}` : null;

// ---------------------------------------------------------------- NGO inbox

export interface Offer {
  confirmation_id: string;
  match_id: string;
  ngo_id: string;
  quantity: number;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "NO_RESPONSE" | "UNAVAILABLE";
  reason?: string | null;
  requested_at: string;
  responded_at?: string | null;
  respond_by?: string | null;
  otp?: string | null;
  eta_at?: string | null;
  delivery_notes?: string | null;
  otp_verified_at?: string | null;
  partner_name?: string | null;
  partner_phone?: string | null;
  assigned_at?: string | null;
  picked_up_at?: string | null;
  food_name?: string | null;
  food_category?: string | null;
  dietary_tags: string[];
  allergens?: string[] | "UNKNOWN" | null;
  restaurant?: string | null;
  rescue_deadline?: string | null;
  rescue_score?: number | null;
  distance_km?: number | null;
  estimated_minutes?: number | null;
  match_status?: string | null;
}

export const listOffers = (ngoId: string) =>
  call<Offer[]>(`/api/portal/offers?mode=${MODE}&ngo_id=${encodeURIComponent(ngoId)}`);

export const answerOffer = (
  matchId: string,
  body: { ngo_id: string; response: "ACCEPTED" | "REJECTED"; reason?: string; delivery_notes?: string },
) =>
  call<{ recorded: boolean; otp?: string; eta_at?: string; delivery_notes?: string }>(
    `/api/ngo-agent/${encodeURIComponent(matchId)}/confirmation`,
    { method: "POST", body: JSON.stringify(body) },
  );

// ---------------------------------------------------------------- shared vocab

export const CATEGORIES: { id: string; label: string }[] = [
  { id: "cooked_meal", label: "Cooked meals" },
  { id: "bakery", label: "Bakery" },
  { id: "raw_produce", label: "Fruit & veg" },
  { id: "packaged", label: "Packaged" },
  { id: "dairy", label: "Dairy" },
  { id: "beverages", label: "Drinks" },
];

export const categoryLabel = (id?: string | null) => CATEGORIES.find((c) => c.id === id)?.label ?? id ?? "Food";

/** Centres of the pilot areas, matching the food map (api/src/map/model.ts). */
export const AREA_COORDS: Record<string, { latitude: number; longitude: number }> = {
  Koramangala: { latitude: 12.9352, longitude: 77.6245 },
  Jayanagar: { latitude: 12.925, longitude: 77.5938 },
  Indiranagar: { latitude: 12.9719, longitude: 77.6412 },
  "HSR Layout": { latitude: 12.9116, longitude: 77.6389 },
  Rajajinagar: { latitude: 12.991, longitude: 77.552 },
  Malleshwaram: { latitude: 13.0035, longitude: 77.5709 },
  "BTM Layout": { latitude: 12.9166, longitude: 77.6101 },
  "JP Nagar": { latitude: 12.9063, longitude: 77.5857 },
  Basavanagudi: { latitude: 12.9422, longitude: 77.5738 },
  Whitefield: { latitude: 12.9698, longitude: 77.75 },
  Marathahalli: { latitude: 12.9569, longitude: 77.7011 },
  Hebbal: { latitude: 13.0358, longitude: 77.597 },
  Yelahanka: { latitude: 13.1007, longitude: 77.5963 },
  "Electronic City": { latitude: 12.8452, longitude: 77.6602 },
  Nagarabhavi: { latitude: 12.9606, longitude: 77.5098 },
  "Rajarajeshwari Nagar": { latitude: 12.9274, longitude: 77.5195 },
  "Somewhere else in Bengaluru": { latitude: 12.9716, longitude: 77.5946 },
};

/** Rescue score: the agent's match score, already 0–100 (100 × Σ weight × factor). */
export const rescueScore = (s?: number | null) => Math.round(s ?? 0);
export function clock(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}
