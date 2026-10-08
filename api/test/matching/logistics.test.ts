/**
 * The Logistics Agent, and how it works with the Decision Agent, following the
 * flow: offer to NGOs with a countdown → find a partner (NGO's own, then
 * independents) → pickup code → trip → drop code → receipt and feedback.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { config } from "../../src/matching/config.ts";
import type { HungerProvider } from "../../src/matching/hooks.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore, type MatchingStore } from "../../src/matching/store.ts";
import type { Partner, Recipient } from "../../src/matching/types.ts";
import { handleInbound } from "../../src/matching/whatsapp/webhook.ts";
import { at, east, item, KORAMANGALA, listing, MIN, partner, recipient } from "./fixtures.ts";

const NGO1 = "9000000001";
const NGO2 = "9000000002";
const RIDER = "9000000003";
const RIDER2 = "9000000004";
const DONOR = "9800000001";

function newListing(over: Partial<NewListing> = {}, now = at(12)): NewListing {
  const { id: _id, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: now });
  return { ...rest, ...over };
}

async function setup(recipients: Recipient[], partners: Partner[], hunger?: HungerProvider) {
  const store = memoryMatchingStore();
  for (const r of recipients) await store.put("recipient", r);
  for (const p of partners) await store.put("partner", p);
  return { store, luna: createLuna({ store, hunger }) };
}

const to = async (store: MatchingStore, phone: string) =>
  (await store.list("outbox")).filter((m) => m.to === phone).sort((a, b) => a.createdAt - b.createdAt).map((m) => m.text);
const last = async (store: MatchingStore, phone: string) => (await to(store, phone)).at(-1) ?? "";
const shareOf = async (store: MatchingStore, listingId: string) => (await store.list("share", { listingId }))[0];

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

describe("the whole flow", () => {
  test("offer → NGO accepts → partner accepts → pickup code → drop code → receipt → feedback", async () => {
    const { store, luna } = await setup(
      [recipient({ id: "r1", name: "Hope Shelter", phone: NGO1, ...east(KORAMANGALA, 2) })],
      [partner({ id: "p1", name: "Ravi", phone: RIDER, ...east(KORAMANGALA, 1) })],
    );
    const items = [
      item({ id: "i1", name: "veg biryani", servings: 30, quantity: { amount: 6, unit: "kg" } }),
      item({ id: "i2", name: "payasam", servings: 20, quantity: { amount: 4, unit: "L" } }),
    ];
    const l = await luna.submitListing(newListing({ items, containers: ["2 insulated bags", "1 crate"] }), at(12));
    let s = await shareOf(store, l.id);
    assert.equal(s.status, "offering");
    assert.equal(s.ngoId, "r1");
    assert.match(await last(store, NGO1), /^Food offer: 50 servings of veg biryani \+ payasam/);

    assert.equal((await luna.ngoReply(s.id, true, { phone: NGO2 }, at(12, 1))).ok, false);
    assert.equal((await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1))).ok, true);
    s = await shareOf(store, l.id);
    assert.equal(s.status, "finding_partner");
    assert.equal(s.askedPartnerId, "p1");
    assert.match(await last(store, RIDER), /Bring: 2 insulated bags, 1 crate\. Reply within 3 min\./);

    assert.equal((await luna.partnerReply(s.id, true, { phone: RIDER }, at(12, 2))).ok, true);
    s = await shareOf(store, l.id);
    assert.equal(s.status, "assigned");
    // The restaurant is told who's coming, when, what to keep ready, and the pickup code.
    assert.match(await last(store, DONOR), new RegExp(`Ravi, 12:\\d\\d pm, keep 6 kg veg biryani \\+ 4 L payasam ready\\. Pickup code: ${s.pickupCode}`));
    assert.match(await last(store, NGO1), new RegExp(`Your drop code is ${s.dropCode}`));
    const trip = await last(store, RIDER);
    assert.match(trip, /Collect 6 kg veg biryani \+ 4 L payasam/);
    assert.match(trip, /Bring: 2 insulated bags, 1 crate\./);
    assert.ok(!trip.includes(s.pickupCode) && !trip.includes(s.dropCode), "the partner must not be sent the codes");

    const wrong = s.pickupCode === "1111" ? "2222" : "1111";
    assert.deepEqual(await luna.enterCode(s.id, "pickup", wrong, { phone: RIDER }, at(12, 6)), { ok: false, error: "That pickup code doesn't match. 2 tries left.", status: 400 });
    assert.equal((await luna.enterCode(s.id, "drop", s.dropCode, { phone: RIDER }, at(12, 6))).ok, false, "can't drop before pickup");
    assert.equal((await luna.enterCode(s.id, "pickup", s.pickupCode, { phone: RIDER }, at(12, 6))).ok, true);
    assert.equal((await shareOf(store, l.id)).status, "picked_up");
    assert.equal((await luna.enterCode(s.id, "drop", s.dropCode, { phone: RIDER }, at(12, 15))).ok, true);

    assert.equal((await shareOf(store, l.id)).status, "delivered");
    assert.equal((await store.get("listing", l.id))!.status, "closed");
    assert.match(await last(store, DONOR), /Delivered to Hope Shelter at 12:15 pm, fed 50\. Thank you!/);
    assert.equal((await store.list("decision", { kind: "closed" })).length, 1);
    assert.equal((await store.get("partner", "p1"))!.activeShareId, undefined);

    assert.match(await last(store, NGO1), /How did it go\?/);
    assert.equal((await luna.feedback(s.id, "fewer", { phone: NGO1 }, at(12, 30))).ok, true);
    assert.equal((await shareOf(store, l.id)).feedback, "fewer");
    assert.equal((await luna.feedback(s.id, "more", { phone: NGO1 }, at(12, 31))).ok, false);
  });

  test("every decision says which agent made it", async () => {
    const { store, luna } = await setup([recipient({ id: "r1", phone: NGO1 }), recipient({ id: "r2", phone: NGO2, vulnerable: true, kind: "orphanage" })], [partner({ id: "p1", phone: RIDER })]);
    await luna.submitListing(newListing({ items: [item({ grade: "B", safeTime: 240 })] }), at(12));
    const agents = new Map((await store.list("decision")).map((d) => [d.kind, d.agent]));
    assert.equal(agents.get("filtered"), "ngo");
    assert.equal(agents.get("ranked"), "ngo");
    assert.equal(agents.get("offered"), "logistics");
    assert.equal(agents.get("review"), "decision");
  });
});

describe("offering to NGOs", () => {
  const two = () => [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) }), recipient({ id: "r2", phone: NGO2, ...east(KORAMANGALA, 3) })];

  test("an unanswered offer times out and goes to the next NGO", async () => {
    const { store, luna } = await setup(two(), [partner({ id: "p1", phone: RIDER })]);
    const l = await luna.submitListing(newListing(), at(12));
    const first = await shareOf(store, l.id);
    assert.equal(first.ngoId, "r1");
    await luna.tick(first.offerDeadlineAt! + 1);
    const s = await shareOf(store, l.id);
    assert.equal(s.ngoId, "r2");
    assert.deepEqual(s.triedNgoIds, ["r1"]);
    assert.match(await last(store, NGO1), /closed because the time ran out/);
  });

  test("accepting after the countdown is rejected, even before the clock ticks", async () => {
    const { store, luna } = await setup(two(), [partner({ id: "p1", phone: RIDER })]);
    const l = await luna.submitListing(newListing(), at(12));
    const first = await shareOf(store, l.id);
    assert.equal((await luna.ngoReply(first.id, true, { phone: NGO1 }, first.offerDeadlineAt! + 1)).ok, false);
    assert.equal((await shareOf(store, l.id)).ngoId, "r2");
  });

  test("the first-choice NGO hears about the food at once, even before a partner is online", async () => {
    // r1 is first choice; only r2 has a rider and the independent is offline. NGOs are told first; partners after.
    const { store, luna } = await setup(two(), [
      partner({ id: "indie", phone: RIDER, online: false }),
      partner({ id: "r2-rider", phone: RIDER2, ngoId: "r2", ...east(KORAMANGALA, 2) }),
    ]);
    const l = await luna.submitListing(newListing(), at(12));
    const s = await shareOf(store, l.id);
    assert.equal(s.ngoId, "r1");
    const offered = (await store.list("decision", { kind: "offered", subject: "r1" })).find((d) => d.agent === "logistics");
    assert.match(offered!.reason, /No delivery partner is online near it yet/);
    assert.match(await last(store, NGO1), /^Food offer/);
  });

  test("a declined share goes to the next NGO on its list", async () => {
    const { store, luna } = await setup(
      [
        recipient({ id: "r1", phone: NGO1, capacityPerDelivery: 80, ...east(KORAMANGALA, 1) }),
        recipient({ id: "r2", phone: NGO2, capacityPerDelivery: 40, ...east(KORAMANGALA, 2) }),
        recipient({ id: "r3", phone: "9000000009", capacityPerDelivery: 100, ...east(KORAMANGALA, 8) }),
      ],
      [partner({ id: "p1", phone: RIDER }), partner({ id: "p2", phone: RIDER2 })],
    );
    const l = await luna.submitListing(newListing({ items: [item({ servings: 120 })] }), at(12));
    const shares = await store.list("share", { listingId: l.id });
    assert.deepEqual(shares.map((s) => [s.ngoId, s.lines[0].servings]).sort(), [["r1", 80], ["r2", 40]]);
    const big = shares.find((s) => s.ngoId === "r1")!;
    assert.deepEqual(big.candidates.map((c) => c.ngoId), ["r1", "r3"], "r3 is the only backup with room for 80");
    await luna.ngoReply(big.id, false, { phone: NGO1 }, at(12, 1));
    assert.equal((await store.get("share", big.id))!.ngoId, "r3");
  });

  test("when every NGO on a share's list passes, the Decision Agent re-plans the servings", async () => {
    const { store, luna } = await setup(
      [
        recipient({ id: "r1", phone: NGO1, capacityPerDelivery: 80, ...east(KORAMANGALA, 1) }),
        recipient({ id: "r3", phone: "9000000009", capacityPerDelivery: 50, ...east(KORAMANGALA, 6) }),
        recipient({ id: "r4", phone: "9000000008", capacityPerDelivery: 50, ...east(KORAMANGALA, 7) }),
      ],
      [partner({ id: "p1", phone: RIDER }), partner({ id: "p2", phone: RIDER2 })],
    );
    const l = await luna.submitListing(newListing({ items: [item({ servings: 80 })] }), at(12));
    const share = await shareOf(store, l.id);
    assert.deepEqual(share.candidates.map((c) => c.ngoId), ["r1"], "nobody else has room for all 80");
    await luna.ngoReply(share.id, false, { phone: NGO1 }, at(12, 1));
    assert.equal((await store.get("share", share.id))!.status, "unplaced");
    const replanned = (await store.list("share", { listingId: l.id })).filter((s) => s.id !== share.id);
    assert.deepEqual(replanned.map((s) => [s.ngoId, s.lines[0].servings]).sort(), [["r3", 50], ["r4", 30]]);
  });
});

describe("finding a partner", () => {
  test("the NGO's own partners are asked first, then independents; other NGOs' riders never", async () => {
    const { store, luna } = await setup(
      [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 2) }), recipient({ id: "r9", phone: "9000000099", active: false })],
      [
        partner({ id: "indie", phone: RIDER, ...east(KORAMANGALA, 0.2) }),
        partner({ id: "own", phone: RIDER2, ngoId: "r1", ...east(KORAMANGALA, 3) }),
        partner({ id: "other", phone: "9000000098", ngoId: "r9", ...KORAMANGALA }),
      ],
    );
    const l = await luna.submitListing(newListing(), at(12));
    const s = await shareOf(store, l.id);
    await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    assert.equal((await shareOf(store, l.id)).askedPartnerId, "own");
    await luna.partnerReply(s.id, false, { phone: RIDER2 }, at(12, 2));
    assert.equal((await shareOf(store, l.id)).askedPartnerId, "indie");
    await luna.partnerReply(s.id, false, { phone: RIDER }, at(12, 3));
    // Nobody else may collect ("other" rides for another NGO): the NGO keeps the food and Luna keeps looking…
    const waiting = await shareOf(store, l.id);
    assert.equal(waiting.status, "finding_partner");
    assert.match(await last(store, NGO1), /No delivery partner is free right now/);
    // …until the pickup window closes.
    await luna.tick(l.collectBy + 1);
    assert.equal((await shareOf(store, l.id)).status, "unplaced");
    assert.match(await last(store, NGO1), /no delivery partner could collect/);
  });

  test("if no partner can collect before the pickup window closes, the share goes to the next NGO", async () => {
    const { store, luna } = await setup(
      [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) }), recipient({ id: "r2", phone: NGO2, ...east(KORAMANGALA, 3) })],
      [partner({ id: "p1", phone: RIDER })],
    );
    const l = await luna.submitListing(newListing(), at(12));
    const s = await shareOf(store, l.id);
    await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    await luna.partnerReply(s.id, false, { phone: RIDER }, at(12, 2));
    assert.equal((await shareOf(store, l.id)).status, "finding_partner", "it waits for a partner while there's time");
    await luna.tick(l.collectBy + 1);
    const next = await shareOf(store, l.id);
    assert.equal(next.status, "offering");
    assert.equal(next.ngoId, "r2");
    assert.match(await last(store, NGO2), /^Food offer/);
  });

  test("partners get 3 minutes to accept, 90 seconds for serve-now food; then the next one is asked", async () => {
    const { store, luna } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) })], [partner({ id: "p1", phone: RIDER }), partner({ id: "p2", phone: RIDER2, ...east(KORAMANGALA, 1) })]);
    const l = await luna.submitListing(newListing(), at(12));
    const s = await shareOf(store, l.id);
    await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    const asked = await shareOf(store, l.id);
    assert.equal(asked.askDeadlineAt! - asked.askedAt!, 3 * MIN);
    await luna.tick(asked.askDeadlineAt! + 1);
    assert.equal((await shareOf(store, l.id)).askedPartnerId, "p2");

    const c = await luna.submitListing(newListing({ items: [item({ grade: "C", safeTime: 120 })] }, at(13)), at(13));
    const sc = await shareOf(store, c.id);
    await luna.ngoReply(sc.id, true, { phone: NGO1 }, at(13, 1));
    const askedC = await shareOf(store, c.id);
    assert.equal(askedC.askDeadlineAt! - askedC.askedAt!, 90_000);
  });

  test("an NGO coordinator can assign someone by hand and enter their codes", async () => {
    const { store, luna } = await setup([recipient({ id: "r1", name: "Hope Shelter", phone: NGO1, ...east(KORAMANGALA, 2) })], [partner({ id: "p1", phone: RIDER })]);
    const l = await luna.submitListing(newListing(), at(12));
    const s = await shareOf(store, l.id);
    await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    assert.equal((await luna.assignManual(s.id, { name: "Suresh" }, { phone: NGO2 }, at(12, 2))).ok, false);
    assert.equal((await luna.assignManual(s.id, { name: "Suresh" }, { phone: NGO1 }, at(12, 2))).ok, true);
    const a = await shareOf(store, l.id);
    assert.equal(a.status, "assigned");
    const suresh = (await store.get("partner", a.partnerId!))!;
    assert.equal(suresh.manual, true);
    assert.equal(suresh.ngoId, "r1");
    assert.match(await last(store, RIDER), /no longer needed/);
    assert.match(await last(store, DONOR), /Suresh, .*Pickup code/);
    assert.equal((await luna.enterCode(a.id, "pickup", a.pickupCode, { phone: RIDER }, at(12, 10))).ok, false);
    assert.equal((await luna.enterCode(a.id, "pickup", a.pickupCode, { phone: NGO1 }, at(12, 10))).ok, true);
    assert.equal((await luna.enterCode(a.id, "drop", a.dropCode, { phone: NGO1 }, at(12, 30))).ok, true);
    assert.equal((await shareOf(store, l.id)).status, "delivered");
  });
});

describe("codes and the trip", () => {
  async function onTrip() {
    const ctx = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 2) })], [partner({ id: "p1", phone: RIDER })]);
    const l = await ctx.luna.submitListing(newListing(), at(12));
    const s = await shareOf(ctx.store, l.id);
    await ctx.luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    await ctx.luna.partnerReply(s.id, true, { phone: RIDER }, at(12, 2));
    return { ...ctx, l, s: await shareOf(ctx.store, l.id) };
  }

  test("3 wrong codes escalate once, then the trip is held", async () => {
    const { store, luna, s } = await onTrip();
    const wrong = s.pickupCode === "1111" ? "2222" : "1111";
    for (let i = 0; i < 5; i++) await luna.enterCode(s.id, "pickup", wrong, { phone: RIDER }, at(12, 10 + i));
    assert.equal((await store.list("decision", { kind: "escalated" })).length, 1);
    assert.equal((await store.get("share", s.id))!.held, true);
    assert.equal((await luna.enterCode(s.id, "pickup", s.pickupCode, { phone: RIDER }, at(12, 20))).ok, false);
  });

  test("codes and location pins over WhatsApp; duplicate deliveries are ignored", async () => {
    const { store, luna, s } = await onTrip();
    const text = (id: string, body: string) => ({ id, from: `91${RIDER}`, type: "text", text: { body } });
    assert.equal(await handleInbound(luna, store, text("wamid.1", s.pickupCode), at(12, 6)), "handled");
    assert.equal(await handleInbound(luna, store, text("wamid.1", s.pickupCode), at(12, 6)), "duplicate");
    assert.equal((await store.get("share", s.id))!.status, "picked_up");
    await handleInbound(luna, store, { id: "wamid.2", from: `91${RIDER}`, type: "location", location: { latitude: 12.93, longitude: 77.63 } }, at(12, 8));
    assert.deepEqual((await store.get("share", s.id))!.lastPos, { lat: 12.93, lng: 77.63 });
    await handleInbound(luna, store, text("wamid.3", s.dropCode), at(12, 12));
    assert.equal((await store.get("share", s.id))!.status, "delivered");
  });

  test("the map shows where the partner is and when they'll arrive", async () => {
    const { luna, s } = await onTrip();
    await luna.enterCode(s.id, "pickup", s.pickupCode, { phone: RIDER }, at(12, 6));
    await luna.location(s.id, east(KORAMANGALA, 1), { phone: RIDER }, at(12, 8));
    const t = await luna.track((await luna.activeTripFor(RIDER))!, at(12, 8));
    assert.equal(t.status, "picked_up");
    assert.ok(t.partner && t.drop && t.eta! > at(12, 8));
    assert.deepEqual(t.containers, ["2 insulated bags"]);
  });

  test("a restart mid-offer resumes from the stored deadline", async () => {
    const { store, luna } = await setup(
      [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) }), recipient({ id: "r2", phone: NGO2, ...east(KORAMANGALA, 3) })],
      [partner({ id: "p1", phone: RIDER })],
    );
    const l = await luna.submitListing(newListing(), at(12));
    const first = await shareOf(store, l.id);
    await createLuna({ store }).tick(first.offerDeadlineAt! + 1);
    assert.equal((await shareOf(store, l.id)).ngoId, "r2");
  });
});

describe("the Decision Agent around it", () => {
  test("a new restaurant's first listing waits for an admin", async () => {
    config.reviewFirstListing = true;
    const { store, luna } = await setup([recipient({ id: "r1", phone: NGO1 })], [partner({ id: "p1", phone: RIDER })]);
    const l = await luna.submitListing(newListing(), at(12));
    assert.equal(l.status, "review");
    assert.equal((await store.list("share")).length, 0);
    assert.equal((await luna.approveListing(l.id, at(12, 3))).ok, true);
    assert.equal((await store.list("share", { listingId: l.id })).length, 1);
  });

  test("sample NGOs and partners nobody has claimed run the whole flow on their own", async () => {
    config.simulateUnclaimed = true;
    const { store, luna } = await setup([recipient({ id: "r1", ...east(KORAMANGALA, 2) })], [partner({ id: "p1", ...east(KORAMANGALA, 1) })]);
    const l = await luna.submitListing(newListing(), at(12));
    for (let t = at(12); t < at(12, 30); t += 10_000) await luna.tick(t);
    assert.equal((await shareOf(store, l.id)).status, "delivered");
    assert.equal((await store.get("listing", l.id))!.status, "closed");
  });

  test("SRS example 4: a delayed partner is redirected to a closer shelter; the first NGO gets priority next time", async () => {
    // The first NGO is far but has been missing out, so it wins the first match.
    const hunger: HungerProvider = { level: (id) => (id === "far" ? "escalate" : "normal") };
    const { store, luna } = await setup(
      [
        recipient({ id: "far", name: "Far NGO", phone: NGO1, ...east(KORAMANGALA, 8) }),
        recipient({ id: "near", name: "Wayside Shelter", kind: "shelter", phone: NGO2, ...east(KORAMANGALA, 5) }),
      ],
      [partner({ id: "p1", name: "Ravi", phone: RIDER, ...east(KORAMANGALA, 0.5) })],
      hunger,
    );
    const t0 = at(18);
    const l = await luna.submitListing(newListing({ items: [item({ name: "dal-rice", grade: "C", safeTime: 70 })] }, t0), t0);
    const s = await shareOf(store, l.id);
    assert.equal(s.ngoId, "far");
    await luna.ngoReply(s.id, true, { phone: NGO1 }, t0 + MIN);
    await luna.partnerReply(s.id, true, { phone: RIDER }, t0 + 2 * MIN);
    const a = await shareOf(store, l.id);
    await luna.enterCode(s.id, "pickup", a.pickupCode, { phone: RIDER }, t0 + 5 * MIN);

    // Stuck in traffic 3 km out, then "Running late".
    await luna.location(s.id, east(KORAMANGALA, 3), { phone: RIDER }, t0 + 30 * MIN);
    assert.equal((await shareOf(store, l.id)).redirect, undefined);
    await luna.late(s.id, { phone: RIDER }, t0 + 31 * MIN);
    const pending = (await shareOf(store, l.id)).redirect!;
    assert.equal(pending.ngoId, "near");
    assert.match(await last(store, NGO2), /^Urgent food offer/);

    assert.equal((await luna.redirectReply(s.id, true, { phone: NGO2 }, t0 + 32 * MIN)).ok, true);
    const moved = await shareOf(store, l.id);
    assert.equal(moved.ngoId, "near");
    assert.notEqual(moved.dropCode, a.dropCode);
    assert.deepEqual((await store.list("credit", { status: "open" })).map((c) => c.recipientId), ["far"]);
    assert.match((await store.list("decision", { kind: "redirected" }))[0].reason, /from Far NGO to Wayside Shelter/);
    assert.match(await last(store, RIDER), /Change of plan: take the food to Wayside Shelter/);
    assert.match(await last(store, NGO2), new RegExp(`drop code is ${moved.dropCode}`));
    assert.match(await last(store, NGO1), /priority on the next listing/);
    assert.equal((await luna.enterCode(s.id, "drop", a.dropCode, { phone: RIDER }, t0 + 40 * MIN)).ok, false, "the old NGO's code no longer works");
    assert.equal((await luna.enterCode(s.id, "drop", moved.dropCode, { phone: RIDER }, t0 + 40 * MIN)).ok, true);
  });
});

test("food listed before an NGO opens is planned to arrive when it opens, so serve-now food still fits", async () => {
  const { store, luna } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1), receivingHours: { start: "08:00", end: "21:00" } })], [partner({ id: "p1", phone: RIDER })]);
  // 6:40 am, Grade C, safe for 2 h 40 min
  const l = await luna.submitListing(newListing({ items: [item({ grade: "C", safeTime: 160 })] }, at(6, 40)), at(6, 40));
  const s = await shareOf(store, l.id);
  assert.equal(s.ngoId, "r1");
  assert.equal(new Date(s.arriveBy! + 330 * 60_000).getUTCHours(), 8, "arrives at 8 am opening");
});

test("servings no NGO could take get another look while still safe, once an NGO can take them", async () => {
  const { store, luna } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1), active: false })], [partner({ id: "p1", phone: RIDER })]);
  const l = await luna.submitListing(newListing(), at(12));
  assert.equal((await store.list("share", { listingId: l.id })).length, 0);
  // the NGO reopens; the next look after the re-plan interval offers it the food
  await store.put("recipient", { ...(await store.get("recipient", "r1"))!, active: true });
  await luna.tick(at(12, 2));
  const s = await shareOf(store, l.id);
  assert.equal(s?.ngoId, "r1"); assert.equal(s?.status, "offering");
  assert.equal((await store.get("listing", l.id))!.unplacedServings, 0);
});

describe("lateness (Decision Agent)", () => {
  test("a late partner's rating drops live and the NGO, the restaurant and the partner are all told", async () => {
    const { store, luna } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 2) })], [partner({ id: "p1", phone: RIDER, ...east(KORAMANGALA, 1) })]);
    const l = await luna.submitListing(newListing(), at(12));
    const s = await shareOf(store, l.id);
    await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    await luna.partnerReply(s.id, true, { phone: RIDER }, at(12, 2));
    const promised = (await shareOf(store, l.id)).promisedArrival!;
    // the partner stays put; well after the promised arrival the tick sees them ~20 min late
    await luna.tick(promised + 20 * MIN);
    const p = (await store.get("partner", "p1"))!;
    assert.ok(p.reliability && p.reliability.score < 4.5, "rating dropped while the trip is still running");
    assert.match(await last(store, NGO1), /running about \d+ min late/);
    assert.match(await last(store, "9800000001"), /running about \d+ min late/);
    assert.match(await last(store, RIDER), /Your reliability: /);
    // delivering on time afterwards would recover; delivering now fixes the late mark
    const sh = await shareOf(store, l.id);
    await luna.enterCode(sh.id, "pickup", sh.pickupCode, { phone: RIDER }, promised + 21 * MIN);
    await luna.enterCode(sh.id, "drop", sh.dropCode, { phone: RIDER }, promised + 30 * MIN);
    const after = (await store.get("partner", "p1"))!.reliability!;
    assert.equal(after.trips, 1); assert.equal(after.onTime, 0);
  });

  test("badly late before pickup with a much faster partner free: the Decision Agent reassigns", async () => {
    const { store, luna } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 2) })],
      [partner({ id: "slow", phone: RIDER, ...east(KORAMANGALA, 1) }), partner({ id: "fast", phone: RIDER2, ...east(KORAMANGALA, 0.3), online: false })]);
    const l = await luna.submitListing(newListing(), at(12));
    const s = await shareOf(store, l.id);
    await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    await luna.partnerReply(s.id, true, { phone: RIDER }, at(12, 2));
    await store.put("partner", { ...(await store.get("partner", "fast"))!, online: true });
    const promised = (await shareOf(store, l.id)).promisedArrival!;
    // the slow partner hasn't moved and keeps saying they're late
    await luna.late(s.id, { phone: RIDER }, promised + 20 * MIN);
    await luna.late(s.id, { phone: RIDER }, promised + 21 * MIN);
    const now = await shareOf(store, l.id);
    assert.equal(now.askedPartnerId, "fast");
    assert.equal(now.status, "finding_partner");
    assert.match(await last(store, RIDER), /passed this pickup to another partner/);
    assert.equal((await store.get("partner", "slow"))!.reliability!.marks[0].kind, "reassigned");
  });
});

test("the Decision Agent keeps the restaurant, the NGO and the partner told at every meaningful step", async () => {
  const DONOR = "9800000001";
  const { store, luna } = await setup(
    [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) }), recipient({ id: "r2", phone: NGO2, ...east(KORAMANGALA, 3) })],
    [partner({ id: "own", phone: RIDER, ngoId: "r2", ...east(KORAMANGALA, 1) })],
  );
  const l = await luna.submitListing(newListing(), at(12));
  assert.match(await last(store, DONOR), /^.*Asked r1 to take/);
  const s = await shareOf(store, l.id);
  await luna.ngoReply(s.id, false, { phone: NGO1 }, at(12, 1));
  const said = await to(store, DONOR);
  assert.ok(said.some((m) => /r1 couldn't take it right now/.test(m)));
  assert.match(said.at(-1)!, /Asked r2 to take/);
  // waiting on r2: after 5 quiet minutes the donor hears "still on it"
  await luna.tick(at(12, 7));
  assert.match(await last(store, DONOR), /Still on it: waiting for r2 to reply/);
  await luna.ngoReply(s.id, true, { phone: NGO2 }, at(12, 8));
  assert.ok((await to(store, NGO2)).some((m) => /Asking .* \(one of your volunteers\)/.test(m)));
  await luna.partnerReply(s.id, true, { phone: RIDER }, at(12, 9));
  const sh = await shareOf(store, l.id);
  await luna.enterCode(sh.id, "pickup", sh.pickupCode, { phone: RIDER }, at(12, 15));
  assert.match(await last(store, NGO2), /picked up the .*Keep your drop code ready/);
});

test("an NGO's rider who helps others can collect for another NGO, after that NGO's own riders", async () => {
  const { store, luna } = await setup(
    [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) }), recipient({ id: "r9", phone: "9000000099", active: false })],
    [partner({ id: "helper", phone: RIDER, ngoId: "r9", helpsOthers: true, ...east(KORAMANGALA, 0.2) }), partner({ id: "loyal", phone: RIDER2, ngoId: "r9", ...KORAMANGALA })],
  );
  const l = await luna.submitListing(newListing(), at(12));
  const s = await shareOf(store, l.id);
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  assert.equal((await shareOf(store, l.id)).askedPartnerId, "helper", "r9's rider who helps others is asked; the one who doesn't is never");
});
