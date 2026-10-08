import type { Item, LatLng, Listing, Partner, Recipient } from "../../src/matching/types.ts";

/** Wednesday 7 Oct 2026, 12:00 in Bengaluru (06:30 UTC). */
export const WED_NOON = Date.UTC(2026, 9, 7, 6, 30);
export const MIN = 60_000;
export const at = (hh: number, mm = 0) => WED_NOON + ((hh - 12) * 60 + mm) * MIN;

export const KORAMANGALA: LatLng = { lat: 12.9352, lng: 77.6245 };

/** A point roughly `km` of road distance east of `from` (road factor 1.4). */
export function east(from: LatLng, km: number): LatLng {
  const straight = km / 1.4;
  return { lat: from.lat, lng: from.lng + straight / (111.32 * Math.cos((from.lat * Math.PI) / 180)) };
}

export function item(over: Partial<Item> = {}): Item {
  return { id: "i1", servings: 50, grade: "A", confidence: 90, safeTime: 420, diet: "veg", ...over };
}

export function listing(over: Partial<Listing> = {}): Listing {
  const now = over.createdAt ?? WED_NOON;
  return {
    id: "l1",
    donorPhone: "9800000001",
    donorName: "Sample Hotel",
    areaId: "koramangala",
    ...KORAMANGALA,
    pickupAddress: "Sample Hotel, 80ft Road",
    readyFrom: now,
    collectBy: now + 60 * MIN,
    storage: "room",
    containers: ["2 insulated bags"],
    items: [item()],
    status: "matching",
    createdAt: now,
    ...over,
  };
}

export function recipient(over: Partial<Recipient> & { id: string }): Recipient {
  return {
    name: over.id,
    areaId: "koramangala",
    ...KORAMANGALA,
    kind: "ngo",
    vulnerable: false,
    fridge: false,
    servingTimes: [],
    servesWithinMin: 15,
    acceptsDiet: ["veg", "jain", "egg", "nonveg"],
    halalOnly: false,
    avoidAllergens: [],
    capacityPerDelivery: 100,
    acceptRadiusKm: 10,
    active: true,
    ...over,
  };
}

export function partner(over: Partial<Partner> & { id: string }): Partner {
  return { name: over.id, areaId: "koramangala", ...KORAMANGALA, travel: "two_wheeler", online: true, ...over };
}
