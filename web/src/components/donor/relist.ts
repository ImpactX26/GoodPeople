import type { ListingInput, ListingView } from "@/lib/luna/listing";
import type { TagCheck } from "../../../../api/src/listings/types";
import { draftsFromListing, type DraftItem } from "./draft";

/** A held listing's session, carried into the List food form with the photo check's fixes applied. */
export interface Relist {
  from: string;
  items: DraftItem[];
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
  const on = c.itemName ? `${c.itemName}: ` : "";
  if (c.tag.startsWith("contains:")) {
    const a = allergenWord(c.tag.slice(9));
    return { title: `${on}${sure ? "Contains" : "Might contain"} ${a}`, seen, fix: `Add ${a} to “Contains”${l.jain && ["onion or garlic", "egg", "seafood"].includes(a) ? " and untick Jain" : ""}` };
  }
  switch (c.tag) {
    case "diet": return { title: `${on}${sure ? "Not" : "Might not be"} ${c.itemName ? "the diet you tagged" : DIET_WORD[l.diet].toLowerCase()}`, seen, fix: `Change diet to ${DIET_WORD[c.suggest as ListingInput["diet"]] ?? c.suggest}` };
    case "jain": return { title: `${on}${sure ? "Not" : "Might not be"} Jain friendly`, seen, fix: "Untick Jain friendly" };
    case "spice": return { title: `${on}Might be ${c.suggest}`, seen, fix: `Set spice to ${c.suggest}` };
    case "category": return { title: `${on}Might be ${CATEGORY_WORD[c.suggest]?.toLowerCase() ?? c.suggest}`, seen, fix: `Change kind to ${CATEGORY_WORD[c.suggest] ?? c.suggest}` };
    default: return { title: `${on}${c.tag}`, seen, fix: "" };
  }
}

export function keepRelist(l: ListingView) {
  const r: Relist = { from: l.id, items: draftsFromListing(l), containers: l.containers };
  try { sessionStorage.setItem(KEY, JSON.stringify(r)); } catch { /* private mode: the form starts empty */ }
}
export function peekRelist(): Relist | null {
  try { const raw = sessionStorage.getItem(KEY); const r = raw ? JSON.parse(raw) as Relist : null; return r && Array.isArray(r.items) ? r : null; } catch { return null; }
}
export function clearRelist() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
