/**
 * Listing sessions: a restaurant gives away several foods at once (spec §6.1–6.5). Each item has its own
 * photo, tags, amount, cooking time and storage; the listing-level fields (pickup, timing, containers,
 * contact, declaration) are shared. Servings are recomputed here from the portion table (§7.4), the food
 * check runs on every item, and the session's single-dish fields hold a summary for older code.
 */
import { TRIP_CONFIG as C } from "../trips/config.ts";
import { requestFoodCheck } from "./foodCheck.ts";
import { dishNameProblem, farFrom, servingsFor, type BulkUnit, type EntryMode } from "./portions.ts";
import { FOOD_CATEGORIES, type FoodCheck, type FoodListing, type ListingInput, type ListingItem } from "./types.ts";

const ALLERGENS = ["dairy", "nuts", "peanuts", "gluten", "egg", "soy", "sesame", "seafood", "onion_garlic"];
const MODES: EntryMode[] = ["per_person_pack", "shared_pack", "bulk"];
const UNITS: BulkUnit[] = ["kg", "g", "L", "ml", "pcs", "plates", "cups"];
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const DIET_RANK = { veg: 0, egg: 1, nonveg: 2 } as const;
const STORAGE_RISK = { fridge: 0, hot: 1, room: 2 } as const;
const SPICE = { mild: 0, medium: 1, hot: 2 } as const;
export const MAX_ITEMS = 10;

const isNum = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

export const MIN_SAFE_HOURS = 0.5, MAX_SAFE_HOURS = 72;
/**
 * The restaurant's "it stays good for about N hours (from now)": null when not given, undefined when invalid.
 * Kept as an absolute time; the food check may never promise longer (foodCheck.ts capByDonor).
 */
export function donorEstimate(hours: unknown, now: number): number | null | undefined {
  if (hours === undefined || hours === null || hours === "") return null;
  return isNum(hours, MIN_SAFE_HOURS, MAX_SAFE_HOURS) ? now + (hours as number) * 60 * 60_000 : undefined;
}

/** One item from the app, checked and with its servings worked out; or the reason it was refused. */
function parseItem(raw: unknown, i: number, now: number): ListingItem | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const at = `Food ${i + 1}`;
  if (typeof b.dish !== "string" || !b.dish.trim() || b.dish.length > 120) return `${at}: say what the food is.`;
  const named = dishNameProblem(b.dish);
  if (named) return `${at}: ${named.charAt(0).toLowerCase()}${named.slice(1)}`;
  if (!["veg", "egg", "nonveg"].includes(b.diet as string) || typeof b.jain !== "boolean" || !["yes", "no", "unsure"].includes(b.halal as string) || !["mild", "medium", "hot"].includes(b.spice as string)) return `${at}: choose its diet and spice.`;
  if (!Array.isArray(b.contains) || b.contains.length > ALLERGENS.length || !b.contains.every((a) => ALLERGENS.includes(a as string))) return `${at}: allergens aren't valid.`;
  if (b.jain && (b.diet !== "veg" || (b.contains as string[]).some((a) => ["egg", "seafood", "onion_garlic"].includes(a)))) return `${at}: Jain food can't contain egg, seafood, onion or garlic.`;
  if (b.category !== undefined && !FOOD_CATEGORIES.includes(b.category as never)) return `${at}: unknown kind of food.`;
  const q = (b.quantity ?? {}) as Record<string, unknown>;
  if (!MODES.includes(q.mode as EntryMode)) return `${at}: say how it's packed.`;
  if (q.mode === "per_person_pack" && !isNum(q.count, 1, 2000)) return `${at}: number of packs must be 1–2000.`;
  if (q.mode === "shared_pack" && (!isNum(q.count, 1, 500) || !isNum(q.feedsEach, 1, 50))) return `${at}: packs and how many each feeds are needed.`;
  if (q.mode === "bulk" && (!isNum(q.amount, 0.1, 500) || !UNITS.includes(q.unit as BulkUnit))) return `${at}: give the amount and unit.`;
  if (typeof b.photo !== "string" || !PHOTO.test(b.photo) || b.photo.length > C.maxPhotoBytes) return `${at}: add a photo of this food.`;
  if (!isNum(b.cookedAt, now - 72 * 60 * 60_000, now) || !["hot", "room", "fridge"].includes(b.storage as string)) return `${at}: when it was cooked and how it was kept.`;
  if (b.temperatureC !== undefined && b.temperatureC !== null && !isNum(b.temperatureC, -30, 120)) return `${at}: thermometer reading isn't valid.`;
  const donorSafeUntil = donorEstimate(b.safeForHours, now);
  if (donorSafeUntil === undefined) return `${at}: how long it stays good must be between ${MIN_SAFE_HOURS * 60} minutes and ${MAX_SAFE_HOURS} hours.`;
  const quantity = { mode: q.mode as EntryMode, count: q.count as number | undefined, feedsEach: q.feedsEach as number | undefined, amount: q.amount as number | undefined, unit: q.unit as BulkUnit | undefined };
  const rec = servingsFor(b.dish, b.category as string | undefined, quantity);
  // The donor confirms the recommendation or gives their own number (packs: their count is trusted).
  const donor = isNum(b.servings, 1, 5000) && Number.isInteger(b.servings) ? (b.servings as number) : rec.servings;
  if (donor < 1) return `${at}: that amount serves no one; check the quantity.`;
  return {
    id: `itm_${i + 1}`, dish: b.dish.trim(), category: b.category as ListingItem["category"], diet: b.diet as ListingItem["diet"], jain: b.jain as boolean,
    halal: b.halal as ListingItem["halal"], contains: b.contains as string[], spice: b.spice as ListingItem["spice"], quantity,
    servings: donor, recommended: rec.servings, role: rec.role, estimate: rec.estimate || donor !== rec.servings, donorOverride: farFrom(donor, rec.servings),
    dishId: rec.dishId, container: rec.container, litres: rec.litres,
    photo: b.photo, cookedAt: b.cookedAt as number, storage: b.storage as ListingItem["storage"], temperatureC: (b.temperatureC as number | null | undefined) ?? null,
    donorSafeUntil, foodCheck: null,
  };
}

/** The single-dish view of a session, for code that reads one dish (trips, older screens, the food check fallback). */
export function summaryOf(items: ListingItem[]): Pick<ListingInput, "dish" | "diet" | "jain" | "halal" | "contains" | "spice" | "entryMode" | "count" | "feedsEach" | "photo" | "cookedAt" | "storage" | "category" | "temperatureC" | "donorSafeUntil"> {
  const diet = items.reduce((d, i) => (DIET_RANK[i.diet] > DIET_RANK[d] ? i.diet : d), "veg" as ListingItem["diet"]);
  const nonveg = items.filter((i) => i.diet === "nonveg");
  return {
    dish: items.map((i) => i.dish).join(" + ").slice(0, 120),
    diet, jain: items.every((i) => i.jain),
    halal: nonveg.length && nonveg.every((i) => i.halal === "yes") ? "yes" : nonveg.some((i) => i.halal === "no") ? "no" : "unsure",
    contains: [...new Set(items.flatMap((i) => i.contains))],
    spice: items.reduce((s, i) => (SPICE[i.spice] > SPICE[s] ? i.spice : s), "mild" as ListingItem["spice"]),
    entryMode: "per_person_pack", count: items.reduce((n, i) => n + i.servings, 0), feedsEach: 1,
    photo: items[0].photo, cookedAt: Math.min(...items.map((i) => i.cookedAt)),
    storage: items.reduce((s, i) => (STORAGE_RISK[i.storage] > STORAGE_RISK[s] ? i.storage : s), "fridge" as ListingItem["storage"]),
    category: items[0].category, temperatureC: null,
    donorSafeUntil: items.some((i) => i.donorSafeUntil) ? Math.min(...items.flatMap((i) => (i.donorSafeUntil ? [i.donorSafeUntil] : []))) : null,
  };
}

/** `{ items: [...] , readyFrom, collectBy, containers, pickup, contactName, contactPhone, declarationAccepted }` → a listing input. */
export function parseSession(body: Record<string, unknown>, now: number): { input: ListingInput; items: ListingItem[] } | { error: string } {
  if (!Array.isArray(body.items) || !body.items.length) return { error: "Add at least one food." };
  if (body.items.length > MAX_ITEMS) return { error: `A session can have up to ${MAX_ITEMS} foods.` };
  const items: ListingItem[] = [];
  for (const [i, raw] of body.items.entries()) {
    const it = parseItem(raw, i, now);
    if (typeof it === "string") return { error: it };
    items.push(it);
  }
  const { items: _items, ...shared } = body;
  void _items;
  return { input: { ...(shared as unknown as ListingInput), ...summaryOf(items) }, items };
}

/** The food check, one item at a time (in parallel), as if each were its own listing. */
export async function checkItems(l: FoodListing): Promise<FoodCheck[]> {
  return Promise.all((l.items ?? []).map((it) => it.foodCheck ? Promise.resolve(it.foodCheck) : requestFoodCheck({
    ...l, dish: it.dish, category: it.category, diet: it.diet, jain: it.jain, halal: it.halal, contains: it.contains, spice: it.spice,
    entryMode: "per_person_pack", count: it.servings, feedsEach: 1, photo: it.photo, cookedAt: it.cookedAt, storage: it.storage, temperatureC: it.temperatureC,
    donorSafeUntil: it.donorSafeUntil ?? null,
  })));
}

const GRADE_RANK = { A: 0, B: 1, C: 2, D: 3 } as const;
const VERDICT_RANK = { ok: 0, unsure: 1, wrong: 2 } as const;

/**
 * Applies each item's check and the session's combined one. A Grade D item stays off people's plates
 * (§5 step 4); the rest still goes. The session's grade is its worst food for people, its safe-until
 * the earliest, and any tag problem on any item holds the whole session (the donor fixes or keeps tags).
 */
export function applySessionCheck(l: FoodListing, checks: FoodCheck[]) {
  const items = l.items!;
  items.forEach((it, i) => {
    it.foodCheck = { ...checks[i], tagChecks: (checks[i].tagChecks ?? []).map((t) => ({ ...t, itemId: it.id, itemName: it.dish })) };
  });
  const forPeople = items.filter((it) => it.foodCheck!.grade !== "D" && it.foodCheck!.safeUntil);
  const all = items.map((it) => it.foodCheck!);
  const people = forPeople.map((it) => it.foodCheck!);
  const worst = (people.length ? people : all).reduce((w, c) => (GRADE_RANK[c.grade] > GRADE_RANK[w.grade] ? c : w));
  const verdict = all.reduce((v, c) => (VERDICT_RANK[c.tagsVerdict ?? "ok"] > VERDICT_RANK[v] ? c.tagsVerdict ?? "ok" : v), "ok" as NonNullable<FoodCheck["tagsVerdict"]>);
  const combined: FoodCheck = {
    status: "done", at: Math.max(...all.map((c) => c.at)), source: all.some((c) => c.source === "food_agent") ? "food_agent" : "rules_only",
    grade: people.length ? worst.grade : "D", unsure: people.some((c) => c.unsure), photoChecked: all.every((c) => c.photoChecked),
    score: people.length && people.every((c) => c.score !== null) ? Math.min(...people.map((c) => c.score as number)) : null,
    condition: worst.condition, safeUntil: people.length ? Math.min(...people.map((c) => c.safeUntil as number)) : null,
    message: items.length > 1 ? `${forPeople.length} of ${items.length} foods can go to people.` : worst.message,
    reasons: items.flatMap((it) => (it.foodCheck!.grade === "D" ? [`${it.dish}: ${it.foodCheck!.reasons[0] ?? it.foodCheck!.message}`] : [])),
    seen: items.map((it) => it.foodCheck!.seen).filter(Boolean).join(" · "),
    models: worst.models, reasoning: items.length === 1 ? worst.reasoning : null,
    tagChecks: items.flatMap((it) => it.foodCheck!.tagChecks ?? []), tagsVerdict: verdict,
  };
  l.foodCheck = combined;
  if (!forPeople.length || !combined.safeUntil) {
    l.assessment = null;
    l.state = "not_for_people";
    return;
  }
  const servings = forPeople.reduce((n, it) => n + it.servings, 0);
  l.assessment = { grade: combined.grade as "A" | "B" | "C", safeUntil: combined.safeUntil, servings, unsure: combined.unsure, source: combined.source };
  if (verdict !== "ok" && (l.state === "in_review" || l.state === "checking")) {
    l.heldFrom = l.state;
    l.state = "tags_held";
  }
}
