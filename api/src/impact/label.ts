/**
 * The donation label (SRS §9, "legal compliance, done for them"; spec §9.6): the details FSSAI's surplus-food
 * guidance expects on donated food, made from what the restaurant already told Luna and what the Food Agent
 * worked out, so nobody writes labels by hand. Printed by the restaurant, shown to the partner at pickup, and
 * kept with the donation as its log entry.
 *
 * Fields: food name, source (who and where), when it was prepared, the last time to eat it (the Food Agent's
 * safe-until), a veg / non-veg / egg mark, and the allergens declared. The exact required set should be
 * confirmed with a food-safety adviser (spec §9.6 [DECIDE]).
 */
import type { FoodListing } from "../listings/types.ts";

export interface DonationLabel {
  /** The donation's reference, for the log. */
  ref: string;
  source: { name: string; address: string; area: string; fssai: string | null };
  listedAt: number;
  items: {
    name: string;
    mark: "veg" | "nonveg" | "egg";
    jain: boolean;
    preparedAt: number;
    /** Consume by: the Food Agent's safe-until; null when it judged the food not fit for people. */
    consumeBy: number | null;
    storage: "hot" | "room" | "fridge";
    allergens: string[];
    servings: number;
  }[];
}

export function donationLabel(l: FoodListing, fssai?: string | null): DonationLabel {
  const items = l.items?.length
    ? l.items.map((it) => ({ name: it.dish, mark: it.diet, jain: it.jain, preparedAt: it.cookedAt, consumeBy: it.foodCheck?.safeUntil ?? null, storage: it.storage, allergens: it.contains, servings: it.servings }))
    : [{ name: l.dish, mark: l.diet, jain: l.jain, preparedAt: l.cookedAt, consumeBy: l.foodCheck?.safeUntil ?? l.assessment?.safeUntil ?? null, storage: l.storage, allergens: l.contains, servings: l.count * (l.entryMode === "shared_pack" ? l.feedsEach : 1) }];
  return {
    ref: `LUNA-${l.id.replace(/^lst_/, "").slice(0, 8).toUpperCase()}`,
    source: { name: l.donorName, address: l.pickup.address, area: l.pickup.area, fssai: fssai?.trim() || null },
    listedAt: l.createdAt,
    items,
  };
}
