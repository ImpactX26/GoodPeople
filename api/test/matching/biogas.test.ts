/**
 * Late at night every NGO is closed until morning and the food won't keep that long: the agents say exactly
 * that (not "no partner"), offer the restaurant a biogas pickup, and the case closes once it's collected.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { leftoverOf } from "../../src/matching/biogas.ts";
import { config } from "../../src/matching/config.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import { at, east, item, KORAMANGALA, listing, partner, recipient } from "./fixtures.ts";

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

async function lateNight() {
  const store = memoryMatchingStore();
  const hours = { start: "08:00", end: "21:00" };
  await store.put("recipient", recipient({ id: "a", name: "CHIRANTHS NGO", phone: "9000000001", receivingHours: hours, servingTimes: [], ...east(KORAMANGALA, 1) }));
  await store.put("recipient", recipient({ id: "b", name: "Vihaan's NGO", phone: "9000000002", receivingHours: hours, servingTimes: [], ...east(KORAMANGALA, 2) }));
  await store.put("recipient", recipient({ id: "gas", name: "Sample Biogas Plant, Bellandur", kind: "biogas", capacityPerDelivery: 2000, acceptRadiusKm: 30, ...east(KORAMANGALA, 5) }));
  await store.put("partner", partner({ id: "p1", phone: "9000000009", ...east(KORAMANGALA, 1) }));
  const luna = createLuna({ store });
  const { id: _i, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(22, 23), readyFrom: at(22, 23), collectBy: at(23, 30) });
  const input: NewListing = {
    ...rest,
    items: [
      item({ id: "i1", name: "paneer manchurian", servings: 10, grade: "B", safeTime: 222, tags: ["meal"] }),
      item({ id: "i2", name: "samosa", servings: 8, grade: "C", safeTime: 179, tags: ["extra"] }),
    ],
  };
  const l = await luna.submitListing(input, at(22, 23));
  return { store, luna, l };
}

test("closed NGOs at night: the real reason, no partner talk, and a biogas offer", async () => {
  const { store, l } = await lateNight();
  const decisions = await store.list("decision", { listingId: l.id });
  const esc = decisions.find((d) => d.kind === "escalated");
  assert.ok(esc, "escalated");
  assert.match(esc!.reason, /closed until 8 am/);
  assert.match(esc!.reason, /biogas/);
  assert.ok(!decisions.some((d) => /split/i.test(d.reason)));

  const toDonor = (await store.list("outbox")).filter((m) => m.audience.startsWith("donor:")).map((m) => m.text);
  assert.ok(toDonor.some((t) => /No NGO can take your food/.test(t) && /biogas/.test(t)), toDonor.join("\n"));
  assert.ok(!toDonor.some((t) => /delivery partner/i.test(t)), "no partner talk when it's the NGOs that can't take it");

  const left = await leftoverOf(store, (await store.get("listing", l.id))!);
  assert.equal(left.servings, 18);
  assert.equal(left.waitingOnPartner, 0);
  // The plant is never offered food by the NGO Agent itself.
  assert.ok(!(await store.list("share", { listingId: l.id })).some((s) => s.candidates.some((c) => c.ngoId === "gas")));
});

test("the restaurant books the biogas pickup, then marks it collected; the case closes", async () => {
  const { store, luna, l } = await lateNight();
  const stranger = await luna.sendToBiogas(l.id, { phone: "9999999999" }, at(22, 30));
  assert.equal(stranger.ok, false);

  const r = await luna.sendToBiogas(l.id, { phone: l.donorPhone }, at(22, 30));
  assert.ok(r.ok, JSON.stringify(r));
  const [p] = await store.list("biogas", { listingId: l.id });
  assert.equal(p.status, "booked");
  assert.equal(p.lines.reduce((n, x) => n + x.servings, 0), 18);
  assert.equal((await leftoverOf(store, (await store.get("listing", l.id))!)).servings, 0, "nothing left over once booked");
  assert.equal((await luna.sendToBiogas(l.id, { phone: l.donorPhone }, at(22, 31))).ok, false, "can't book twice");
  assert.ok((await store.list("decision", { listingId: l.id })).some((d) => d.kind === "biogas" && /sample plant, no message sent/.test(d.reason)));

  assert.ok((await luna.biogasCollected(p.id, { phone: l.donorPhone }, at(23))).ok);
  assert.equal((await store.get("listing", l.id))!.status, "closed");
  assert.match((await store.list("decision", { listingId: l.id })).find((d) => d.kind === "closed")!.reason, /18 sent to biogas/);
});
