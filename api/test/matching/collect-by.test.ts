/**
 * The listing form guesses "collect within 1 hour" before the food is checked. The Food Agent then knows how long
 * the food really stays safe and suggests a collect-by time from it; the restaurant decides.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { suggestCollectBy } from "../../src/matching/collect-by.ts";
import { config } from "../../src/matching/config.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import { at, item, listing, MIN } from "./fixtures.ts";

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

test("safe for 3 hours but set to 1 hour: suggests about 2 h 15 min, rounded to the quarter hour", () => {
  const l = listing({ createdAt: at(0, 23), collectBy: at(1, 23), items: [item({ safeTime: 179 })] });
  const s = suggestCollectBy(l, at(0, 24));
  assert.ok(s);
  assert.equal(s!.safeUntil, at(3, 22));
  assert.equal(s!.suggested, at(2, 30), "3:22 am minus 45 min for the ride and serving, down to 2:30");
});

test("no suggestion when the restaurant's time is already about right, or the food is nearly out of time", () => {
  assert.equal(suggestCollectBy(listing({ createdAt: at(12), collectBy: at(14, 10), items: [item({ safeTime: 180 })] }), at(12)), null);
  assert.equal(suggestCollectBy(listing({ createdAt: at(12), collectBy: at(13), items: [item({ safeTime: 60 })] }), at(12)), null);
});

test("the restaurant says yes: the case works to the new time; a second answer is refused", async () => {
  const store = memoryMatchingStore();
  const luna = createLuna({ store });
  const { id: _i, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(12), collectBy: at(13), items: [item({ safeTime: 300 })] });
  const l = await luna.submitListing(rest as NewListing, at(12));
  const opened = (await store.get("listing", l.id))!;
  assert.ok(opened.collectSuggestion, "the Food Agent suggested a time");
  assert.equal(opened.collectSuggestion!.suggested, at(16, 15), "5 pm safe, minus 45 min");
  assert.ok((await store.list("decision", { listingId: l.id })).some((d) => d.agent === "food" && d.kind === "suggested"));
  assert.equal((await luna.answerCollect(l.id, true, { phone: "9999999999" }, at(12, 5))).ok, false, "only the restaurant answers");
  const r = await luna.answerCollect(l.id, true, { phone: l.donorPhone }, at(12, 5));
  assert.ok(r.ok);
  assert.equal((await store.get("listing", l.id))!.collectBy, at(16, 15));
  assert.equal((await luna.answerCollect(l.id, false, { phone: l.donorPhone }, at(12, 6))).ok, false);
  assert.ok(MIN);
});
