/**
 * The collect-by suggestion, judged with the NGOs and partners: collecting later never lets an extra NGO take the
 * food, so the Food Agent only suggests a later time when the restaurant's window is too tight for the agents to
 * get an NGO's yes and a partner there, and an NGO can still serve the food safely later. Safety can pull it in.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { adviseCollectBy, suggestCollectBy } from "../../src/matching/collect-by.ts";
import { config } from "../../src/matching/config.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import { at, east, item, KORAMANGALA, listing, MIN, partner, recipient } from "./fixtures.ts";

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

async function world(opts: { partnerKm?: number; urgency?: "HIGH" } = {}) {
  const store = memoryMatchingStore();
  await store.put("recipient", recipient({ id: "r1", name: "CHIRANTHS NGO", phone: "9000000001", servingTimes: [], ...east(KORAMANGALA, 2), urgency: opts.urgency }));
  if (opts.partnerKm !== undefined) await store.put("partner", partner({ id: "p1", phone: "9000000009", ...east(KORAMANGALA, opts.partnerKm) }));
  return store;
}

test("a normal hour to collect, with a partner nearby: nothing to suggest, listed at 7 am or 8 am", async () => {
  const store = await world({ partnerKm: 1 });
  for (const hour of [7, 8]) {
    const l = listing({ createdAt: at(hour), readyFrom: at(hour), collectBy: at(hour + 1), items: [item({ safeTime: 220 })] });
    assert.equal(await adviseCollectBy(store, l, at(hour)), null, `listed at ${hour}`);
  }
});

test("too tight to get an NGO's yes and a partner there: suggests the latest time the NGO can still serve it, and says why", async () => {
  const store = await world({ partnerKm: 6 });
  const l = listing({ createdAt: at(7), readyFrom: at(7), collectBy: at(7, 20), items: [item({ safeTime: 220 })] });
  const a = await adviseCollectBy(store, l, at(7));
  assert.ok(a, "a suggestion");
  assert.ok(a!.suggested > l.collectBy && a!.suggested <= at(7) + (220 - 45) * MIN);
  assert.match(a!.why, /CHIRANTHS NGO can still serve it safely/);
});

test("no NGO could take it at all: no suggestion (biogas handles that)", async () => {
  const store = memoryMatchingStore();
  const l = listing({ createdAt: at(7), readyFrom: at(7), collectBy: at(7, 20), items: [item({ safeTime: 220 })] });
  assert.equal(await adviseCollectBy(store, l, at(7)), null);
});

test("the food won't stay safe until the restaurant's time: collect sooner", async () => {
  const store = await world({ partnerKm: 1 });
  const l = listing({ createdAt: at(7), readyFrom: at(7), collectBy: at(10), items: [item({ safeTime: 120 })] });
  const a = await adviseCollectBy(store, l, at(7));
  assert.ok(a && a.suggested < l.collectBy);
  assert.equal(a!.suggested, at(8, 15), "9:00 safe, minus 45 min");
  assert.ok(suggestCollectBy(l, at(7)));
});

test("the restaurant says yes: the case works to the new time; a second answer is refused", async () => {
  const store = await world({ partnerKm: 6 });
  const luna = createLuna({ store });
  const { id: _i, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(7), readyFrom: at(7), collectBy: at(7, 20), items: [item({ safeTime: 220 })] });
  const l = await luna.submitListing(rest as NewListing, at(7));
  const opened = (await store.get("listing", l.id))!;
  assert.ok(opened.collectSuggestion, "the Food Agent suggested a time");
  assert.ok((await store.list("decision", { listingId: l.id })).some((d) => d.agent === "food" && d.kind === "suggested" && /NGO Agent/.test(d.reason)));
  assert.equal((await luna.answerCollect(l.id, true, { phone: "9999999999" }, at(7, 2))).ok, false, "only the restaurant answers");
  assert.ok((await luna.answerCollect(l.id, true, { phone: l.donorPhone }, at(7, 2))).ok);
  assert.equal((await store.get("listing", l.id))!.collectBy, opened.collectSuggestion!.suggested);
  assert.equal((await luna.answerCollect(l.id, false, { phone: l.donorPhone }, at(7, 3))).ok, false);
});
