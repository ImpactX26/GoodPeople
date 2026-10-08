/**
 * Meal assembly (spec §7.5): staples and sides only count as meals when paired, bundles carry the strictest
 * tags of their parts, pack as their parts, and the Food Agent's reasoning can only reorder or drop pairs.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { config } from "../../src/matching/config.ts";
import { assembleMeals, pairingIsAChoice, rulePairs } from "../../src/matching/engine/bundles.ts";
import { packingLines } from "../../src/matching/food-agent.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import type { Llm } from "../../src/matching/reasoning/llm.ts";
import { createReasoner } from "../../src/matching/reasoning/reasoner.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import type { Item } from "../../src/matching/types.ts";
import { at, east, item, KORAMANGALA, listing, partner, recipient } from "./fixtures.ts";

/** The spec's caterer: 15 kg rice (50), 4.5 L dal (30), 3 L chicken curry (20), 40 cups payasam. */
const caterer = (): Item[] => [
  item({ id: "i1", name: "Plain rice", servings: 50, tags: ["staple"], quantity: { amount: 15, unit: "kg" } }),
  item({ id: "i2", name: "Dal", servings: 30, tags: ["side"], quantity: { amount: 4.5, unit: "L" } }),
  item({ id: "i3", name: "Chicken curry", servings: 20, tags: ["side"], diet: "nonveg", allergens: ["onion"], safeTime: 200, quantity: { amount: 3, unit: "L" } }),
  item({ id: "i4", name: "Payasam", servings: 40, tags: ["extra"], allergens: ["dairy"] }),
];

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

describe("pairing staples with sides", () => {
  test("the spec's caterer: rice + dal × 30 (veg) and rice + chicken curry × 20 (non-veg): 50 meals + 40 extras", () => {
    const plan = assembleMeals(caterer());
    assert.deepEqual(plan.bundles.map((b) => [b.staple, b.side, b.servings]), [["i1", "i2", 30], ["i1", "i3", 20]]);
    assert.equal(plan.meals, 50);
    assert.equal(plan.extras, 40);
    assert.equal(plan.addons, 0);
    const [veg, nonveg] = plan.items.filter((i) => i.bundle);
    assert.equal(veg.diet, "veg");
    assert.equal(nonveg.diet, "nonveg");
    assert.deepEqual(nonveg.allergens, ["onion"]);
    assert.equal(nonveg.safeTime, 200, "a bundle is only as safe as its shortest-lived part");
    assert.ok(!plan.items.some((i) => i.id === "i1" || i.id === "i2"), "paired rice and dal are not offered on their own");
  });

  test("a lone staple is an add-on, never a meal", () => {
    const plan = assembleMeals([item({ id: "i1", name: "Plain rice", servings: 50, tags: ["staple"] })]);
    assert.equal(plan.meals, 0);
    assert.equal(plan.addons, 50);
    assert.ok(plan.items[0].tags?.includes("addon"));
  });

  test("advice can only reorder or drop pairs; a pair naming other food is ignored", () => {
    const items = caterer();
    const skipped = assembleMeals(items, [["i1", "i3"], ...rulePairs(items)], [["i1", "i2"]]);
    assert.deepEqual(skipped.bundles.map((b) => [b.side, b.servings]), [["i3", 20]]);
    assert.equal(skipped.addons, 30 + 30, "rice and dal left over ride along");
    const stray = assembleMeals(items, [["i4", "i2"], ["i2", "i1"]]);
    assert.equal(stray.meals, 0, "an extra or a reversed pair makes no meal");
  });

  test("chapati with rasam is a poor fit and worth a look; one rice and one dal is not", () => {
    const chapati = item({ id: "i1", name: "Chapati", servings: 20, tags: ["staple"] });
    assert.equal(pairingIsAChoice([chapati, item({ id: "i2", name: "Rasam", servings: 20, tags: ["side"] })]), true);
    assert.equal(pairingIsAChoice([item({ id: "i1", name: "Plain rice", servings: 20, tags: ["staple"] }), item({ id: "i2", name: "Dal", servings: 20, tags: ["side"] })]), false);
  });
});

describe("meals through the agents", () => {
  async function opened() {
    const store = memoryMatchingStore();
    await store.put("recipient", recipient({ id: "r1", name: "Veg Home", phone: "9000000001", acceptsDiet: ["veg", "jain"], capacityPerDelivery: 30, ...east(KORAMANGALA, 1) }));
    await store.put("recipient", recipient({ id: "r2", name: "Open Shelter", phone: "9000000002", capacityPerDelivery: 100, ...east(KORAMANGALA, 2) }));
    await store.put("partner", partner({ id: "p1", name: "Ravi", phone: "9000000009", ...east(KORAMANGALA, 1) }));
    const luna = createLuna({ store });
    const plan = assembleMeals(caterer());
    const { id: _id, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(12) });
    const input: NewListing = { ...rest, items: plan.items, parts: plan.parts };
    const l = await luna.submitListing(input, at(12));
    return { store, luna, l };
  }

  test("a veg-only NGO only gets the veg meals; servings are counted once per meal", async () => {
    const { store, l } = await opened();
    const shares = await store.list("share", { listingId: l.id });
    for (const s of shares) {
      const ids = s.lines.map((ln) => ln.itemId);
      if (s.ngoId === "r1") assert.ok(!ids.includes("b2"), "no chicken for the veg-only home");
    }
    const meals = shares.flatMap((s) => s.lines).filter((ln) => ln.itemId.startsWith("b")).reduce((n, ln) => n + ln.servings, 0);
    assert.equal(meals, 50);
  });

  test("a bundle packs as its rice and its dal, in the restaurant's units", async () => {
    const { store, l } = await opened();
    const full = (await store.get("listing", l.id))!;
    const lines = packingLines(full, [{ itemId: "b1", servings: 30 }, { itemId: "b2", servings: 20 }]);
    assert.deepEqual(lines.map((p) => [p.name, p.servings, p.amount]), [["Plain rice", 50, "15 kg"], ["Dal", 30, "4.5 L"], ["Chicken curry", 20, "3 L"]]);
  });
});

describe("the Food Agent's reasoning on pairing", () => {
  const items = [
    item({ id: "i1", name: "Chapati", servings: 20, tags: ["staple"] }),
    item({ id: "i2", name: "Plain rice", servings: 20, tags: ["staple"] }),
    item({ id: "i3", name: "Rasam", servings: 20, tags: ["side"] }),
    item({ id: "i4", name: "Dal", servings: 20, tags: ["side"] }),
  ];
  const reasonerWith = (reply: () => Promise<Record<string, unknown>>) => {
    const store = memoryMatchingStore();
    const llm = { enabled: true, ask: async () => ({ ok: true as const, json: await reply(), model: "fake:model", ms: 5 }), status: () => ({}) } as unknown as Llm;
    return createReasoner({ rt: createLuna({ store }).runtime, llm });
  };

  test("its pairs go first, checked, and the thought says what changed", async () => {
    const r = reasonerWith(async () => ({ verdict: "would_change", headline: "Rice with rasam, chapati with dal", reasoning: ["Chapati and rasam don't make a meal."], actions: [{ tool: "pair_meals", pairs: [["i2", "i3"], ["i1", "i4"]], skip: [["i1", "i3"]] }] }));
    const out = (await r.pairMeals("Sample Hotel", items))!;
    assert.deepEqual(out.advice, { order: [["i2", "i3"], ["i1", "i4"]], skip: [["i1", "i3"]] });
    const plan = assembleMeals(items, [...out.advice!.order, ...rulePairs(items)], out.advice!.skip);
    assert.deepEqual(plan.bundles.map((b) => [b.staple, b.side]), [["i2", "i3"], ["i1", "i4"]]);
  });

  test("pairs naming food that isn't a staple or side here are blocked", async () => {
    const r = reasonerWith(async () => ({ verdict: "would_change", actions: [{ tool: "pair_meals", pairs: [["i3", "i1"], ["x9", "i4"]] }] }));
    const out = (await r.pairMeals("Sample Hotel", items))!;
    assert.equal(out.advice, null);
  });

  test("no answer in time: the rules' pairing goes ahead", async () => {
    const r = reasonerWith(() => new Promise((res) => setTimeout(() => res({ verdict: "agree" }), 300)));
    const out = (await r.pairMeals("Sample Hotel", items, 50))!;
    assert.equal(out.advice, null);
  });
});
