/**
 * Meal assembly (spec §7.5). A staple (rice, chapati) and a side (dal, curry) only make a meal together, so
 * the NGO Agent is never handed "50 portions of rice" as if it were 50 meals. Meal items stay as they are;
 * staples and sides are paired into bundles, one serving of each per meal; whatever is left rides along as an
 * add-on, like an extra. A bundle carries the strictest view of its parts: the stricter diet, every allergen,
 * the worse grade and the shorter safe time, so every safety rule downstream still holds for it.
 *
 * The rules pick the pairing order: same diet first, then a veg staple with an egg or non-veg side; within
 * that, how well the two go together (the fit table below), then the bigger pair first. The Food Agent's
 * reasoning may reorder the pairs or leave some out; it never sets a number.
 */
import { findDish } from "../../listings/portions.ts";
import type { Diet, Grade, Item } from "../types.ts";

export type Pairing = [stapleId: string, sideId: string];

export interface Bundle {
  id: string;
  staple: string;
  side: string;
  servings: number;
}

export interface MealPlan {
  /** What the agents allocate: meals, bundles, add-ons and extras. */
  items: Item[];
  /** The staples and sides as the restaurant gave them, for packing amounts; never offered on their own. */
  parts: Item[];
  bundles: Bundle[];
  meals: number;
  addons: number;
  extras: number;
}

const ROLES = ["meal", "staple", "side", "extra"] as const;
type Role = (typeof ROLES)[number];
export const roleOf = (i: Item): Role => (i.tags ?? []).find((t): t is Role => (ROLES as readonly string[]).includes(t)) ?? "meal";

/** From most to least permissive: a bundle takes the later of its parts' diets. */
const DIET_RANK: Record<Diet, number> = { jain: 0, veg: 1, egg: 2, nonveg: 3, unknown: 4 };
const stricter = (a: Diet, b: Diet) => (DIET_RANK[a] >= DIET_RANK[b] ? a : b);
const worse = (a: Grade, b: Grade): Grade => (a >= b ? a : b);
const plantBased = (d: Diet) => d === "veg" || d === "jain";

/** 0 same diet, 1 a veg staple with an egg or non-veg side, 2 anything else. */
function dietOrder(s: Item, d: Item) {
  if (s.diet === d.diet || (plantBased(s.diet) && plantBased(d.diet))) return 0;
  return plantBased(s.diet) ? 1 : 2;
}

const THIN = new Set(["rasam", "sambar"]);

/** How well a staple and a side go together as a meal: 2 good, 1 fine or unknown, 0 poor (chapati with rasam). */
export function fit(staple: Item, side: Item) {
  const s = findDish(staple.name ?? ""), d = findDish(side.name ?? "");
  if (!s.dish || !d.dish) return 1;
  if (s.category === "bread") return THIN.has(d.dish.id) ? 0 : 2;
  if (s.category === "plain_rice") return d.category === "curry_gravy" ? 2 : 1;
  return 1;
}

/** Every staple × side pair, in the rules' order of preference. */
export function rulePairs(items: Item[]): Pairing[] {
  const staples = items.filter((i) => roleOf(i) === "staple");
  const sides = items.filter((i) => roleOf(i) === "side");
  return staples
    .flatMap((s) => sides.map((d) => ({ p: [s.id, d.id] as Pairing, order: dietOrder(s, d), fit: fit(s, d), size: Math.min(s.servings, d.servings) })))
    .sort((a, b) => a.order - b.order || b.fit - a.fit || b.size - a.size)
    .map((x) => x.p);
}

const name = (i: Item) => (i.name ?? "food").trim();
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function bundleOf(id: string, s: Item, d: Item, servings: number): Item {
  const diet = stricter(s.diet, d.diet);
  const needsHalal = [s, d].filter((x) => x.diet === "nonveg" || x.diet === "unknown");
  const allergens = [...new Set([...(s.allergens ?? []), ...(d.allergens ?? [])])];
  return {
    id,
    name: `${name(s)} with ${lower(name(d))}`,
    servings,
    category: "meal",
    grade: worse(s.grade, d.grade),
    confidence: Math.min(s.confidence, d.confidence),
    safeTime: Math.min(s.safeTime, d.safeTime),
    diet,
    halal: needsHalal.length ? needsHalal.every((x) => x.halal) || undefined : undefined,
    allergens: allergens.length ? allergens : undefined,
    tags: ["meal", "bundle", ...(s.tags?.includes("jain") && d.tags?.includes("jain") ? ["jain"] : [])],
    bundle: { staple: s.id, side: d.id },
  };
}

/** What's left of a staple or side once paired: an add-on with its amount scaled to match. */
function addonOf(i: Item, servings: number): Item {
  const share = servings / i.servings;
  return {
    ...i,
    servings,
    quantity: i.quantity ? { ...i.quantity, amount: Math.round(i.quantity.amount * share * 100) / 100 } : undefined,
    tags: [...(i.tags ?? []), "addon"],
  };
}

/**
 * Pairs staples with sides in `order`, leaving out `skip`. Pairs that name anything but a staple and a side
 * of this listing are ignored, so a bad suggestion can only cost meals, never invent them.
 */
export function assembleMeals(items: Item[], order: Pairing[] = rulePairs(items), skip: Pairing[] = []): MealPlan {
  const byId = new Map(items.map((i) => [i.id, i]));
  const isPair = ([s, d]: Pairing) => byId.has(s) && byId.has(d) && roleOf(byId.get(s)!) === "staple" && roleOf(byId.get(d)!) === "side";
  const skipped = new Set(skip.map((p) => p.join("|")));
  const parts = items.filter((i) => roleOf(i) === "staple" || roleOf(i) === "side");
  const left = new Map(parts.map((i) => [i.id, i.servings]));
  const bundles: Bundle[] = [];
  const bundleItems: Item[] = [];
  const seen = new Set<string>();
  for (const p of order) {
    const key = p.join("|");
    if (seen.has(key) || skipped.has(key) || !isPair(p)) continue;
    seen.add(key);
    const [s, d] = p;
    const n = Math.min(left.get(s)!, left.get(d)!);
    if (n <= 0) continue;
    left.set(s, left.get(s)! - n);
    left.set(d, left.get(d)! - n);
    const id = `b${bundles.length + 1}`;
    bundles.push({ id, staple: s, side: d, servings: n });
    bundleItems.push(bundleOf(id, byId.get(s)!, byId.get(d)!, n));
  }
  const addons = parts.filter((i) => left.get(i.id)! > 0).map((i) => addonOf(i, left.get(i.id)!));
  const meals = items.filter((i) => roleOf(i) === "meal");
  const extras = items.filter((i) => roleOf(i) === "extra");
  const count = (xs: Item[]) => xs.reduce((n, i) => n + i.servings, 0);
  return {
    items: [...meals, ...bundleItems, ...addons, ...extras],
    parts,
    bundles,
    meals: count(meals) + count(bundleItems),
    addons: count(addons),
    extras: count(extras),
  };
}

/** Worth asking the Food Agent's reasoning: a real choice of pairs, a dish the table doesn't know, or a poor fit. */
export function pairingIsAChoice(items: Item[]) {
  const staples = items.filter((i) => roleOf(i) === "staple");
  const sides = items.filter((i) => roleOf(i) === "side");
  if (!staples.length || !sides.length) return false;
  if (staples.length > 1 || sides.length > 1) return true;
  return [...staples, ...sides].some((i) => !findDish(i.name ?? "").dish) || fit(staples[0], sides[0]) === 0;
}
