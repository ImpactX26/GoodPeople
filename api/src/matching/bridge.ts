/**
 * Food Agent → Decision Agent. The Luna API's listing flow is the Food Agent: it takes the donor's
 * photo, items and tags, runs the quality model (luna_ngo, Gemini), the tag check and first-listing
 * review. A listing that passes becomes a Food Passport here and opens a case with the Decision Agent,
 * which asks the NGO Agent for shares and hands them to the Logistics Agent.
 */
import { AREAS } from "../map/model.ts";
import type { FoodListing } from "../listings/types.ts";
import { config } from "./config.ts";
import { straightKm } from "./engine/geo.ts";
import type { NewListing } from "./luna.ts";
import { areaIdFromName } from "./seed.ts";
import type { Diet } from "./types.ts";

const servings = (l: FoodListing) => l.assessment?.servings ?? l.count * l.feedsEach;

/** What the partner carries: food boxes when the restaurant asked them to bring them (about 10 servings per
 * 5 L box), otherwise just a carry bag for the restaurant's sealed packs. */
export function containersFor(l: FoodListing): string[] {
  const n = servings(l);
  if (l.containers === "partner_brings") {
    const boxes = Math.max(1, Math.ceil(n / 10));
    return [`${boxes} food box${boxes === 1 ? "" : "es"} (5 L each)`, `${Math.max(1, Math.ceil(boxes / 3))} carry bag${boxes > 3 ? "s" : ""}`];
  }
  return [`${Math.max(1, Math.ceil(n / 15))} carry bag${n > 15 ? "s" : ""} (the food comes packed)`];
}

/** The Food Passport for one checked listing: one item (the dish) with its grade, safe time and tags. */
export function passportFrom(l: FoodListing, now: number): NewListing {
  const check = l.foodCheck, safeUntil = l.assessment?.safeUntil ?? check?.safeUntil ?? now;
  const diet: Diet = l.diet === "nonveg" ? "nonveg" : l.diet === "egg" ? "egg" : l.jain ? "jain" : "veg";
  const area = areaIdFromName(l.pickup.area) ?? [...AREAS].sort((a, b) => straightKm(a, l.pickup) - straightKm(b, l.pickup))[0].id;
  return {
    donorPhone: l.donorPhone, donorName: l.donorName, areaId: area, lat: l.pickup.lat, lng: l.pickup.lng,
    pickupAddress: l.pickup.address, pickupNotes: l.pickup.notes || undefined, pickupContactPhone: l.contactPhone,
    readyFrom: Math.max(now, l.readyFrom), collectBy: Math.max(now, l.collectBy), storage: l.storage, cookedAt: l.cookedAt,
    containers: containersFor(l),
    sourceListingId: l.id,
    items: [{
      id: "i1", name: l.dish, category: l.category ?? "cooked_meal", servings: servings(l),
      grade: l.assessment?.grade ?? check?.grade ?? "C",
      // "Unsure" food (photo not judged, or low confidence) gets the partner's pickup check.
      confidence: check?.unsure || !check?.photoChecked ? Math.min(config.unsureThreshold - 1, 50) : Math.max(config.unsureThreshold, check?.score ?? 80),
      safeTime: Math.max(0, Math.floor((safeUntil - now) / 60_000)),
      diet, halal: l.halal === "yes" || undefined,
      allergens: l.contains.length ? l.contains.flatMap((a) => (a === "onion_garlic" ? ["onion", "garlic"] : [a])) : undefined,
      tags: l.jain ? ["jain"] : undefined,
    }],
  };
}
