import type { ListingInput, ListingView } from "@/lib/luna/listing";
import { findDish, servingsFor, unitsFor, type BulkUnit, type EntryMode } from "@/lib/luna/portions";

/** One food being listed in this session, as the form holds it. */
export interface DraftItem {
  key: string;
  photo: string;
  dish: string;
  category: NonNullable<ListingInput["category"]>;
  diet: ListingInput["diet"];
  jain: boolean;
  halal: ListingInput["halal"];
  spice: ListingInput["spice"];
  contains: string[];
  mode: EntryMode;
  count: number;
  feeds: number;
  amount: number;
  unit: BulkUnit;
  /** null = take the recommendation; a number = the donor's own count. */
  servings: number | null;
  cookedAt: number;
  storage: ListingInput["storage"];
  temp: string;
}

/** The unit shown for this food: the donor's pick when it fits the dish (litres for payasam), else the dish's first unit. */
export function unitOf(d: Pick<DraftItem, "dish" | "category" | "unit">): BulkUnit {
  const units = unitsFor(findDish(d.dish, d.category));
  return units.includes(d.unit) ? d.unit : units[0];
}

export const quantityOf = (d: Pick<DraftItem, "dish" | "category" | "mode" | "count" | "feeds" | "amount" | "unit">) =>
  d.mode === "bulk" ? { mode: d.mode, amount: d.amount, unit: unitOf(d) } : d.mode === "shared_pack" ? { mode: d.mode, count: d.count, feedsEach: d.feeds } : { mode: d.mode, count: d.count };

/** What the portion table recommends for this food, and the servings it will be listed with. */
export function servingsOfDraft(d: DraftItem) {
  const rec = servingsFor(d.dish, d.category, quantityOf(d));
  return { rec, servings: d.servings ?? rec.servings };
}

/** The item as the API takes it. */
export function itemBody(d: DraftItem) {
  return { dish: d.dish.trim(), category: d.category, diet: d.diet, jain: d.diet === "veg" && d.jain, halal: d.halal, spice: d.spice, contains: d.contains,
    quantity: quantityOf(d), servings: servingsOfDraft(d).servings, photo: d.photo, cookedAt: d.cookedAt, storage: d.storage,
    temperatureC: d.temp.trim() === "" ? null : Number(d.temp) };
}

/** A held session's foods, with the photo check's tag fixes applied per food, for relisting. */
export function draftsFromListing(l: ListingView): DraftItem[] {
  const checks = l.foodCheck?.tagChecks ?? [];
  const items = l.items ?? [{ id: "itm_1", dish: l.dish, category: l.category, diet: l.diet, jain: l.jain, halal: l.halal, spice: l.spice, contains: l.contains,
    quantity: l.entryMode === "shared_pack" ? { mode: "shared_pack" as const, count: l.count, feedsEach: l.feedsEach } : { mode: "per_person_pack" as const, count: l.count },
    servings: l.count * (l.entryMode === "shared_pack" ? l.feedsEach : 1), photo: l.photo, cookedAt: l.cookedAt, storage: l.storage, temperatureC: l.temperatureC ?? null }];
  return items.map((it, i) => {
    const mine = checks.filter((c) => !c.itemId || c.itemId === it.id);
    const pick = (tag: string) => mine.find((c) => c.tag === tag)?.suggest;
    const diet = (pick("diet") as ListingInput["diet"] | undefined) ?? it.diet;
    const contains = [...new Set([...it.contains, ...mine.filter((c) => c.tag.startsWith("contains:") && c.suggest === "add").map((c) => c.tag.slice(9))])];
    const jain = it.jain && !pick("jain") && diet === "veg" && !contains.some((a) => ["egg", "seafood", "onion_garlic"].includes(a));
    const dish = diet !== "veg" ? it.dish.replace(/^\s*(pure\s+)?veg(etable|etarian)?\s+/i, "").replace(/^./, (c) => c.toUpperCase()) : it.dish;
    const q = it.quantity as { mode: EntryMode; count?: number; feedsEach?: number; amount?: number; unit?: BulkUnit };
    return {
      key: `r${i}`, photo: it.photo, dish: dish || it.dish, category: (pick("category") as DraftItem["category"] | undefined) ?? it.category ?? "cooked_meal",
      diet, jain, halal: it.halal, spice: (pick("spice") as ListingInput["spice"] | undefined) ?? it.spice, contains,
      mode: q.mode, count: q.count ?? 10, feeds: q.feedsEach ?? 4, amount: q.amount ?? 5, unit: q.unit ?? "kg",
      servings: "servings" in it ? (it.servings as number) : null, cookedAt: it.cookedAt, storage: it.storage, temp: it.temperatureC != null ? String(it.temperatureC) : "",
    };
  });
}
