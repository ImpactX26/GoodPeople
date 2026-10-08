/**
 * The worked examples from SRS section 5, as acceptance tests. Example 4 (redirect)
 * is in agent.test.ts and example 5 (gap closing) in gaps.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchListing } from "../../src/matching/engine/match.ts";
import { rankReason } from "../../src/matching/engine/reasons.ts";
import { defaultHunger } from "../../src/matching/hooks.ts";
import { at, east, item, KORAMANGALA, listing, partner, recipient, WED_NOON } from "./fixtures.ts";

const rider = partner({ id: "p1", ...east(KORAMANGALA, 1) });

test("1. Grade A biryani goes to the children's shelter 4 km away, not the general NGO 1.5 km away", () => {
  const kids = recipient({ id: "kids", name: "Children's shelter", kind: "orphanage", vulnerable: true, ...east(KORAMANGALA, 4) });
  const ngo = recipient({ id: "ngo", name: "General NGO", ...east(KORAMANGALA, 1.5) });
  const biryani = item({ name: "veg biryani", servings: 50, grade: "A", safeTime: 420 });
  const out = matchListing({ listing: listing({ items: [biryani] }), items: [biryani], recipients: [ngo, kids], partners: [rider], now: WED_NOON, hunger: defaultHunger });

  assert.equal(out.offers.length, 1);
  assert.equal(out.offers[0].recipientId, "kids");
  assert.deepEqual(out.offers[0].lines, [{ itemId: "i1", servings: 50 }]);
  assert.match(rankReason(biryani, out.ranked.get("i1")!), /serves vulnerable people and this is Grade A/);
});

test("2. Dal-rice safe 1.5 h: Jayanagar's 8 pm dinner is ruled out, 80 + 40 split", () => {
  const now = at(17, 45);
  const jayanagar = recipient({ id: "jaya", name: "Jayanagar NGO", servingTimes: ["20:00"], capacityPerDelivery: 150, ...east(KORAMANGALA, 5) });
  const shelter = recipient({ id: "kshelter", name: "Koramangala shelter", kind: "shelter", capacityPerDelivery: 80, ...east(KORAMANGALA, 1) });
  const fridge = recipient({ id: "fridge", name: "Community fridge", kind: "community_fridge", fridge: true, servesWithinMin: 0, capacityPerDelivery: 40, ...east(KORAMANGALA, 2) });
  const dal = item({ name: "dal-rice", servings: 120, grade: "C", safeTime: 90, confidence: 80 });
  const out = matchListing({
    listing: listing({ items: [dal], createdAt: now, readyFrom: now, collectBy: now + 3_600_000 }),
    items: [dal],
    recipients: [jayanagar, shelter, fridge],
    partners: [rider],
    now,
    hunger: defaultHunger,
  });

  const skip = out.skipped.find((s) => s.recipient.id === "jaya");
  assert.equal(skip?.code, "EXPIRES_BEFORE_SERVING");
  const split = Object.fromEntries(out.offers.map((o) => [o.recipientId, o.lines[0].servings]));
  assert.deepEqual(split, { kshelter: 80, fridge: 40 });
  assert.deepEqual(out.unallocated, []);
});

test("3. 50 veg + 30 chicken: veg to the veg-only NGO, chicken to a different shelter", () => {
  const vegNgo = recipient({ id: "veg", name: "Veg-only NGO", acceptsDiet: ["veg", "jain"], ...east(KORAMANGALA, 2) });
  // The shelter is a little closer and takes everything: without care it would swallow both items.
  const shelter = recipient({ id: "shelter", name: "Shelter", kind: "shelter", ...east(KORAMANGALA, 1.8) });
  const veg = item({ id: "veg-meals", name: "veg meals", servings: 50, grade: "B", safeTime: 240, diet: "veg" });
  const chicken = item({ id: "chicken", name: "chicken curry", servings: 30, grade: "B", safeTime: 240, diet: "nonveg" });
  const out = matchListing({ listing: listing({ items: [veg, chicken] }), items: [veg, chicken], recipients: [shelter, vegNgo], partners: [rider], now: WED_NOON, hunger: defaultHunger });

  const byRecipient = Object.fromEntries(out.offers.map((o) => [o.recipientId, o.lines]));
  assert.deepEqual(byRecipient.veg, [{ itemId: "veg-meals", servings: 50 }]);
  assert.deepEqual(byRecipient.shelter, [{ itemId: "chicken", servings: 30 }]);
  assert.equal(out.skipped.find((s) => s.recipient.id === "veg" && s.item.id === "chicken")?.code, "DIET");
});
