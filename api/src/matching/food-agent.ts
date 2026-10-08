/**
 * Food Agent (stand-in). The real one (Feature 2) reads photos, cooked time and
 * storage, scores the food and writes the Food Passport. Until it is connected,
 * the passport arrives with the listing, and this module only does what the
 * other agents need from it: the effective grade, the "unsure" flag and the
 * amounts to keep ready for each share.
 */
import { itemName } from "./engine/reasons.ts";
import { containersFor } from "../listings/portions.ts";
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
  const meals = mealsNote(l);
  if (meals) notes.push({ itemId: "meals", reason: meals });
  return notes;
}

const dietWord = { jain: "Jain", veg: "veg", egg: "egg", nonveg: "non-veg", unknown: "diet not stated" } as const;

/** Spec §7.5 in plain words: which staples and sides became meals, and what rides along as an add-on. */
export function mealsNote(l: Listing): string | null {
  const bundles = l.items.filter((i) => i.bundle);
  const addons = l.items.filter((i) => i.tags?.includes("addon"));
  if (!bundles.length && !addons.length) return null;
  const made = bundles.map((b) => `${b.servings} × ${itemName(b).toLowerCase()} (${dietWord[b.diet]})`).join(", ");
  const meals = bundles.reduce((n, b) => n + b.servings, 0);
  const left = addons.map((a) => `${a.servings} servings of ${itemName(a).toLowerCase()}`).join(" and ");
  return [
    bundles.length ? `Paired staples with sides into ${meals} meal${meals === 1 ? "" : "s"}: ${made}.` : "No staple here has a side to make a meal with.",
    addons.length ? `${left.charAt(0).toUpperCase()}${left.slice(1)} ride${addons.length === 1 ? "s" : ""} along as an add-on, not counted as meals.` : "",
  ].filter(Boolean).join(" ");
}

const tidy = (n: number) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/** The share of an item, in the restaurant's own units: "6 kg veg biryani". */
function portion(item: Item, servings: number) {
  if (!item.quantity) return `${servings} servings of ${itemName(item)}`;
  const amount = (item.quantity.amount * servings) / item.servings;
  return `${tidy(amount)} ${item.quantity.unit} ${itemName(item)}`;
}

/**
 * The food a share physically is: a meal bundle is its staple and its side (one serving of each per meal), and
 * the same rice in two bundles and as an add-on is packed as one amount. Items come from the restaurant's own
 * entries, so amounts stay in its units.
 */
function physical(l: Listing, lines: OfferLine[]) {
  const entry = (id: string) => l.parts?.find((i) => i.id === id) ?? l.items.find((i) => i.id === id)!;
  const total = new Map<string, number>();
  for (const ln of lines) {
    const item = l.items.find((i) => i.id === ln.itemId)!;
    const ids = item.bundle ? [item.bundle.staple, item.bundle.side] : [item.id];
    for (const id of ids) total.set(id, (total.get(id) ?? 0) + ln.servings);
  }
  return [...total].map(([id, servings]) => ({ item: entry(id), servings }));
}

/** What the restaurant should keep ready for this share: "6 kg biryani + 4 L payasam". */
export function keepReady(l: Listing, lines: OfferLine[]) {
  return physical(l, lines).map((p) => portion(p.item, p.servings)).join(" + ");
}

/** What goes into one share, item by item, in the restaurant's units: for the packing note and the screens. */
export function packingLines(l: Listing, lines: OfferLine[]) {
  return physical(l, lines).map(({ item, servings }) => {
    const amount = item.quantity ? `${tidy((item.quantity.amount * servings) / item.servings)} ${item.quantity.unit}` : null;
    return { itemId: item.id, name: itemName(item), servings, amount };
  });
}

/** Containers for this share alone (spec §9.5): boxes and cans when the partner brings them, else carry bags. */
export function shareContainers(l: Listing, lines: OfferLine[]): string[] {
  const parts = physical(l, lines).map(({ item, servings }) => ({
    servings,
    litres: item.litresPerServing != null ? item.litresPerServing * servings : null,
    container: item.container ?? "box",
  }));
  return containersFor(parts, !!l.partnerBrings);
}
