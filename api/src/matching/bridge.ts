/**
 * Food Agent → Decision Agent. The Luna API's listing flow is the Food Agent: it takes the donor's
 * photo, items and tags, runs the quality model (luna_ngo, Gemini), the tag check and first-listing
 * review. A listing that passes becomes a Food Passport here and opens a case with the Decision Agent,
 * which asks the NGO Agent for shares and hands them to the Logistics Agent.
 */
import { AREAS } from "../map/model.ts";
import type { FoodListing, ListingItem } from "../listings/types.ts";
import { config } from "./config.ts";
import { straightKm } from "./engine/geo.ts";
import type { NewListing } from "./luna.ts";
import { areaIdFromName } from "./seed.ts";
import type { Diet, Item } from "./types.ts";

const servings = (l: FoodListing) => l.assessment?.servings ?? l.count * l.feedsEach;

const UNIT_WORD: Record<string, string> = { per_person_pack: "packs", shared_pack: "packs" };

/** One food as the agents see it: servings, its own grade and safe time, tags, and the amount in the donor's units. */
function itemFrom(it: ListingItem, idx: number, now: number): Item | null {
  const c = it.foodCheck;
  if (c && (c.grade === "D" || !c.safeUntil)) return null;   // Grade D never goes to people (§5 step 4)
  const safeUntil = c?.safeUntil ?? now;
  const q = it.quantity;
  const quantity = q.mode === "bulk" ? { amount: q.amount!, unit: q.unit! } : { amount: q.count!, unit: UNIT_WORD[q.mode] };
  return {
    id: `i${idx + 1}`, name: it.dish, category: it.category ?? "cooked_meal", servings: it.servings,
    grade: c?.grade ?? "C",
    confidence: !c || c.unsure || !c.photoChecked ? Math.min(config.unsureThreshold - 1, 50) : Math.max(config.unsureThreshold, c.score ?? 80),
    safeTime: Math.max(0, Math.floor((safeUntil - now) / 60_000)),
    diet: (it.diet === "nonveg" ? "nonveg" : it.diet === "egg" ? "egg" : it.jain ? "jain" : "veg") as Diet,
    halal: it.halal === "yes" || undefined,
    allergens: it.contains.length ? it.contains.flatMap((a) => (a === "onion_garlic" ? ["onion", "garlic"] : [a])) : undefined,
    tags: [it.role, ...(it.jain ? ["jain"] : [])],
    quantity, container: it.container, litresPerServing: it.litres !== null && it.servings ? it.litres / it.servings : null,
  };
}

/** The Food Passport for one checked listing: one item for a single dish, or every safe food in a session. */
export function passportFrom(l: FoodListing, now: number): NewListing {
  const area = areaIdFromName(l.pickup.area) ?? [...AREAS].sort((a, b) => straightKm(a, l.pickup) - straightKm(b, l.pickup))[0].id;
  const items = l.items
    ? l.items.map((it, i) => itemFrom(it, i, now)).filter((x): x is Item => !!x)
    : [singleItem(l, now)];
  return {
    donorPhone: l.donorPhone, donorName: l.donorName, areaId: area, lat: l.pickup.lat, lng: l.pickup.lng,
    pickupAddress: l.pickup.address, pickupNotes: l.pickup.notes || undefined, pickupContactPhone: l.contactPhone,
    readyFrom: Math.max(now, l.readyFrom), collectBy: Math.max(now, l.collectBy), storage: l.storage, cookedAt: l.cookedAt,
    containers: [], partnerBrings: l.containers === "partner_brings",
    sourceListingId: l.id, items,
  };
}

function singleItem(l: FoodListing, now: number): Item {
  const check = l.foodCheck, safeUntil = l.assessment?.safeUntil ?? check?.safeUntil ?? now;
  return {
    id: "i1", name: l.dish, category: l.category ?? "cooked_meal", servings: servings(l),
    grade: l.assessment?.grade ?? check?.grade ?? "C",
    confidence: check?.unsure || !check?.photoChecked ? Math.min(config.unsureThreshold - 1, 50) : Math.max(config.unsureThreshold, check?.score ?? 80),
    safeTime: Math.max(0, Math.floor((safeUntil - now) / 60_000)),
    diet: (l.diet === "nonveg" ? "nonveg" : l.diet === "egg" ? "egg" : l.jain ? "jain" : "veg") as Diet,
    halal: l.halal === "yes" || undefined,
    allergens: l.contains.length ? l.contains.flatMap((a) => (a === "onion_garlic" ? ["onion", "garlic"] : [a])) : undefined,
    tags: l.jain ? ["jain"] : undefined, container: "box", litresPerServing: null,
  };
}
