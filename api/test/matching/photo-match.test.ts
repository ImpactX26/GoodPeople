/**
 * The photo doesn't look like the dish named: it's shown as a warning, never silent. Clearly a different dish
 * makes the food Unsure (the partner checks it at pickup); the NGO's food carries what the photo showed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromAgent } from "../../src/listings/foodCheck.ts";
import type { FoodListing } from "../../src/listings/types.ts";
import { passportItems } from "../../src/matching/bridge.ts";

const NOW = Date.UTC(2026, 9, 9, 0, 0);
const listing = { id: "lst_1", dish: "Paneer biriyani", diet: "veg", jain: false, halal: "unsure", spice: "mild", contains: [], entryMode: "per_person_pack", count: 10, feedsEach: 1, cookedAt: NOW - 30 * 60_000, storage: "hot", readyFrom: NOW, collectBy: NOW + 3_600_000, category: "cooked_meal", containers: "donor_packs", pickup: { name: "M", address: "A", area: "Koramangala", notes: "", lat: 12.93, lng: 77.62 }, donorName: "Meghana Foods", createdAt: NOW } as unknown as FoodListing;
const agent = (matches: "yes" | "partly" | "no", confidence = 0.9) => ({
  decision: "ELIGIBLE" as const,
  freshness: { score: 85, grade: "B" as const, unsure: false, photo_checked: true, condition: "fresh", safe_until: new Date(NOW + 4 * 3_600_000).toISOString() },
  restaurant_message: "", reasons: [], models: { photo: "gemini:x", reasoning: "rules" },
  photo: { checked: true, seen: "Bite-sized pieces of coated paneer in a dark sauce", matches, confidence },
});

test("a clearly different dish: a warning, and the food is Unsure so the partner checks it", () => {
  const c = fromAgent(agent("no"), listing, NOW);
  assert.equal(c.dishMatch, "no");
  assert.equal(c.unsure, true);
  const [item] = passportItems({ ...listing, foodCheck: c, assessment: { grade: "B", safeUntil: NOW + 4 * 3_600_000, servings: 10, unsure: true, source: "food_agent" } } as FoodListing, NOW);
  assert.equal(item.photoMismatch, "Bite-sized pieces of coated paneer in a dark sauce");
});

test("partly the dish: a warning, the grade stands; a match: nothing", () => {
  const partly = fromAgent(agent("partly"), listing, NOW);
  assert.equal(partly.dishMatch, "partly");
  assert.equal(partly.unsure, false);
  assert.equal(fromAgent(agent("yes"), listing, NOW).dishMatch, "yes");
});

test("clearly not the dish: the listing is held. Sure: relist; less sure: the restaurant may say it's right", () => {
  const sure = fromAgent(agent("no", 0.9), listing, NOW);
  assert.equal(sure.tagsVerdict, "wrong");
  assert.deepEqual(sure.tagChecks!.map((t) => [t.tag, t.certainty]), [["name", "sure"]]);
  const maybe = fromAgent(agent("no", 0.5), listing, NOW);
  assert.equal(maybe.tagsVerdict, "unsure");
  assert.equal(maybe.tagChecks![0].verdict, "maybe");
  assert.equal(fromAgent(agent("partly"), listing, NOW).tagsVerdict, "ok", "partly is a warning, not a hold");
});
