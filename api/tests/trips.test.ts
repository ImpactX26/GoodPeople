import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { TRIP_CONFIG as C } from "../src/trips/config.ts";
import { accept, acceptShare, assignPartner, arrive, canView, createTrip, ingest, pickupCheck, present, redirect, resumeHeld, verifyCode } from "../src/trips/engine.ts";
import { decodePolyline, distance, predict, smoothPosition } from "../src/trips/geo.ts";
import { revealCode } from "../src/trips/codes.ts";
import { memoryTrips, trips } from "../src/trips/repository.ts";
import { mutate, view } from "../src/trips/service.ts";
import { demoRoute, googleRoute, recordedDemoRoute } from "../src/trips/routing.ts";
import { delivery } from "../src/trips/routes.ts";
import { store, type Session } from "../src/store.ts";
import type { TripInput, TripPoint } from "../src/trips/types.ts";

const now = Date.UTC(2026, 9, 7, 13, 30);
const input: TripInput = {
  listingId: "lst_test", shareId: "shr_test", donorPhone: "9000000001", ngoPhone: "9000000002", partnerPhone: "9000000003",
  partnerName: "Sample partner", vehicle: "two_wheeler", food: "Sample food", servings: 10, grade: "A", unsure: true,
  pickup: { lat: 12.9352, lng: 77.6245, name: "Sample pickup", address: "Sample address", area: "Koramangala", notes: "" },
  drop: { lat: 12.9719, lng: 77.6412, name: "Sample drop", address: "Sample address", area: "Indiranagar", notes: "" },
  safeUntil: now + C.sampleSafeMs, collectBy: now + C.sampleCollectMs, maxTransitMin: 90,
  containers: "Two boxes", partnerBringsContainers: true, requestDeadline: now + C.requestWindowMs,
};
const session = (role: Session["role"], phone: string): Session => ({ role, phone, token: role + phone, signedInAt: now });
const donor = session("donor", input.donorPhone), ngo = session("ngo", input.ngoPhone), partner = session("volunteer", input.partnerPhone!);
const point = (pos = input.pickup, at = now): TripPoint => ({ lat: pos.lat, lng: pos.lng, at, accuracyM: 5, heading: 0, speedMps: 0 });
const trip = (id = "dlv_test") => createTrip(structuredClone(input), id, now);
const checked = { servings: 10, photo: "data:image/jpeg;base64,YQ==", smellsNormal: true, noSpoilage: true, temperatureOkay: true, packagingOkay: true };

test("accept → pickup code → food check → drop code completes the canonical leg", () => {
  const t = trip(); accept(t, true, now); ingest(t, [point()], now);
  assert.equal(t.status, "at_pickup");
  assert.equal(verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), point(), now), null);
  assert.equal(t.status, "picked_up"); pickupCheck(t, checked, now);
  assert.equal(t.status, "to_drop"); arrive(t, "drop", now + 20 * 60_000);
  assert.equal(verifyCode(t, "drop", revealCode(t.codes.drop.seal), point(input.drop, now + 20 * 60_000), now + 20 * 60_000), null);
  assert.equal(t.status, "delivered"); assert.ok(t.closedAt);
  assert.ok(t.events.some(e => e.type === "delivery.verified"));
});
test("codes are distinct and only visible to their holder at the correct stage", () => {
  const t = trip(); accept(t, true, now);
  assert.notEqual(revealCode(t.codes.pickup.seal), revealCode(t.codes.drop.seal));
  assert.equal(present(t, donor, now).code, undefined);
  arrive(t, "pickup", now);
  assert.equal(present(t, donor, now).code?.kind, "pickup");
  assert.equal(present(t, partner, now).code, undefined);
  assert.equal(present(t, ngo, now).code, undefined);
  assert.ok(present(t, partner, now).offlineCodes);
  assert.equal(present(t, donor, now).offlineCodes, undefined);
});
test("pending requests hide exact addresses and stranger accounts cannot see the leg", () => {
  const t = trip();
  assert.equal(present(t, partner, now).pickup, null);
  assert.equal(canView(t, session("donor", "9000000009")), false);
  assert.equal(canView(t, session("volunteer", "9000000009")), false);
});
test("donor live location cuts off at pickup +10 minutes while status and NGO tracking continue", () => {
  const t = trip(); accept(t, true, now); t.location = point(); t.pickedUpAt = now; t.status = "to_drop";
  assert.ok(present(t, donor, now + C.donorTrackAfterPickupMs).location);
  const after = present(t, donor, now + C.donorTrackAfterPickupMs + 1);
  assert.equal(after.location, null); assert.equal(after.status, "to_drop");
  assert.ok(present(t, ngo, now + C.donorTrackAfterPickupMs + 1).location);
});
test("completion stops tracking and hides exact addresses after two hours", () => {
  const t = trip(); accept(t, true, now); t.location = point(); t.closedAt = now;
  assert.equal(present(t, partner, now).location, null);
  assert.equal(present(t, partner, now + C.contactAfterCloseMs + 1).drop, null);
});
test("handover 400 m away is rejected; prediction never replaces raw geofence GPS", () => {
  const t = trip(); accept(t, true, now); arrive(t, "pickup", now);
  const far = { ...point(), lat: input.pickup.lat + 0.004 };
  assert.ok(distance(far, input.pickup) > 400);
  assert.throws(() => verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), far, now), /300 metres/);
  assert.equal(t.status, "at_pickup");
});
test("three wrong codes hold the leg and open an escalation; retry cannot bypass the hold", () => {
  const t = trip(); accept(t, true, now); arrive(t, "pickup", now);
  const wrong = revealCode(t.codes.pickup.seal) === "9999" ? "0000" : "9999";
  for (let i = 0; i < 3; i++) assert.ok(verifyCode(t, "pickup", wrong, point(), now));
  assert.equal(t.status, "held"); assert.equal(t.codes.pickup.lockedUntil, now + C.codeLockMs);
  assert.ok(t.events.some(e => e.type === "escalation.opened"));
  assert.throws(() => verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), point(), now + C.codeLockMs + 1), /locked/);
});
test("no-GPS handovers are flagged for review; stale and inaccurate GPS cannot pass as fresh", () => {
  const t = trip(); accept(t, true, now); arrive(t, "pickup", now);
  assert.throws(() => verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), { ...point(), at: now - C.staleMs - 1 }, now), /fresh/);
  assert.throws(() => verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), { ...point(), accuracyM: 500 }, now), /accurate/);
  verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), null, now);
  assert.ok(t.events.some(e => e.type === "handover.no_gps"));
});
test("cannot accept an expired request or accept without required containers", () => {
  assert.throws(() => accept(trip(), false, now), /containers/);
  assert.throws(() => accept(trip(), true, now + C.requestWindowMs + 1), /expired/);
});
test("failed pickup checklist stops the leg and cannot be bypassed", () => {
  const t = trip(); accept(t, true, now); arrive(t, "pickup", now); verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), point(), now);
  pickupCheck(t, { ...checked, noSpoilage: false }, now);
  assert.equal(t.status, "failed_at_pickup"); assert.ok(t.closedAt);
  assert.throws(() => arrive(t, "drop", now), /not active/);
});
test("pickup photo and quantity are required, and a short pickup updates the serving count", () => {
  const t = trip(); accept(t, true, now); arrive(t, "pickup", now); verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), point(), now);
  assert.throws(() => pickupCheck(t, { ...checked, photo: "" }, now), /photo/);
  assert.throws(() => pickupCheck(t, { ...checked, servings: 11 }, now), /listed amount/);
  pickupCheck(t, { ...checked, servings: 8 }, now);
  assert.equal(t.servings, 8); assert.ok(t.events.some(e => e.type === "pickup.short"));
});
test("buffered fixes are ordered and spoofed jumps never change the live position", () => {
  const t = trip(); accept(t, true, now); ingest(t, [point()], now);
  const jump = { ...point(input.drop, now + 10_000), speedMps: 100 };
  assert.equal(ingest(t, [jump], now + 10_000).length, 0); assert.equal(t.location?.lat, input.pickup.lat);
  assert.equal(ingest(t, [point(input.pickup, now - 1000)], now).length, 0);
  assert.ok(t.events.some(e => e.type === "location.flagged"));
});
test("10-minute stationary event is emitted once, despite small GPS jitter", () => {
  const t = trip(); accept(t, true, now); t.status = "to_drop";
  const start = point({ ...input.pickup, lat: input.pickup.lat + 0.01 });
  ingest(t, [start], now);
  ingest(t, [{ ...start, lat: start.lat + 0.00001, at: now + C.stationaryMs }], now + C.stationaryMs);
  ingest(t, [{ ...start, at: now + C.stationaryMs + 10_000 }], now + C.stationaryMs + 10_000);
  assert.equal(t.events.filter(e => e.type === "partner.stationary").length, 1);
});
test("prediction is capped, stops at turns, and freezes for stale/poor fixes", () => {
  const path = [{ lat: 12, lng: 77 }, { lat: 12.001, lng: 77 }, { lat: 12.001, lng: 77.001 }];
  const p = { ...point(), ...path[0], speedMps: 10 };
  const prediction = predict(p, path, now + 10_000);
  assert.ok(distance(prediction, p) <= 30.1); assert.equal(prediction.lng, 77);
  assert.deepEqual(predict(p, path, now + C.staleMs + 1), p);
  assert.deepEqual(predict({ ...p, accuracyM: 100 }, path, now + 1000), { ...p, accuracyM: 100 });
  const corner = { ...p, lat: 12.00099, speedMps: 20 };
  assert.equal(predict(corner, path, now + 3000).lng, 77);
  assert.ok(predict(corner, path, now + 3000).lat <= 12.001);
});
test("Google encoded polyline decoding matches the published coordinate example", () => {
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
  assert.throws(() => decodePolyline("_"), /Invalid/);
});
test("duplicate code attempts commit only once; changed bodies with the same key are rejected", async () => {
  const repo = memoryTrips(), t = trip(); accept(t, true, now); arrive(t, "pickup", now); await repo.create(t);
  const wrong = revealCode(t.codes.pickup.seal) === "9999" ? "0000" : "9999";
  const action = (next: typeof t) => ({ error: verifyCode(next, "pickup", wrong, point(), now) });
  await assert.rejects(mutate(t.id, partner, "same-key", { code: wrong }, action, repo), /Incorrect/);
  await assert.rejects(mutate(t.id, partner, "same-key", { code: wrong }, action, repo), /Incorrect/);
  assert.equal((await repo.get(t.id))?.codes.pickup.tries, 1);
  await assert.rejects(mutate(t.id, partner, "same-key", { code: "1111" }, action, repo), /different request/);
});
test("concurrent accepts allow a partner exactly one active leg", async () => {
  const repo = memoryTrips(), a = trip("dlv_a"), b = trip("dlv_b"); await repo.create(a); await repo.create(b);
  const results = await Promise.allSettled([a, b].map(t => mutate(t.id, partner, t.id, {}, next => accept(next, true, now), repo)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});
test("retention removes stored location and then pickup photos", async () => {
  const repo = memoryTrips(), t = trip(); t.closedAt = now; t.location = point(); t.pickupCheck = checked; await repo.create(t);
  await repo.cleanup(now + C.locationRetentionMs + 1); assert.equal((await repo.get(t.id))?.location, null);
  await repo.cleanup(now + C.photoRetentionMs + 1); assert.equal((await repo.get(t.id))?.pickupCheck?.photo, "");
});
test("Google routing uses motorized two-wheeler traffic and walking uses no traffic option", async () => {
  process.env.GOOGLE_MAPS_ROUTES_KEY = "test-only-key";
  const t = trip(); accept(t, true, now); t.location = point();
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    assert.match((init.headers as Record<string, string>)["X-Goog-FieldMask"], /navigationInstruction/);
    return Response.json({ routes: [{ distanceMeters: 500, duration: "120s", polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }, legs: [{ steps: [{ distanceMeters: 500, navigationInstruction: { instructions: "Turn left", maneuver: "TURN_LEFT" } }] }] }] });
  }) as typeof fetch;
  const result = await googleRoute(t, now, fetcher);
  assert.equal(bodies[0].travelMode, "TWO_WHEELER"); assert.equal(bodies[0].routingPreference, "TRAFFIC_AWARE_OPTIMAL");
  assert.equal(result.steps[0].instruction, "Turn left"); assert.ok(result.warnings.length);
  t.vehicle = "foot"; await googleRoute(t, now, fetcher);
  assert.equal(bodies[1].travelMode, "WALK"); assert.equal(bodies[1].routingPreference, undefined);
  delete process.env.GOOGLE_MAPS_ROUTES_KEY;
});
test("unconfigured routing does not invent a road route or ETA", async () => {
  delete process.env.GOOGLE_MAPS_ROUTES_KEY;
  const t = trip(); t.location = point();
  await assert.rejects(googleRoute(t, now), /not configured/);
});
test("trip middleware preserves the public heat map and rejects anonymous private routes", async () => {
  const app = new Hono(); app.route("/", delivery); app.get("/map/week", c => c.json({ sample: true }));
  assert.equal((await app.request("/map/week")).status, 200);
  assert.equal((await app.request("/trips")).status, 401);
  await store.putSession(partner);
  assert.equal((await app.request("/trips", { headers: { Authorization: `Bearer ${partner.token}` } })).status, 200);
});

test("NGO acceptance reveals the route stops before any partner exists; assignment remains a separate step", () => {
  const t = createTrip({ ...input, partnerPhone: null }, "dlv_waiting", now, true, false);
  assert.equal(present(t, ngo, now).pickup, null);
  assert.throws(() => accept(t, true, now), /NGO must accept/);
  acceptShare(t, now);
  assert.equal(t.requestStatus, "finding_partner");
  assert.ok(present(t, ngo, now).pickup); assert.ok(present(t, donor, now).drop);
  assert.equal(t.location, null); assert.equal(canView(t, partner), false);
  assignPartner(t, partner.phone, "Arjun", "two_wheeler", now);
  assert.equal(t.requestStatus, "pending"); assert.equal(present(t, partner, now).pickup, null);
  accept(t, true, now); assert.equal(t.status, "to_pickup");
});

test("accepted share has a real road preview without GPS; preview never becomes a live ETA", async () => {
  const time = Date.now();
  const t = createTrip({ ...input, partnerPhone: null }, "dlv_preview", time, true);
  await trips.create(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ code: "Ok", routes: [{ distance: 5700, duration: 1000,
    geometry: { coordinates: [[77.6245, 12.9352], [77.6412, 12.9719]] }, legs: [{ steps: [] }] }] })) as typeof fetch;
  try {
    const value = await view(t, ngo, time);
    assert.equal(value.route?.provider, "osrm-demo"); assert.equal(value.route?.preview, true);
    assert.equal(value.location, null); assert.equal(value.eta, null);
    assert.equal(value.route?.target, "drop"); assert.equal(value.requestStatus, "finding_partner");
  } finally { globalThis.fetch = originalFetch; }
});

test("public demo routing cannot be substituted into a real delivery", async () => {
  const t = trip(); t.location = point();
  await assert.rejects(demoRoute(t, now), /cannot be used for a real delivery/);
});
test("recorded demo fallback contains provider road geometry and refuses real trips or unknown roads", () => {
  const t = trip(); t.sample = true; t.status = "to_drop"; t.location = point();
  const route = recordedDemoRoute(t, now);
  assert.ok(route?.recordedAt); assert.ok(route!.path.length > 100); assert.match(route!.warnings[0], /Recorded/);
  t.sample = false; assert.equal(recordedDemoRoute(t, now), null);
  t.sample = true; t.location = { ...point(), lat: 13.1 }; assert.equal(recordedDemoRoute(t, now), null);
  t.location = point(); t.drop = { ...t.drop, lng: 77.8 }; assert.equal(recordedDemoRoute(t, now), null);
});

const redirectInput = () => ({ shareId: "shr_redirect", ngoPhone: "9000000008", drop: { ...input.drop, lat: 12.945, name: "New NGO" },
  etaDrop: now + 600_000, serveAt: now + 900_000, eligibilityCheckedAt: now, reason: "A nearer eligible NGO accepted" });
const pickedUpTrip = () => { const t = trip(); accept(t, true, now); arrive(t, "pickup", now); verifyCode(t, "pickup", revealCode(t.codes.pickup.seal), point(), now); pickupCheck(t, checked, now); return t; };

test("redirect rotates the drop code, revokes the old NGO and invalidates route geometry", () => {
  const t = pickedUpTrip(), oldCode = revealCode(t.codes.drop.seal);
  redirect(t, redirectInput(), now);
  assert.equal(t.routeRevision, 2); assert.equal(t.eta, null);
  assert.equal(canView(t, ngo), false); assert.ok(canView(t, session("ngo", "9000000008")));
  assert.notEqual(revealCode(t.codes.drop.seal), oldCode);
  assert.throws(() => present(t, ngo, now), /not found/);
  assert.equal(t.status, "to_drop");
});

test("redirect cannot extend safety, bypass transit limits, skip eligibility or redirect at handover", () => {
  const t = pickedUpTrip();
  assert.throws(() => redirect(t, { ...redirectInput(), serveAt: t.safeUntil + 1 }, now), /safe-until/);
  assert.throws(() => redirect(t, { ...redirectInput(), etaDrop: now + 91 * 60_000, serveAt: now + 92 * 60_000 }, now), /transit/);
  assert.throws(() => redirect(t, { ...redirectInput(), eligibilityCheckedAt: now - C.eligibilityFreshMs - 1 }, now), /eligibility/);
  t.grade = "C";
  assert.throws(() => redirect(t, { ...redirectInput(), serveAt: now + 600_000 + C.gradeCServeMs + 1 }, now), /60 minutes/);
  t.status = "at_drop"; assert.throws(() => redirect(t, redirectInput(), now), /on its way/);
});

test("held legs keep raw GPS; resuming requires the code lock to expire and an audit reason", () => {
  const t = trip(); accept(t, true, now); arrive(t, "pickup", now);
  const wrong = revealCode(t.codes.pickup.seal) === "9999" ? "0000" : "9999";
  for (let i = 0; i < 3; i++) verifyCode(t, "pickup", wrong, point(), now);
  assert.equal(ingest(t, [point(input.pickup, now + 1000)], now + 1000).length, 1);
  assert.equal(t.status, "held"); assert.throws(() => resumeHeld(t, "Coordinator reviewed", now), /10-minute/);
  resumeHeld(t, "Coordinator reviewed the handover", now + C.codeLockMs + 1);
  assert.equal(t.status, "at_pickup"); assert.equal(t.codes.pickup.tries, 0);
  assert.ok(t.events.some(e => e.type === "escalation.resolved"));
});

test("old offline handovers cannot complete a redirected destination", async () => {
  const time = Date.now(), t = pickedUpTrip(); t.id = "dlv_old_route";
  redirect(t, redirectInput(), now); t.acceptedAt = time - 1000; t.safeUntil = time + C.sampleSafeMs;
  await trips.create(t); await store.putSession(partner);
  const response = await delivery.request(`/partner/legs/${t.id}/arrived`, { method: "POST", headers: { Authorization: `Bearer ${partner.token}`, "Content-Type": "application/json", "Idempotency-Key": "old-route" }, body: JSON.stringify({ kind: "drop", routeRevision: 1, occurredAt: time }) });
  assert.equal(response.status, 409); assert.match((await response.json()).error, /destination changed/);
  assert.equal((await trips.get(t.id))?.status, "to_drop");
});

test("marker smoothing follows road corners instead of cutting diagonally through buildings", () => {
  const path = [{ lat: 12, lng: 77 }, { lat: 12.001, lng: 77 }, { lat: 12.001, lng: 77.001 }];
  const middle = smoothPosition(path[0], path[2], path, .5);
  assert.ok(middle.lng === 77 || middle.lat === 12.001);
  assert.ok(distance(middle, path[1]) < 2);
});

test("delivery bodies exceeding the photo envelope are rejected before processing", async () => {
  const response = await delivery.request("/partner/legs/dlv_test/pickup-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photo: "x".repeat(C.maxRequestBytes) }) });
  assert.equal(response.status, 413);
});

test("service-authenticated NGO handoff creates tracking before a separate partner request", async () => {
  const previous = process.env.LOGISTICS_HANDOFF_KEY; process.env.LOGISTICS_HANDOFF_KEY = "integration-test-key";
  const time = Date.now(), handoff = { ...input, listingId: "lst_handoff", shareId: "shr_handoff", donorPhone: "9000000101", ngoPhone: "9000000102", partnerPhone: null,
    safeUntil: time + C.sampleSafeMs, collectBy: time + C.sampleCollectMs, requestDeadline: time + C.requestWindowMs };
  const rider = session("volunteer", "9000000103"), restaurant = session("donor", handoff.donorPhone);
  for (const [role, phone] of [["donor", handoff.donorPhone], ["ngo", handoff.ngoPhone], ["volunteer", rider.phone]] as const)
    await store.putProfile({ role, phone, fields: { name: role === "volunteer" ? "Arjun" : role }, createdAt: time });
  await store.putSession(rider); await store.putSession(restaurant);
  const headers = { Authorization: "Bearer integration-test-key", "Content-Type": "application/json", "Idempotency-Key": "ngo-acceptance" };
  try {
    assert.equal((await delivery.request("/internal/delivery-legs", { method: "POST", body: JSON.stringify(handoff) })).status, 401);
    const response = await delivery.request("/internal/delivery-legs", { method: "POST", headers, body: JSON.stringify(handoff) });
    assert.equal(response.status, 201); const result = await response.json();
    assert.equal(result.trackingUrl, `/deliveries?id=${result.id}`);
    const waiting = await trips.get(result.id); assert.equal(waiting?.requestStatus, "finding_partner"); assert.ok(waiting?.shareAcceptedAt);
    assert.ok(present(waiting!, restaurant, time).pickup); assert.equal(waiting?.location, null);
    assert.equal((await delivery.request(`/trips/${result.id}`, { headers: { Authorization: `Bearer ${rider.token}` } })).status, 404);
    const assign = await delivery.request(`/internal/delivery-legs/${result.id}/assign`, { method: "POST", headers: { ...headers, "Idempotency-Key": "candidate-selected" }, body: JSON.stringify({ partnerPhone: rider.phone, vehicle: "two_wheeler" }) });
    assert.equal(assign.status, 200); assert.equal((await trips.get(result.id))?.requestStatus, "pending");
    const accepted = await delivery.request(`/partner/requests/${result.id}/accept`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${rider.token}`, "Idempotency-Key": "partner-accepts" }, body: JSON.stringify({ hasContainers: true }) });
    assert.equal(accepted.status, 200); assert.equal((await accepted.json()).status, "to_pickup");
  } finally { if (previous === undefined) delete process.env.LOGISTICS_HANDOFF_KEY; else process.env.LOGISTICS_HANDOFF_KEY = previous; }
});
