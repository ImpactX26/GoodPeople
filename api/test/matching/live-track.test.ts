/**
 * The live map for a delivery: GPS fixes keep their speed (worked out when the phone doesn't say), each side
 * sees the partner only when spec §12.7 allows, and the ETA follows the route.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { config } from "../../src/matching/config.ts";
import { liveTrack } from "../../src/matching/live-track.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import { at, east, KORAMANGALA, listing, MIN, partner, recipient } from "./fixtures.ts";

const NGO = "9000000001", RIDER = "9000000003";

beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
  process.env.LUNA_MAP_FALLBACK = "off";   // no network router in tests
  delete process.env.GOOGLE_MAPS_ROUTES_KEY;
});

async function onTrip() {
  const store = memoryMatchingStore();
  await store.put("recipient", recipient({ id: "r1", name: "Hope Shelter", phone: NGO, ...east(KORAMANGALA, 3) }));
  await store.put("partner", partner({ id: "p1", name: "Ravi", phone: RIDER, ...east(KORAMANGALA, 1) }));
  const luna = createLuna({ store });
  const { id: _id, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: at(12) });
  const l = await luna.submitListing(rest as NewListing, at(12));
  const [s] = await store.list("share", { listingId: l.id });
  await luna.ngoReply(s.id, true, { phone: NGO }, at(12, 1));
  await luna.partnerReply(s.id, true, { phone: RIDER }, at(12, 2));
  return { store, luna, shareId: s.id };
}

describe("the live map", () => {
  test("a fix keeps its accuracy and heading; a missing speed is worked out from the last fix", async () => {
    const { store, luna, shareId } = await onTrip();
    const a = east(KORAMANGALA, 1);
    await luna.location(shareId, a, { phone: RIDER }, at(12, 3), { accuracyM: 8, speedMps: null, heading: 90 });
    const b = { lat: a.lat, lng: a.lng + 0.0005 };   // about 54 m east
    await luna.location(shareId, b, { phone: RIDER }, at(12, 3) + 10_000, { accuracyM: 8, speedMps: null, heading: 90 });
    const fix = (await store.get("share", shareId))!.lastFix!;
    assert.equal(fix.accuracyM, 8);
    assert.equal(fix.heading, 90);
    assert.ok(fix.speedMps! > 3 && fix.speedMps! < 8, `about 5.4 m/s, got ${fix.speedMps}`);
  });

  test("the partner and the NGO see the partner; the restaurant only until 10 minutes after pickup", async () => {
    const { store, luna, shareId } = await onTrip();
    await luna.location(shareId, east(KORAMANGALA, 1), { phone: RIDER }, at(12, 3));
    let share = (await store.get("share", shareId))!;
    for (const viewer of ["partner", "ngo", "donor"] as const) {
      const v = await liveTrack(store, share, viewer, at(12, 3));
      assert.equal(v.status, "to_pickup");
      assert.equal(v.locationVisible, true, viewer);
      assert.ok(v.location, viewer);
      assert.match(v.routeError ?? "", /Google Maps key/, "no route without a key when the fallback is off");
    }
    await luna.enterCode(shareId, "pickup", share.pickupCode, { phone: RIDER }, at(12, 10));
    await luna.location(shareId, east(KORAMANGALA, 2), { phone: RIDER }, at(12, 15));
    share = (await store.get("share", shareId))!;
    assert.equal((await liveTrack(store, share, "donor", at(12, 15))).locationVisible, true, "5 min after pickup");
    const later = await liveTrack(store, share, "donor", at(12, 10) + 11 * MIN);
    assert.equal(later.locationVisible, false, "11 min after pickup the restaurant stops seeing the partner");
    assert.equal(later.location, null);
    assert.equal((await liveTrack(store, share, "ngo", at(12, 10) + 11 * MIN)).locationVisible, true);
  });
});
