/**
 * Donor incentives (SRS §9) count only what really happened: delivered servings, never listed ones. Surprise
 * bags can't be oversold.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { impactOf, leaderboard, monthRange, partnerSince, thisMonth } from "../../src/impact/impact.ts";
import { impactRoutes } from "../../src/impact/routes.ts";
import { config } from "../../src/matching/config.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import { at, east, item, KORAMANGALA, listing, partner, recipient } from "./fixtures.ts";

const NGO = "9000000001", RIDER = "9000000003";

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

async function delivered() {
  const store = memoryMatchingStore();
  await store.put("recipient", recipient({ id: "r1", name: "Hope Shelter", phone: NGO, ...east(KORAMANGALA, 1) }));
  await store.put("partner", partner({ id: "p1", phone: RIDER, ...east(KORAMANGALA, 0.5) }));
  const luna = createLuna({ store });
  const { id: _i, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(12), items: [item({ id: "i1", servings: 20 }), item({ id: "i2", servings: 10, quantity: { amount: 4, unit: "kg" } })] });
  const l = await luna.submitListing(rest as NewListing, at(12));
  const [s] = await store.list("share", { listingId: l.id });
  await luna.ngoReply(s.id, true, { phone: NGO }, at(12, 1));
  await luna.partnerReply(s.id, true, { phone: RIDER }, at(12, 2));
  const live = (await store.get("share", s.id))!;
  await luna.enterCode(s.id, "pickup", live.pickupCode, { phone: RIDER }, at(12, 10));
  await luna.enterCode(s.id, "drop", live.dropCode, { phone: RIDER }, at(12, 30));
  return { store, luna, l };
}

test("impact counts delivered servings; kg uses the donor's own kg where given, else 350 g a meal", async () => {
  const { store, l } = await delivered();
  const i = await impactOf(store, l.donorPhone, 0, at(23));
  assert.equal(i.meals, 30);
  assert.equal(i.deliveries, 1);
  assert.equal(i.ngos, 1);
  assert.equal(i.kgSaved, 20 * 0.35 + 4);
  assert.equal(i.co2eKg, Math.round((20 * 0.35 + 4) * 2.5 * 10) / 10);
  assert.equal(i.log[0].outcome, "delivered");
  assert.deepEqual(i.log[0].ngos, ["Hope Shelter"]);
  assert.ok((await partnerSince(store, l.donorPhone))! > 0, "the Luna Partner badge comes with the first delivery");
  assert.equal(await partnerSince(store, "9999999999"), null);
});

test("the leaderboard ranks restaurants by delivered servings in their area, by month", async () => {
  const { store, l } = await delivered();
  const month = thisMonth(at(12));
  const board = (await leaderboard(store, month))!;
  assert.equal(board.areas[0].top[0].donor, l.donorName);
  assert.equal(board.areas[0].top[0].meals, 30);
  assert.equal(monthRange("2026-13"), null);
  assert.equal((await leaderboard(store, "2020-01"))!.areas.length, 0);
});

test("surprise bags: reserving the last one twice gives one code, then sold out", async () => {
  const store = memoryMatchingStore();
  const luna = createLuna({ store });
  const app = impactRoutes(luna, store, () => at(17));
  await store.insert("bag", { id: "bag_1", donorPhone: "9800000001", donorName: "Corner Bakery", areaId: "koramangala", address: "1 Main Rd", lat: 12.93, lng: 77.62, title: "Bakery bag", contents: "Bread and buns", diet: "veg", count: 1, left: 1, price: 99, worth: 300, pickupFrom: at(17), pickupUntil: at(21), status: "open", createdAt: at(16) });
  const reserve = (phone: string) => app.request("/bags/bag_1/reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Asha", phone }) });
  const [a, b] = await Promise.all([reserve("9811111111"), reserve("9822222222")]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [201, 409], "one gets it, the other is told it's sold out");
  const listed = (await (await app.request("/bags")).json()) as unknown[];
  assert.equal(listed.length, 0, "a sold-out bag leaves the public list");
  const publicRow = (await store.get("bag", "bag_1"))!;
  assert.equal(publicRow.left, 0);
});
