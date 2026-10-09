/**
 * Servings (spec §7). Everything is measured in servings: one adult, one filling meal. Packs are trusted
 * (per-person: count; shared: count × feeds each); bulk goes through the portion table (Appendix A),
 * matching the dish by name, alias or a near spelling, else by category (§7.6). Always round down.
 * Pure and shared: the app imports it for the live "can serve about N people" recommendation and the
 * API recomputes it to check the donor's number (§7.8).
 */

export type Role = "meal" | "staple" | "side" | "extra";
export type BaseUnit = "g" | "ml" | "pcs";
export type ContainerHint = "box" | "leakproof" | "tray" | "bag";
export type BulkUnit = "kg" | "g" | "L" | "ml" | "pcs" | "plates" | "cups";

export interface Dish {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  role: Role;
  base: BaseUnit;
  perPerson: number;
  /** g per ml, to convert kg ↔ L. */
  density?: number;
  container: ContainerHint;
  /** Typical tags, only used to pre-tick suggestions. */
  diet?: "veg" | "egg" | "nonveg";
  contains?: string[];
}

const D = (id: string, name: string, aliases: string, category: string, role: Role, perPerson: number, base: BaseUnit, density: number | undefined, container: ContainerHint, diet?: Dish["diet"], contains = ""): Dish =>
  ({ id, name, aliases: aliases ? aliases.split(",").map((a) => a.trim()) : [], category, role, base, perPerson, density, container, diet, contains: contains ? contains.split(",").map((c) => c.trim()) : [] });

/** Appendix A seed. */
export const DISHES: Dish[] = [
  D("veg_biryani", "Veg biryani", "veg dum biryani, vegetable biryani, veg biriyani, biriyani, biryani", "rice_dish", "meal", 600, "g", 0.8, "box", "veg", "dairy, onion_garlic"),
  D("chicken_biryani", "Chicken biryani", "chicken dum biryani, chicken biriyani", "rice_dish", "meal", 600, "g", 0.8, "box", "nonveg", "dairy, onion_garlic"),
  D("mutton_biryani", "Mutton biryani", "mutton biriyani", "rice_dish", "meal", 600, "g", 0.8, "box", "nonveg", "dairy, onion_garlic"),
  D("egg_biryani", "Egg biryani", "anda biryani", "rice_dish", "meal", 600, "g", 0.8, "box", "egg", "egg, dairy, onion_garlic"),
  D("veg_pulao", "Veg pulao", "pulav, pilaf, veg pulav, pulao", "rice_dish", "meal", 500, "g", 0.8, "box", "veg", "onion_garlic"),
  D("bisi_bele_bath", "Bisi bele bath", "bisibelebath, bisi bele bhath, bbb", "rice_dish", "meal", 500, "g", 0.9, "box", "veg", "dairy"),
  D("lemon_rice", "Lemon rice", "chitranna, chitrannam, nimbu chawal", "rice_dish", "meal", 400, "g", 0.75, "box", "veg", "peanuts"),
  D("tomato_bath", "Tomato bath", "tomato rice", "rice_dish", "meal", 400, "g", 0.8, "box", "veg", "onion_garlic"),
  D("curd_rice", "Curd rice", "mosaru anna, thayir sadam, dahi chawal", "rice_dish", "meal", 400, "g", 1.0, "box", "veg", "dairy"),
  D("khichdi", "Khichdi", "kichdi, khichri", "rice_dish", "meal", 450, "g", 1.0, "box", "veg", "dairy"),
  D("ven_pongal", "Ven pongal", "khara pongal, pongal", "rice_dish", "meal", 400, "g", 1.0, "box", "veg", "dairy, nuts"),
  D("veg_fried_rice", "Veg fried rice", "fried rice", "rice_dish", "meal", 450, "g", 0.75, "box", "veg", "soy, onion_garlic"),
  D("egg_fried_rice", "Egg fried rice", "", "rice_dish", "meal", 450, "g", 0.75, "box", "egg", "egg, soy, onion_garlic"),
  D("veg_noodles", "Veg noodles", "hakka noodles, chowmein, noodles", "noodles_pasta", "meal", 350, "g", 0.8, "box", "veg", "gluten, soy, onion_garlic"),
  D("idli", "Idli", "idly", "tiffin", "meal", 4, "pcs", undefined, "box", "veg"),
  D("dosa", "Dosa", "dose, masala dosa, plain dosa", "tiffin", "meal", 2, "pcs", undefined, "box", "veg"),
  D("upma", "Upma", "uppittu, khara bath", "tiffin", "meal", 300, "g", 0.9, "box", "veg", "gluten"),
  D("poha", "Poha", "avalakki, aval", "tiffin", "meal", 300, "g", 0.6, "box", "veg", "peanuts"),
  D("meal_box", "Meal box / thali", "thali, meals, parcel meal, combo meal, meal box", "meal", "meal", 1, "pcs", undefined, "bag"),
  D("sandwich", "Sandwich", "", "tiffin", "meal", 2, "pcs", undefined, "box", "veg", "gluten, dairy"),
  D("plain_rice", "Plain rice", "steamed rice, white rice, anna, sadam, rice", "plain_rice", "staple", 300, "g", 0.75, "box", "veg"),
  D("jeera_rice", "Jeera rice", "", "plain_rice", "staple", 300, "g", 0.75, "box", "veg", "dairy"),
  D("chapati", "Chapati", "chapathi, roti, phulka", "bread", "staple", 3, "pcs", undefined, "bag", "veg", "gluten"),
  D("puri", "Puri", "poori", "bread", "staple", 4, "pcs", undefined, "bag", "veg", "gluten"),
  D("parotta", "Parotta", "porotta, paratha, lachha paratha", "bread", "staple", 2, "pcs", undefined, "bag", "veg", "gluten, dairy"),
  D("naan", "Naan", "butter naan, kulcha", "bread", "staple", 2, "pcs", undefined, "bag", "veg", "gluten, dairy"),
  D("bread_sliced", "Bread (sliced)", "pav, bread loaf, bread", "bread", "staple", 4, "pcs", undefined, "bag", "veg", "gluten"),
  D("dal", "Dal", "dal fry, dal tadka, paruppu, togari bele saaru", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "veg"),
  D("sambar", "Sambar", "huli, sambhar", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "veg"),
  D("rasam", "Rasam", "saaru", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "veg"),
  D("veg_kurma", "Veg kurma", "korma, sagu, veg korma", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "veg", "dairy, nuts"),
  D("paneer_curry", "Paneer curry", "paneer butter masala, kadai paneer, palak paneer", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "veg", "dairy"),
  D("chole", "Chole", "chana masala, chole masala", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "veg", "onion_garlic"),
  D("rajma", "Rajma", "rajma masala", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "veg", "onion_garlic"),
  D("chicken_curry", "Chicken curry", "chicken gravy, chicken masala", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "nonveg", "onion_garlic"),
  D("egg_curry", "Egg curry", "anda curry", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "egg", "egg, onion_garlic"),
  D("fish_curry", "Fish curry", "meen curry", "curry_gravy", "side", 150, "ml", 1.0, "leakproof", "nonveg", "seafood"),
  D("veg_palya", "Vegetable palya", "sabzi, sabji, poriyal, thoran, dry veg", "dry_veg", "side", 120, "g", 0.7, "box", "veg"),
  D("coconut_chutney", "Coconut chutney", "chutney, kayi chutney", "accompaniment", "extra", 60, "ml", 1.0, "leakproof", "veg"),
  D("raita", "Raita", "mosaru bajji, pachadi", "accompaniment", "extra", 100, "ml", 1.0, "leakproof", "veg", "dairy"),
  D("payasam", "Payasam", "kheer, payasa, semiya payasam, paal payasam", "sweet_milk", "extra", 120, "ml", 1.0, "leakproof", "veg", "dairy, nuts"),
  D("kesari_bath", "Kesari bath", "sheera, rava kesari", "sweet_dry", "extra", 100, "g", 0.9, "box", "veg", "dairy, nuts, gluten"),
  D("gulab_jamun", "Gulab jamun", "jamun", "sweet_dry", "extra", 2, "pcs", undefined, "tray", "veg", "dairy, gluten"),
  D("laddoo", "Laddoo", "ladoo, laddu, boondi laddu", "sweet_dry", "extra", 1, "pcs", undefined, "tray", "veg", "dairy, nuts"),
  D("mysore_pak", "Mysore pak", "", "sweet_dry", "extra", 1, "pcs", undefined, "tray", "veg", "dairy"),
  D("holige", "Holige", "obbattu, puran poli", "sweet_dry", "extra", 1, "pcs", undefined, "tray", "veg", "gluten, dairy"),
  D("samosa", "Samosa", "", "snack_fried", "extra", 2, "pcs", undefined, "tray", "veg", "gluten"),
  D("vada", "Vada", "medu vada, uddina vade", "snack_fried", "extra", 2, "pcs", undefined, "tray", "veg"),
  D("bajji_bonda", "Bajji / bonda", "pakoda, pakora, bajji, bonda", "snack_fried", "extra", 3, "pcs", undefined, "tray", "veg"),
  D("cake", "Cake", "pastry", "bakery", "extra", 80, "g", undefined, "box", "egg", "egg, dairy, gluten"),
  D("buns", "Buns", "sweet bun, dilpasand", "bakery", "extra", 2, "pcs", undefined, "bag", "veg", "gluten, dairy"),
  D("fruit_whole", "Fruit (whole)", "banana, apple, orange", "fruit", "extra", 1, "pcs", undefined, "bag", "veg"),
  D("fruit_cut", "Cut fruit", "fruit salad, fruit bowl", "fruit", "extra", 150, "g", 0.8, "box", "veg"),
  D("buttermilk", "Buttermilk", "majjige, chaas, mor", "drink", "extra", 200, "ml", 1.0, "leakproof", "veg", "dairy"),
  D("juice", "Juice", "", "drink", "extra", 200, "ml", 1.0, "leakproof", "veg"),
];

/** §7.6 step 2: category fallbacks when the dish isn't in the table. */
export const CATEGORY_DEFAULTS: Record<string, { label: string; role: Role; perPerson: number; base: BaseUnit; container: ContainerHint }> = {
  rice_dish: { label: "rice dish", role: "meal", perPerson: 500, base: "g", container: "box" },
  plain_rice: { label: "plain rice", role: "staple", perPerson: 300, base: "g", container: "box" },
  bread: { label: "bread", role: "staple", perPerson: 3, base: "pcs", container: "bag" },
  curry_gravy: { label: "curry or gravy", role: "side", perPerson: 150, base: "ml", container: "leakproof" },
  dry_veg: { label: "dry vegetable", role: "side", perPerson: 120, base: "g", container: "box" },
  tiffin: { label: "tiffin", role: "meal", perPerson: 300, base: "g", container: "box" },
  noodles_pasta: { label: "noodles or pasta", role: "meal", perPerson: 350, base: "g", container: "box" },
  snack_fried: { label: "fried snack", role: "extra", perPerson: 150, base: "g", container: "tray" },
  sweet_milk: { label: "milk sweet", role: "extra", perPerson: 120, base: "ml", container: "leakproof" },
  sweet_dry: { label: "dry sweet", role: "extra", perPerson: 60, base: "g", container: "tray" },
  bakery: { label: "bakery item", role: "extra", perPerson: 80, base: "g", container: "box" },
  fruit: { label: "fruit", role: "extra", perPerson: 150, base: "g", container: "bag" },
  drink: { label: "drink", role: "extra", perPerson: 200, base: "ml", container: "leakproof" },
};

/** The app's coarse "kind of food" → a category fallback. */
const KIND_CATEGORY: Record<string, string> = { cooked_meal: "rice_dish", bakery: "bakery", dairy: "sweet_milk", packaged: "snack_fried", beverages: "drink", raw_produce: "fruit" };

const STOP = /\b(special|fresh|hot|spl|homemade|home made|tasty|leftover|extra|the|of|and|with)\b/g;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(STOP, " ").replace(/\s+/g, " ").trim();

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export interface DishMatch { dish: Dish | null; how: "exact" | "alias" | "fuzzy" | "category" | "none"; category: string; label: string }

/** §7.6: exact name → alias → near spelling / token overlap → category fallback. */
export function findDish(name: string, kind?: string): DishMatch {
  const n = norm(name);
  const fallback = (): DishMatch => {
    const cat = KIND_CATEGORY[kind ?? "cooked_meal"] ?? "rice_dish";
    return { dish: null, how: n ? "category" : "none", category: cat, label: CATEGORY_DEFAULTS[cat].label };
  };
  if (!n) return fallback();
  for (const d of DISHES) if (norm(d.name) === n) return { dish: d, how: "exact", category: d.category, label: d.name };
  for (const d of DISHES) if (d.aliases.some((a) => norm(a) === n)) return { dish: d, how: "alias", category: d.category, label: d.name };
  const words = new Set(n.split(" "));
  let best: { d: Dish; score: number } | null = null;
  for (const d of DISHES) {
    for (const cand of [d.name, ...d.aliases].map(norm)) {
      if (editDistance(n, cand) <= 2) return { dish: d, how: "fuzzy", category: d.category, label: d.name };
      const cw = cand.split(" "), overlap = cw.filter((w) => words.has(w)).length / Math.max(cw.length, words.size);
      if (overlap >= 0.8 && (!best || overlap > best.score)) best = { d, score: overlap };
    }
  }
  if (best) return { dish: best.d, how: "fuzzy", category: best.d.category, label: best.d.name };
  // a known dish word inside a longer name ("hotel special chicken biryani with raita")
  for (const d of DISHES) if (norm(d.name).split(" ").length > 1 && n.includes(norm(d.name))) return { dish: d, how: "fuzzy", category: d.category, label: d.name };
  return fallback();
}

export type EntryMode = "per_person_pack" | "shared_pack" | "bulk";
export interface QuantityEntry { mode: EntryMode; count?: number; feedsEach?: number; amount?: number; unit?: BulkUnit }

/** Units the donor can pick for bulk, by the dish's base unit (§6.3). */
export function unitsFor(m: DishMatch): BulkUnit[] {
  const base = m.dish?.base ?? CATEGORY_DEFAULTS[m.category]?.base ?? "g";
  return base === "pcs" ? ["pcs", "plates"] : base === "ml" ? ["L", "ml", "cups", "plates"] : ["kg", "g", "plates"];
}

export interface ServingsEstimate {
  servings: number;
  role: Role;
  /** True when it came from a category default, a near-spelling match or a donor guess (§7.4: "about N"). */
  estimate: boolean;
  /** Plain words for the donor: "6 kg of veg biryani ≈ 10 servings (600 g each)". */
  why: string;
  dishId: string | null;
  container: ContainerHint;
  /** Volume in litres, for container counts (§9.5); null for packs and pieces. */
  litres: number | null;
}

/** §7.4: packs are trusted; bulk goes through the portion table. Always rounds down. */
export function servingsFor(name: string, kind: string | undefined, q: QuantityEntry): ServingsEstimate {
  const m = findDish(name, kind);
  const cat = CATEGORY_DEFAULTS[m.category] ?? CATEGORY_DEFAULTS.rice_dish;
  const role = m.dish?.role ?? cat.role;
  const container = m.dish?.container ?? cat.container;
  const label = m.dish ? m.dish.name.toLowerCase() : `${name || "this food"} (treated as a ${cat.label})`;
  if (q.mode === "per_person_pack") {
    const n = Math.max(0, Math.floor(q.count ?? 0));
    return { servings: n, role, estimate: false, why: `${n} single-person packs = ${n} servings`, dishId: m.dish?.id ?? null, container: "bag", litres: null };
  }
  if (q.mode === "shared_pack") {
    const n = Math.max(0, Math.floor((q.count ?? 0) * (q.feedsEach ?? 0)));
    return { servings: n, role, estimate: false, why: `${q.count} packs × ${q.feedsEach} each = ${n} servings`, dishId: m.dish?.id ?? null, container: "bag", litres: null };
  }
  const base = m.dish?.base ?? cat.base, per = m.dish?.perPerson ?? cat.perPerson;
  const density = m.dish?.density ?? (base === "ml" || cat.base === "ml" ? 1 : 0.8);
  const amount = Math.max(0, q.amount ?? 0), unit = q.unit ?? (base === "pcs" ? "pcs" : base === "ml" ? "L" : "kg");
  let qty: number;   // in the dish's base unit
  if (unit === "plates") qty = amount * per;
  else if (base === "pcs") qty = amount;
  else {
    const grams = unit === "kg" ? amount * 1000 : unit === "g" ? amount : unit === "L" ? amount * 1000 * density : unit === "ml" ? amount * density : unit === "cups" ? amount * 150 * density : amount;
    qty = base === "g" ? grams : grams / density;
  }
  const servings = Math.max(0, Math.floor(qty / per));
  const litres = base === "pcs" ? null : (base === "ml" ? qty : qty / density) / 1000;
  const perText = base === "pcs" ? `${per} pieces` : base === "ml" ? `${per} ml` : `${per} g`;
  return { servings, role, estimate: m.how === "category" || m.how === "fuzzy" || m.how === "none", why: `${amount} ${unit} of ${label} ≈ ${servings} servings (${perText} each)`, dishId: m.dish?.id ?? null, container, litres };
}

/** §7.8: a donor number far from what the table predicts gets a confirm. */
export const farFrom = (donor: number, recommended: number) => recommended > 0 && Math.abs(donor - recommended) / recommended > 0.4;

const CAP: Record<ContainerHint, { label: string; litres: number; packs?: number }> = {
  box: { label: "5 L food box", litres: 5 },
  leakproof: { label: "5 L leak-proof can", litres: 5 },
  tray: { label: "tray", litres: 3 },
  bag: { label: "carry bag", litres: 10, packs: 10 },
};

/** §9.5: containers a partner brings for these items (`partner_brings`), or carry bags for packed food. */
export function containersFor(items: { servings: number; litres: number | null; container: ContainerHint }[], partnerBrings: boolean): string[] {
  const count = new Map<string, number>();
  const add = (label: string, n: number) => count.set(label, (count.get(label) ?? 0) + n);
  if (!partnerBrings) {
    const packs = items.reduce((n, i) => n + i.servings, 0);
    add("carry bag", Math.max(1, Math.ceil(packs / 15)));
  } else {
    for (const i of items) {
      const c = CAP[i.container];
      if (i.litres !== null) add(c.label, Math.max(1, Math.ceil(i.litres / c.litres)));
      else add(c.packs ? c.label : CAP.box.label, Math.max(1, Math.ceil(i.servings / (c.packs ?? 10))));
    }
  }
  return [...count].map(([label, n]) => `${n} × ${label}${n > 1 && label.endsWith("bag") ? "s" : ""}`);
}

/**
 * A food name has to name a food: not empty, not a placeholder ("{null}", "undefined", "test"), not code or
 * symbols. Shared by the form (which says why at once) and the API (which refuses it). Null when it's fine.
 */
export function dishNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Say what this food is.";
  if (/[{}<>[\]\\|`$]/.test(n)) return "Give the food's name in words, like Veg biryani.";
  if (!/\p{L}{2,}/u.test(n)) return "Give the food's name in words, like Veg biryani.";
  const bare = n.toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (/^(null|nil|none|undefined|nan|n a|na|test|testing|asdf|qwerty|abc|xyz|food|dish|item|something|anything|x+|a+)$/.test(bare))
    return "Give the food's real name, like Veg biryani, so NGOs know what's coming.";
  return null;
}
