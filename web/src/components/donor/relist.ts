import type { ListingInput, ListingView } from "@/lib/luna/listing";
import type { TagCheck } from "../../../../api/src/listings/types";
import { keepDraftPhoto } from "./PhotoCanvas";

/** A held listing's details, carried into the List food form so the donor only fixes the label. */
export interface Relist {
  from: string;
  dish: string;
  category: NonNullable<ListingInput["category"]>;
  diet: ListingInput["diet"];
  jain: boolean;
  halal: ListingInput["halal"];
  spice: ListingInput["spice"];
  contains: string[];
  entryMode: ListingInput["entryMode"];
  count: number;
  feedsEach: number;
  cookedAt: number;
  storage: ListingInput["storage"];
  temperatureC: number | null;
  containers: ListingInput["containers"];
}

const KEY = "luna.relist";
export const DIET_WORD = { veg: "Veg", egg: "Veg with egg", nonveg: "Non-veg" } as const;

const CATEGORY_WORD: Record<string, string> = { cooked_meal: "Cooked meal", bakery: "Bakery", dairy: "Dairy & sweets", packaged: "Packaged", beverages: "Drinks", raw_produce: "Raw produce" };
const allergenWord = (a: string) => a === "onion_garlic" ? "onion or garlic" : a;

/** Plain words for one tag the photo disagrees with: what's wrong, what was seen, and the fix. */
export function tagLine(c: TagCheck, l: Pick<ListingView, "diet" | "spice" | "jain">) {
  const sure = c.certainty === "sure";
  const seen = c.seen.trim().replace(/\.$/, "");
  if (c.tag.startsWith("contains:")) {
    const a = allergenWord(c.tag.slice(9));
    return { title: `${sure ? "Contains" : "Might contain"} ${a}`, seen, fix: `Add ${a} to “Contains”${l.jain && ["onion or garlic", "egg", "seafood"].includes(a) ? " and untick Jain" : ""}` };
  }
  switch (c.tag) {
    case "diet": return { title: `${sure ? "Not" : "Might not be"} ${DIET_WORD[l.diet].toLowerCase()}`, seen, fix: `Change diet to ${DIET_WORD[c.suggest as ListingInput["diet"]] ?? c.suggest}` };
    case "jain": return { title: `${sure ? "Not" : "Might not be"} Jain friendly`, seen, fix: "Untick Jain friendly" };
    case "spice": return { title: `Might be ${c.suggest}, not ${l.spice}`, seen, fix: `Set spice to ${c.suggest}` };
    case "category": return { title: `Might be ${CATEGORY_WORD[c.suggest]?.toLowerCase() ?? c.suggest}`, seen, fix: `Change kind to ${CATEGORY_WORD[c.suggest] ?? c.suggest}` };
    default: return { title: c.tag, seen, fix: "" };
  }
}

/** Saves the listing with every fix the photo check suggested, so the donor only reviews and sends. */
export function keepRelist(l: ListingView) {
  const checks = l.foodCheck?.tagChecks ?? [];
  const pick = (tag: string) => checks.find(c => c.tag === tag)?.suggest;
  const diet = (pick("diet") as ListingInput["diet"] | undefined) ?? l.diet;
  const contains = [...new Set([...l.contains, ...checks.filter(c => c.tag.startsWith("contains:") && c.suggest === "add").map(c => c.tag.slice(9))])];
  const jain = l.jain && !pick("jain") && diet === "veg" && !contains.some(a => ["egg", "seafood", "onion_garlic"].includes(a));
  const dish = diet !== "veg" ? l.dish.replace(/^\s*(pure\s+)?veg(etable|etarian)?\s+/i, "").replace(/^./, c => c.toUpperCase()) : l.dish;
  const r: Relist = { from: l.id, dish: dish || l.dish, category: (pick("category") as Relist["category"] | undefined) ?? l.category ?? "cooked_meal", diet, jain,
    halal: l.halal, spice: (pick("spice") as ListingInput["spice"] | undefined) ?? l.spice, contains, entryMode: l.entryMode, count: l.count, feedsEach: l.feedsEach,
    cookedAt: l.cookedAt, storage: l.storage, temperatureC: l.temperatureC ?? null, containers: l.containers };
  try { sessionStorage.setItem(KEY, JSON.stringify(r)); } catch { /* private mode: the form starts empty */ }
  keepDraftPhoto(l.photo);
}
export function peekRelist(): Relist | null {
  try { const raw = sessionStorage.getItem(KEY); return raw ? JSON.parse(raw) as Relist : null; } catch { return null; }
}
export function clearRelist() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
