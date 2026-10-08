/**
 * Foods in one listing are checked one by one, and the agents place each by its own grade: a food only one
 * NGO can safely take goes there, and the NGO's offer lists every food with its own grade and safe-until.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { config } from "../../src/matching/config.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import { at, east, item, KORAMANGALA, listing, partner, recipient } from "./fixtures.ts";

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

test("a Grade C dish never goes to the old-age home; the Grade A dish can; offers list each food's grade", async () => {
  const store = memoryMatchingStore();
  await store.put("recipient", recipient({ id: "home", name: "Sri Sai Old-age Home", phone: "9000000001", kind: "old_age_home", vulnerable: true, capacityPerDelivery: 30, ...east(KORAMANGALA, 1) }));
  await store.put("recipient", recipient({ id: "shelter", name: "Night Shelter", phone: "9000000002", capacityPerDelivery: 100, ...east(KORAMANGALA, 2) }));
  await store.put("partner", partner({ id: "p1", phone: "9000000009", ...east(KORAMANGALA, 1) }));
  const luna = createLuna({ store });
  const { id: _id, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(12) });
  const input: NewListing = {
    ...rest,
    items: [
      item({ id: "i1", name: "Paneer manchurian", servings: 20, grade: "C", safeTime: 120, tags: ["meal"] }),
      item({ id: "i2", name: "Veg pulao", servings: 30, grade: "A", safeTime: 600, tags: ["meal"] }),
    ],
  };
  const l = await luna.submitListing(input, at(12));
  const shares = await store.list("share", { listingId: l.id });
  const lines = (ngo: string) => shares.filter((s) => s.candidates[0]?.ngoId === ngo).flatMap((s) => s.lines.map((x) => x.itemId));

  assert.ok(!lines("home").includes("i1"), "Grade C food is never offered to a vulnerable group");
  assert.ok(lines("shelter").includes("i1"), "the Grade C food goes to the NGO that can take it");
  for (const s of shares) for (const c of s.candidates) if (c.ngoId === "home") assert.ok(!s.lines.some((x) => x.itemId === "i1"), "the old-age home isn't even a backup for the Grade C food");

  const offers = (await store.list("outbox")).filter((m) => m.text.startsWith("Food offer"));
  const mixed = offers.find((m) => m.text.includes("Paneer manchurian") && m.text.includes("Veg pulao"));
  if (mixed) {
    assert.match(mixed.text, /each food checked on its own/);
    assert.match(mixed.text, /Paneer manchurian: Grade C, safe until/);
    assert.match(mixed.text, /Veg pulao: Grade A, safe until/);
  }
  assert.ok(offers.some((m) => /Grade C/.test(m.text)) && offers.some((m) => /Grade A/.test(m.text)), "each grade reaches the NGOs");
});

test("an offer with several foods lists each one with its own grade and safe-until", async () => {
  const { foodOffer } = await import("../../src/matching/whatsapp/templates.ts");
  const m = foodOffer({ shareId: "s1", servings: 50, food: "Paneer manchurian + Veg pulao", grade: "C", safeUntil: at(14), arriveBy: at(12, 10), minutes: 10,
    foods: [{ name: "Paneer manchurian", servings: 20, grade: "C", safeUntil: at(14) }, { name: "Veg pulao", servings: 30, grade: "A", safeUntil: at(22) }] });
  assert.match(m.text, /each food checked on its own/);
  assert.match(m.text, /20 × Paneer manchurian: Grade C, safe until 2:00 pm/);
  assert.match(m.text, /30 × Veg pulao: Grade A, safe until 10:00 pm/);
});
