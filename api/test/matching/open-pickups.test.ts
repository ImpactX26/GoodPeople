/**
 * A partner who misses the ask isn't shut out: an accepted pickup nobody has taken sits on the open pickups
 * board for every partner who can reach it, and anyone (including whoever missed it) can take it. If nobody does
 * for a while, it moves to the next NGO that has a partner free, and the first NGO is told why.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { config } from "../../src/matching/config.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import type { Partner, Recipient } from "../../src/matching/types.ts";
import { at, east, KORAMANGALA, listing, MIN, partner, recipient } from "./fixtures.ts";

const NGO1 = "9000000001", NGO2 = "9000000002", ME = "9000000003", OTHER = "9000000004";

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});

async function setup(recipients: Recipient[], partners: Partner[]) {
  const store = memoryMatchingStore();
  for (const r of recipients) await store.put("recipient", r);
  for (const p of partners) await store.put("partner", p);
  const luna = createLuna({ store });
  const { id: _i, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(12), collectBy: at(14) });
  const l = await luna.submitListing(rest as NewListing, at(12));
  const share = () => store.list("share", { listingId: l.id }).then((x) => x[0]);
  const texts = async (phone: string) => (await store.list("outbox")).filter((m) => m.to === phone).map((m) => m.text);
  return { store, luna, l, share, texts };
}

test("everyone misses the ask: the pickup goes on the open board, and a partner who missed it can take it", async () => {
  const { luna, share, texts } = await setup(
    [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) })],
    [partner({ id: "me", phone: ME, ngoId: "r1", helpsOthers: true, ...east(KORAMANGALA, 0.5) }), partner({ id: "other", phone: OTHER, ...east(KORAMANGALA, 1) })],
  );
  const s = await share();
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  await luna.tick((await share()).askDeadlineAt! + 1);   // I miss it
  await luna.tick((await share()).askDeadlineAt! + 1);   // so does the other partner
  const waiting = await share();
  assert.equal(waiting.status, "finding_partner");
  assert.equal(waiting.askedPartnerId, undefined);

  const board = await luna.openPickups(ME, at(12, 6));
  assert.equal(board.length, 1);
  assert.equal(board[0].missed, true, "marked as one I missed");
  assert.ok((await texts(ME)).some((t) => /Pickup still open/.test(t)), "a heads-up reaches those who missed it");

  assert.ok((await luna.claimPickup(s.id, { phone: ME }, at(12, 7))).ok);
  const taken = await share();
  assert.equal(taken.status, "assigned");
  assert.equal(taken.partnerId, "me");
  assert.equal((await luna.claimPickup(s.id, { phone: OTHER }, at(12, 7))).ok, false, "first come");
  assert.equal((await luna.openPickups(OTHER, at(12, 8))).length, 0);
});

test("nobody takes it for a while: it moves to the next NGO with a partner free, and the first NGO is told why", async () => {
  const { luna, share, texts, store } = await setup(
    [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) }), recipient({ id: "r2", phone: NGO2, ...east(KORAMANGALA, 2) })],
    [partner({ id: "p1", phone: ME, ...east(KORAMANGALA, 0.5) })],
  );
  const s = await share();
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  await luna.partnerReply(s.id, false, { phone: ME }, at(12, 2));
  const since = (await share()).waitingForPartnerSince!;
  await luna.tick(since + config.partnerWaitBeforeNextNgoMs - MIN);
  assert.equal((await share()).ngoId, "r1", "still waiting inside the window");

  await luna.tick(since + config.partnerWaitBeforeNextNgoMs + 1);
  const moved = await share();
  assert.equal(moved.status, "offering");
  assert.equal(moved.ngoId, "r2", "offered to the next NGO without asking r1");
  assert.ok((await texts(NGO1)).some((t) => /passed it to another NGO/.test(t) && /Nothing for you to do/.test(t)));
  assert.ok((await texts(NGO2)).some((t) => /^Food offer/.test(t)));
  assert.ok((await store.list("decision")).some((d) => d.kind === "replanned" && /moves to/.test(d.reason)));
});

test("with no other NGO to move to, it stays on the open board", async () => {
  const { luna, share } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) })], [partner({ id: "p1", phone: ME, ...east(KORAMANGALA, 0.5) })]);
  const s = await share();
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  await luna.partnerReply(s.id, false, { phone: ME }, at(12, 2));
  await luna.tick(at(12, 30));
  assert.equal((await share()).status, "finding_partner");
  assert.equal((await luna.openPickups(ME, at(12, 31))).length, 1);
});

test("a partner too far to make the collect-by time still sees the pickup, marked late, and can take it", async () => {
  const { luna, share } = await setup(
    [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) })],
    [partner({ id: "near", phone: OTHER, ...east(KORAMANGALA, 0.5) }), partner({ id: "far", phone: ME, ...east(KORAMANGALA, 9) })],
  );
  const s = await share();
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  await luna.partnerReply(s.id, false, { phone: OTHER }, at(13, 50));
  const [mine] = await luna.openPickups(ME, at(13, 51));
  assert.ok(mine, "shown, not hidden");
  assert.equal(mine.reach.late, true);
  assert.equal(mine.reach.unsafe, false);
  assert.ok((await luna.claimPickup(s.id, { phone: ME }, at(13, 52))).ok);
});

test("an NGO holds accepted food at most 30 minutes, even while partners are still being asked one by one", async () => {
  const many = Array.from({ length: 12 }, (_, i) => partner({ id: `p${i}`, phone: `90000001${String(i).padStart(2, "0")}`, ...east(KORAMANGALA, 0.3 + i * 0.05) }));
  const { luna, share, texts } = await setup(
    [recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) }), recipient({ id: "r2", phone: NGO2, ...east(KORAMANGALA, 2) })],
    many,
  );
  const s = await share();
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  for (let m = 4; m < 31; m += 3) await luna.tick(at(12, m));   // ask after ask runs out
  const still = await share();
  assert.equal(still.ngoId, "r1", "within 30 minutes it stays");
  assert.ok(still.askedPartnerId, "someone is being asked right now");
  await luna.tick(at(12, 31) + 1);
  const moved = await share();
  assert.equal(moved.status, "offering");
  assert.equal(moved.ngoId, "r2");
  assert.ok((await texts(NGO1)).some((t) => /passed it to another NGO/.test(t)));
});

test("only one NGO and nobody takes the pickup: its hold still ends at 30 minutes, and the food goes back to the restaurant", async () => {
  const { luna, share, texts, store, l } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) })], [partner({ id: "p1", phone: ME, ...east(KORAMANGALA, 0.5) })]);
  const s = await share();
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  await luna.partnerReply(s.id, false, { phone: ME }, at(12, 2));
  await luna.tick(at(12, 30));
  assert.equal((await share()).status, "finding_partner", "still held at 29 minutes");
  await luna.tick(at(12, 31) + 1);
  assert.equal((await share()).status, "unplaced");
  assert.ok((await texts(NGO1)).some((t) => /released it/.test(t)));
  const { leftoverOf } = await import("../../src/matching/biogas.ts");
  assert.ok((await leftoverOf(store, (await store.get("listing", l.id))!)).servings > 0, "it's the restaurant's to send elsewhere (biogas) now");
});

test("the partner taps Running late: the Decision Agent tells the NGO, the restaurant and the partner, once", async () => {
  const { luna, share, texts, store, l } = await setup([recipient({ id: "r1", phone: NGO1, ...east(KORAMANGALA, 1) })], [partner({ id: "p1", phone: ME, ...east(KORAMANGALA, 0.5) })]);
  const s = await share();
  await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
  await luna.partnerReply(s.id, true, { phone: ME }, at(12, 2));
  assert.ok((await luna.late(s.id, { phone: ME }, at(12, 3))).ok);
  const ngoHeard = (await texts(NGO1)).filter((t) => /running about \d+ min late/.test(t));
  const donorHeard = (await texts(l.donorPhone)).filter((t) => /running about \d+ min late/.test(t));
  assert.equal(ngoHeard.length, 1, "the NGO is told");
  assert.equal(donorHeard.length, 1, "the restaurant is told (not collected yet)");
  assert.ok((await texts(ME)).some((t) => /Thanks for the heads-up/.test(t)));
  assert.ok((await store.list("decision", { listingId: l.id })).some((d) => d.agent === "decision" && d.kind === "delayed" && /warned/.test(d.reason)));
  await luna.tick(at(12, 4));
  assert.equal((await texts(NGO1)).filter((t) => /running about \d+ min late/.test(t)).length, 1, "not told twice");
});
