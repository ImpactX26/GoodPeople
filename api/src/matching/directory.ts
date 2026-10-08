/**
 * Who the NGO and Logistics Agents can work with, from the people who signed up in the app:
 *
 *  - Recipients: NGOs that listed themselves (default listing + today's listing). Their listings live in
 *    the Food Agent service (luna_ngo, `GET /api/ngos?mode=LIVE` already applies today's listing), keyed
 *    `NGO-<phone>`; the NGO's account phone is how offers reach them.
 *  - Partners: volunteer accounts, riding for an NGO (affiliatedNgo = that NGO's phone) or independent.
 *
 * Seeded sample NGOs and partners stay in the store for the local demo; with no claimed phone they are
 * ignored unless simulation is on (config.simulateUnclaimed).
 */
import { AREAS } from "../map/model.ts";
import { store as authStore } from "../store.ts";
import { straightKm } from "./engine/geo.ts";
import { areaIdFromName, kindFromLabel } from "./seed.ts";
import type { MatchingStore } from "./store.ts";
import type { Diet, Partner, Recipient, RecipientKind, Travel } from "./types.ts";

/** The listing shape the Food Agent service returns (luna_ngo models.NGO), only what we use. */
export interface ListedNgo {
  ngo_id: string;
  name: string;
  address?: string | null;
  location: { latitude: number; longitude: number };
  service_area_km: number;
  capacity: { daily_meal_capacity: number; available_capacity_today: number };
  current_demand: { meals_needed: number; urgency: string };
  accepted_categories: string[];
  dietary_constraints: string[];
  receiving_hours: { start: string; end: string };
  status: string;
}

const VULNERABLE = new Set<RecipientKind>(["orphanage", "old_age_home"]);
const TRAVEL: Record<string, Travel> = { "Two-wheeler": "two_wheeler", Bicycle: "bicycle", Car: "car", "On foot": "foot", "Bus or metro": "transit" };
const ALL_DIETS: Diet[] = ["veg", "jain", "egg", "nonveg"];
const PHONE = /^[6-9]\d{9}$/;

export const phoneOfNgo = (ngoId: string) => ngoId.match(/^NGO-([6-9]\d{9})$/)?.[1];
export const recipientIdFor = (ngoPhone: string) => `NGO-${ngoPhone}`;

function nearestArea(lat: number, lng: number) {
  return [...AREAS].sort((a, b) => straightKm(a, { lat, lng }) - straightKm(b, { lat, lng }))[0].id;
}

/** A listed NGO as a recipient the NGO Agent can rank. Need and room come from today's listing when set. */
export function recipientFrom(n: ListedNgo, kindLabel?: string): Recipient | null {
  const phone = phoneOfNgo(n.ngo_id);
  if (!phone) return null;
  const kind = kindFromLabel(kindLabel) ?? "ngo";
  const lat = n.location.latitude, lng = n.location.longitude;
  const area = n.address?.split(",").map((p) => areaIdFromName(p)).find(Boolean) ?? nearestArea(lat, lng);
  const rules = new Set(n.dietary_constraints);
  const acceptsDiet: Diet[] = rules.has("jain_only") ? ["jain"] : rules.has("vegetarian_only") ? ["veg", "jain"] : ALL_DIETS;
  const room = n.capacity.available_capacity_today;
  const need = n.current_demand.meals_needed;
  const capacity = need > 0 ? Math.min(room, need) : 0;
  return {
    id: n.ngo_id, phone, name: n.name, areaId: area, lat, lng, kind,
    vulnerable: VULNERABLE.has(kind), fridge: kind === "community_fridge",
    servingTimes: [], servesWithinMin: 30,
    acceptsDiet, halalOnly: rules.has("halal_only"), avoidAllergens: rules.has("nut_free") ? ["nuts", "peanuts"] : [],
    capacityPerDelivery: capacity, acceptRadiusKm: n.service_area_km,
    active: n.status === "ACTIVE" && capacity > 0,
    source: "listed", receivingHours: n.receiving_hours, acceptsCategories: n.accepted_categories,
  };
}

/** Pulls listed NGOs from the Food Agent service and volunteer accounts from the auth store into the agents' store. */
export async function syncDirectory(store: MatchingStore, opts: { ngoServiceUrl?: string; fetchImpl?: typeof fetch } = {}) {
  const url = (opts.ngoServiceUrl ?? process.env.FOOD_AGENT_URL ?? "").replace(/\/+$/, "");
  let recipients = 0, partners = 0;

  if (url) {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${url}/api/ngos?mode=LIVE`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const { ngos } = (await res.json()) as { ngos: ListedNgo[] };
        const seen = new Set<string>();
        for (const n of ngos) {
          const phone = phoneOfNgo(n.ngo_id);
          const r = recipientFrom(n, phone ? (await authStore.getProfile("ngo", phone))?.fields.kind : undefined);
          if (!r) continue;
          seen.add(r.id);
          await store.put("recipient", r);
          recipients++;
        }
        // An NGO that's no longer listed stops getting offers.
        for (const old of await store.list("recipient", { source: "listed" }))
          if (!seen.has(old.id) && old.active) await store.put("recipient", { ...old, active: false });
      }
    } catch (e) {
      console.error("NGO directory sync failed:", (e as Error).message);
    }
  }

  for (const p of await authStore.listProfiles("volunteer")) {
    const f = p.fields;
    const id = `prt_${p.phone}`;
    const existing = await store.get("partner", id);
    const area = areaIdFromName(f.area) ?? existing?.areaId ?? AREAS[0].id;
    const centre = AREAS.find((a) => a.id === area) ?? AREAS[0];
    const ngoPhone = f.affiliatedNgo && PHONE.test(f.affiliatedNgo) ? f.affiliatedNgo : undefined;
    const partner: Partner = {
      id, phone: p.phone, name: f.name || "Delivery partner", areaId: area,
      lat: existing?.lat ?? centre.lat, lng: existing?.lng ?? centre.lng,
      travel: TRAVEL[f.travel] ?? existing?.travel ?? "two_wheeler",
      // Online is the partner's own toggle (POST /agents/partner/online); a new partner starts offline.
      online: existing?.online ?? false,
      ngoId: ngoPhone ? recipientIdFor(ngoPhone) : undefined,
      activeShareId: existing?.activeShareId, source: "volunteer",
    };
    await store.put("partner", partner);
    partners++;
  }
  return { recipients, partners };
}
