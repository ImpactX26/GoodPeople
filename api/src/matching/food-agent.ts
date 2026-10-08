/**
 * Food Agent (stand-in). The real one (Feature 2) reads photos, cooked time and
 * storage, scores the food and writes the Food Passport. Until it is connected,
 * the passport arrives with the listing, and this module only does what the
 * other agents need from it: the effective grade, the "unsure" flag and the
 * amounts to keep ready for each share.
 */
import { itemName } from "./engine/reasons.ts";
import { effectiveGrade, isUnsure } from "./engine/safety.ts";
import { fmtMinutes } from "./time.ts";
import type { Item, Listing, OfferLine } from "./types.ts";

/** Plain-language notes about the passport, for the decision log. */
export function reviewPassport(l: Listing): { itemId: string; reason: string }[] {
  const notes: { itemId: string; reason: string }[] = [];
  for (const item of l.items) {
    const g = effectiveGrade(item);
    if (g !== item.grade)
      notes.push({ itemId: item.id, reason: `${itemName(item)} came in as Grade ${item.grade} but is only safe for ${fmtMinutes(item.safeTime * 60_000)}, so it is treated as Grade ${g}.` });
    if (isUnsure(item))
      notes.push({ itemId: item.id, reason: `The food checker is only ${item.confidence}% sure about ${itemName(item)}; the partner will check it at pickup.` });
  }
  return notes;
}

const tidy = (n: number) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/** The share of an item, in the restaurant's own units: "6 kg veg biryani". */
function portion(item: Item, servings: number) {
  if (!item.quantity) return `${servings} servings of ${itemName(item)}`;
  const amount = (item.quantity.amount * servings) / item.servings;
  return `${tidy(amount)} ${item.quantity.unit} ${itemName(item)}`;
}

/** What the restaurant should keep ready for this share: "6 kg biryani + 4 L payasam". */
export function keepReady(l: Listing, lines: OfferLine[]) {
  return lines.map((ln) => portion(l.items.find((i) => i.id === ln.itemId)!, ln.servings)).join(" + ");
}
