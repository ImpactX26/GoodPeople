import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { store, type Session } from "../src/store.ts";
import { food, handOff, tripId } from "../src/listings/routes.ts";
import type { Scenario } from "../src/listings/scenario.ts";
import type { ListingInput, ListingView } from "../src/listings/types.ts";
import { listings } from "../src/listings/repository.ts";
import { delivery } from "../src/trips/routes.ts";
import { acceptShare, canView, present } from "../src/trips/engine.ts";
import { memoryTrips, trips } from "../src/trips/repository.ts";
import { advanceNgoOffer, assertOfferOpen, offerWindowMs, tickNgoOffers } from "../src/listings/offers.ts";
import { applyFoodCheck, requestFoodCheck } from "../src/listings/foodCheck.ts";

process.env.ENABLE_TRIP_DEMO = "1";
const app = new Hono().route("/", delivery).route("/", food);
const request = (path: string, session?: Session, body?: unknown, key = randomUUID()) => app.request(path, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), "Content-Type": "application/json", "Idempotency-Key": key },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
async function accounts() {
  const response = await request("/app-demo/start", undefined, {});
  assert.equal(response.status, 201);
  return await response.json() as Scenario;
}
function input(s: Scenario): ListingInput {
  const now = Date.now(), f = s.profiles.donor.fields;
  return { dish: "Vegetable biryani", diet: "veg", jain: false, halal: "unsure", contains: ["dairy", "onion_garlic"], spice: "medium",
    entryMode: "per_person_pack", count: 10, feedsEach: 1, photo: "data:image/jpeg;base64,YQ==", cookedAt: now - 15 * 60_000,
    storage: "hot", readyFrom: now, collectBy: now + 60 * 60_000, containers: "donor_packs", declarationAccepted: true,
    pickup: { name: f.org, address: f.address, area: f.area, notes: f.notes, lat: Number(f.lat), lng: Number(f.lng) }, contactName: f.name, contactPhone: s.sessions.donor.phone };
}
async function offer() {
  const s = await accounts(), submitted = await request("/listings", s.sessions.donor, input(s));
  assert.equal(submitted.status, 201);
  const { id } = await submitted.json();
  const reviewed = await request(`/listings/${id}/approve`, s.sessions.admin, { reason: "Checked the first food listing, photo, ingredients and timings." });
  assert.equal(reviewed.status, 200);
  return { s, id: id as string, leg: tripId(id) };
}
async function acceptOffer(o: Awaited<ReturnType<typeof offer>>) {
  const response = await request(`/offers/${o.id}/accept`, o.s.sessions.ngo, {});
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).trackingUrl, `/deliveries?id=${o.leg}`);
}

test("walkthrough provisions normal accounts, with no pre-created listing or trip", async () => {
  const before = (await listings.list()).length, beforeTrips = (await trips.list()).length, s = await accounts();
  assert.equal((await listings.list()).length, before);
  assert.equal((await trips.list()).length, beforeTrips);
  assert.equal(s.volunteers.length, 3);
  for (const v of s.volunteers) {
    assert.equal((await store.getSession(v.session.token))?.phone, v.profile.phone);
    assert.equal(v.profile.fields.affiliatedNgo, s.sessions.ngo.phone);
    assert.equal(v.profile.fields.online, "true");
  }
});
test("first listing requires review, retry keys preserve one listing and other accounts cannot review it", async () => {
  const s = await accounts(), body = input(s), key = randomUUID();
  const first = await request("/listings", s.sessions.donor, body, key), { id } = await first.json();
  assert.equal((await request("/listings", s.sessions.donor, body, key)).status, 201);
  assert.equal((await listings.list()).filter(l => l.donorPhone === s.sessions.donor.phone).length, 1);
  assert.equal((await request("/listings", s.sessions.donor, { ...body, count: 9 }, key)).status, 409);
  assert.equal((await listings.get(id))?.state, "in_review");
  assert.equal(await trips.get(tripId(id)), null);
  assert.equal((await request(`/listings/${id}/approve`, s.sessions.ngo, { reason: "Not a reviewer" })).status, 403);
  assert.equal((await request("/offers", s.sessions.ngo)).status, 200);
  assert.deepEqual((await (await request("/offers", s.sessions.ngo)).json()).offers, []);
  assert.equal((await request("/listings", s.sessions.ngo, body)).status, 403);
  assert.equal((await request("/listings")).status, 401);
});
test("approval creates an offer with safety assessment, hides exact pins and excludes unrelated NGOs", async () => {
  const o = await offer(), response = await request("/offers", o.s.sessions.ngo), data = await response.json();
  const value = data.offers[0] as ListingView;
  assert.equal(value.id, o.id); assert.equal(value.assessment?.grade, "A");
  assert.equal(value.assessment?.unsure, true); assert.equal(value.assessment?.servings, 10);
  assert.equal(value.pickup, null); assert.equal(value.trackingUrl, null);
  assert.equal("contactPhone" in value, false); assert.equal("fingerprint" in value, false);
  const unrelated = await accounts();
  assert.equal((await request(`/listings/${o.id}`, unrelated.sessions.ngo)).status, 404);
  assert.equal((await request(`/offers/${o.id}/accept`, unrelated.sessions.ngo, {})).status, 404);
});
test("NGO acceptance immediately opens tracking and automatically broadcasts to all three volunteers", async () => {
  const o = await offer(); await acceptOffer(o);
  const t = (await trips.get(o.leg))!;
  assert.ok(t.shareAcceptedAt); assert.equal(t.partnerPhone, null); assert.equal(t.requestStatus, "pending");
  assert.deepEqual(new Set(t.candidatePhones), new Set(o.s.volunteers.map(v => v.session.phone)));
  assert.ok(present(t, o.s.sessions.ngo, Date.now()).pickup);
  for (const v of o.s.volunteers) {
    const { requests } = await (await request("/partner/requests", v.session)).json();
    assert.equal(requests.length, 1); assert.equal(requests[0].id, o.leg);
    assert.equal(requests[0].pickup, null); assert.equal(requests[0].drop, null);
    assert.equal(requests[0].code, undefined); assert.equal(requests[0].offlineCodes, undefined);
  }
  const repeated = await request(`/offers/${o.id}/accept`, o.s.sessions.ngo, {});
  assert.equal(repeated.status, 409);
  assert.equal((await trips.get(o.leg))!.events.filter(e => e.type === "partner.requested").length, 1);
  assert.equal((await request(`/trips/${o.leg}/sample/assign`, o.s.sessions.ngo, {})).status, 404);
});
test("first volunteer acceptance wins a concurrent claim and withdraws every other volunteer's access", async () => {
  const o = await offer(); await acceptOffer(o);
  const responses = await Promise.all(o.s.volunteers.map(v => request(`/partner/requests/${o.leg}/accept`, v.session, { hasContainers: false })));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  const t = (await trips.get(o.leg))!;
  assert.equal(t.requestStatus, "accepted"); assert.equal(t.status, "to_pickup"); assert.deepEqual(t.candidatePhones, []);
  assert.equal(t.events.filter(e => e.type === "partner.assigned").length, 1);
  for (const v of o.s.volunteers.filter(v => v.session.phone !== t.partnerPhone)) {
    assert.deepEqual((await (await request("/partner/requests", v.session)).json()).requests, []);
    assert.equal((await request(`/trips/${o.leg}`, v.session)).status, 404);
  }
});
test("one volunteer declining does not cancel requests for the others", async () => {
  const o = await offer(); await acceptOffer(o);
  assert.equal((await request(`/partner/requests/${o.leg}/decline`, o.s.volunteers[0].session, {})).status, 200);
  const t = (await trips.get(o.leg))!;
  assert.equal(t.requestStatus, "pending"); assert.equal(t.candidatePhones?.length, 2);
  assert.deepEqual((await (await request("/partner/requests", o.s.volunteers[0].session)).json()).requests, []);
  assert.equal((await request(`/partner/requests/${o.leg}/accept`, o.s.volunteers[1].session, {})).status, 200);
});
test("offline, undersized and busy volunteers receive no automatic request", async () => {
  const o = await offer();
  const offline = o.s.volunteers[0].profile, undersized = o.s.volunteers[1].profile;
  await store.putProfile({ ...offline, fields: { ...offline.fields, online: "false" } });
  await store.putProfile({ ...undersized, fields: { ...undersized.fields, capacity: "5" } });
  await acceptOffer(o);
  assert.deepEqual((await trips.get(o.leg))!.candidatePhones, [o.s.volunteers[2].session.phone]);
  assert.equal((await request(`/partner/requests/${o.leg}/accept`, o.s.volunteers[2].session, {})).status, 200);
  const submitted = await request("/listings", o.s.sessions.donor, input(o.s));
  const { id } = await submitted.json();
  const second = await request(`/offers/${id}/accept`, o.s.sessions.ngo, {});
  assert.equal(second.status, 200); // Map still opens; the upstream agent owns continuing the search.
  assert.equal((await trips.get(tripId(id)))?.requestStatus, "finding_partner");
  assert.deepEqual((await (await request("/partner/requests", o.s.volunteers[2].session)).json()).requests, []);
});
test("actual listing completes through both codes, food photo/check and NGO confirmation with a donor receipt", async () => {
  const o = await offer(); await acceptOffer(o);
  const rider = o.s.volunteers[0].session;
  assert.equal((await request(`/partner/requests/${o.leg}/accept`, rider, {})).status, 200);
  const action = (name: string, body: unknown) => request(`/partner/legs/${o.leg}/${name}`, rider, body);
  assert.equal((await action("arrived", { kind: "pickup" })).status, 200);
  const pickup = present((await trips.get(o.leg))!, o.s.sessions.donor, Date.now()).code!.value;
  assert.equal((await action("code", { kind: "pickup", code: pickup, point: { ...(await trips.get(o.leg))!.pickup, at: Date.now(), accuracyM: 5, speedMps: 0, heading: 0 } })).status, 200);
  assert.equal((await action("pickup-check", { servings: 10, photo: "data:image/jpeg;base64,YQ==", smellsNormal: true, noSpoilage: true, temperatureOkay: true, packagingOkay: true })).status, 200);
  assert.equal((await request(`/trips/${o.leg}/receipt`, o.s.sessions.ngo, { servings: 10, problem: "" })).status, 409);
  assert.equal((await action("arrived", { kind: "drop" })).status, 200);
  const drop = present((await trips.get(o.leg))!, o.s.sessions.ngo, Date.now()).code!.value;
  assert.notEqual(pickup, drop);
  assert.equal((await action("code", { kind: "drop", code: drop, point: { ...(await trips.get(o.leg))!.drop, at: Date.now(), accuracyM: 5, speedMps: 0, heading: 0 } })).status, 200);
  assert.equal((await request(`/trips/${o.leg}/receipt`, o.s.sessions.donor, { servings: 10, problem: "" })).status, 400);
  assert.equal((await request(`/trips/${o.leg}/receipt`, o.s.sessions.ngo, { servings: 11, problem: "" })).status, 409);
  const key = randomUUID(), receipt = { servings: 9, problem: "One meal box was missing." };
  assert.equal((await request(`/trips/${o.leg}/receipt`, o.s.sessions.ngo, receipt, key)).status, 200);
  assert.equal((await request(`/trips/${o.leg}/receipt`, o.s.sessions.ngo, receipt, key)).status, 200);
  const value = await (await request(`/listings/${o.id}`, o.s.sessions.donor)).json() as ListingView;
  assert.equal(value.progress, "Delivered"); assert.equal(value.assessment?.servings, 9);
  assert.ok(value.deliveredAt); assert.equal(value.recipientName, "Udaya Community Kitchen");
  const t = (await trips.get(o.leg))!;
  assert.ok(t.events.some(e => e.type === "escalation.opened"));
  assert.equal(t.events.filter(e => e.type === "ngo.receipt_confirmed").length, 1);
  assert.equal(present(t, o.s.sessions.donor, Date.now()).location, null);
});
test("expired rice and inconsistent Jain tags cannot be offered by the sample fixture", async () => {
  const s = await accounts(), expired = { ...input(s), storage: "room", cookedAt: Date.now() - 5 * 60 * 60_000 };
  const { id } = await (await request("/listings", s.sessions.donor, expired)).json();
  assert.equal((await request(`/listings/${id}/approve`, s.sessions.admin, { reason: "Review reveals expired rice." })).status, 200);
  const saved = await listings.get(id);
  assert.equal(saved?.state, "not_for_people"); assert.equal(saved?.foodCheck?.grade, "D"); assert.equal(saved?.assessment, null);
  assert.equal(await trips.get(tripId(id)), null);
  assert.equal((await request("/listings", s.sessions.donor, { ...input(s), jain: true })).status, 400);
});
test("demo session provisioning and current-account disclosure are disabled on persistent APIs", async () => {
  const db = process.env.DATABASE_URL, enabled = process.env.ENABLE_TRIP_DEMO;
  try {
    process.env.DATABASE_URL = "production-guard";
    assert.equal((await request("/app-demo/start", undefined, {})).status, 403);
    assert.equal((await request("/app-demo/current")).status, 403);
    delete process.env.DATABASE_URL; process.env.ENABLE_TRIP_DEMO = "0";
    assert.equal((await request("/app-demo/start", undefined, {})).status, 403);
  } finally {
    if (db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = db;
    if (enabled === undefined) delete process.env.ENABLE_TRIP_DEMO; else process.env.ENABLE_TRIP_DEMO = enabled;
  }
});

test("NGO countdown follows the safety formula and survives reconnects without resetting", async () => {
  const now = Date.now();
  assert.equal(offerWindowMs(now + 90 * 60_000, now), 10 * 60_000);
  assert.equal(offerWindowMs(now + 30 * 60_000, now), 5 * 60_000);
  assert.equal(offerWindowMs(now + 15 * 60_000, now), 150_000);
  assert.equal(offerWindowMs(now + 5 * 60_000, now), 2 * 60_000);
  const o = await offer(), t = (await trips.get(o.leg))!;
  const deadline = t.offer!.deadline;
  const first = await (await request("/offers", o.s.sessions.ngo)).json();
  const reconnect = await (await request("/offers", o.s.sessions.ngo)).json();
  assert.equal(first.offers[0].offerDeadline, deadline);
  assert.equal(reconnect.offers[0].offerDeadline, deadline);
  assert.ok(reconnect.offers[0].serverNow <= deadline);
  assert.equal((await (await request("/offers", o.s.ngos[1].session)).json()).offers.length, 0);
});
test("persisted NGO offer ticks remind once, wait until the deadline, then advance exactly once under concurrent workers", async () => {
  const o = await offer(), t = (await trips.get(o.leg))!, repo = memoryTrips();
  // A restarted worker reads the stored absolute deadline; no setTimeout state is needed.
  await repo.create(structuredClone(t));
  const deadline = t.offer!.deadline, half = (deadline + t.offer!.sentAt) / 2;
  await tickNgoOffers(half, repo); await tickNgoOffers(half + 1, repo);
  assert.equal((await repo.get(t.id))!.events.filter(e => e.type === "offer.reminder").length, 1);
  await tickNgoOffers(deadline - 1, repo);
  assert.equal((await repo.get(t.id))!.ngoPhone, o.s.sessions.ngo.phone);
  await Promise.all([tickNgoOffers(deadline, repo), tickNgoOffers(deadline, repo)]);
  const next = (await repo.get(t.id))!;
  assert.equal(next.ngoPhone, o.s.ngos[1].session.phone);
  assert.equal(next.drop.name, "Seva Neighborhood Kitchen");
  assert.equal(next.offer!.history.length, 1); assert.equal(next.offer!.history[0].reason, "TIMEOUT");
  assert.equal(canView(next, o.s.sessions.ngo), false);
  assert.equal(next.events.filter(e => e.type === "offer.expired").length, 1);
  assert.equal(next.offer!.deadline, deadline + offerWindowMs(t.safeUntil, deadline));
});
test("acceptance at or after the deadline fails, and a valid earlier acceptance cannot be expired", async () => {
  const o = await offer(), t = (await trips.get(o.leg))!, deadline = t.offer!.deadline;
  assert.throws(() => assertOfferOpen(t, deadline), /offer ended/);
  assert.throws(() => assertOfferOpen(t, deadline + 1), /offer ended/);
  assertOfferOpen(t, deadline - 1); acceptShare(t, deadline - 1);
  assert.equal(advanceNgoOffer(t, deadline), false);
  assert.equal(t.offer!.status, "accepted"); assert.equal(t.offer!.history.length, 0);
});
test("expired offer leaves the first NGO, appears at the next NGO with a fresh timer, and only that NGO can accept", async () => {
  const o = await offer(), t = (await trips.get(o.leg))!, version = t.version++;
  t.offer!.sentAt = Date.now() - 10 * 60_000; t.offer!.deadline = Date.now() - 1;
  await trips.save(t, version);
  const old = await (await request("/offers", o.s.sessions.ngo)).json();
  assert.deepEqual(old.offers, []); assert.match(old.expired[0].reason, /Seva Neighborhood Kitchen/);
  const next = await (await request("/offers", o.s.ngos[1].session)).json();
  assert.equal(next.offers[0].id, o.id); assert.ok(next.offers[0].offerDeadline > next.offers[0].serverNow);
  assert.equal(next.offers[0].pickup, null);
  assert.equal((await request(`/offers/${o.id}/accept`, o.s.sessions.ngo, {})).status, 409);
  assert.equal((await request(`/offers/${o.id}/accept`, o.s.ngos[1].session, {})).status, 200);
  assert.equal((await trips.get(o.leg))!.candidatePhones?.length, 3);
  assert.equal((await trips.get(o.leg))!.shareAcceptedAt !== null, true);
});
test("timer exhaustion does not extend safety or offer the food to a nonexistent NGO", async () => {
  const o = await offer(), t = (await trips.get(o.leg))!;
  t.offer!.remaining = [];
  assert.equal(advanceNgoOffer(t, t.offer!.deadline), true);
  assert.equal(t.offer!.status, "exhausted"); assert.equal(t.shareAcceptedAt, null);
  assert.equal(advanceNgoOffer(t, t.offer!.deadline + 10_000), false);
  assert.ok(t.events.some(e => e.type === "offer.exhausted"));
});
test("trusted agents can start a real timed NGO offer after first-listing approval, with idempotent handoff", async () => {
  const s = await accounts(), donor: Session = { ...s.sessions.donor, phone: "9550000011", token: randomUUID() };
  await store.putSession(donor); await store.putProfile({ ...s.profiles.donor, phone: donor.phone });
  const { id } = await (await request("/listings", donor, { ...input(s), contactPhone: donor.phone })).json();
  await request(`/listings/${id}/approve`, s.sessions.admin, { reason: "Reviewed real listing intake." });
  assert.equal((await listings.get(id))!.state, "checking");
  const checked = input(s), now = Date.now(), profile = s.profiles.ngo.fields, backup = s.ngos[1].profile.fields;
  const stop = (f: Record<string, string>) => ({ name: f.org, address: f.address, area: f.area, notes: f.notes, lat: Number(f.lat), lng: Number(f.lng) });
  const body = { listingId: id, shareId: `shr_${id.slice(4)}`, donorPhone: donor.phone, ngoPhone: s.sessions.ngo.phone, partnerPhone: null,
    partnerName: "Finding a delivery partner", vehicle: "two_wheeler", pickup: checked.pickup, drop: stop(profile), food: checked.dish, servings: 10,
    grade: "A", unsure: false, safeUntil: now + 6 * 60 * 60_000, collectBy: checked.collectBy, maxTransitMin: 90, containers: "10 meal boxes", partnerBringsContainers: false,
    requestDeadline: now + 3 * 60_000, partnerPhones: s.volunteers.map(v => v.session.phone), remainingNgos: [{ phone: s.ngos[1].session.phone, drop: stop(backup), partnerPhones: s.volunteers.map(v => v.session.phone) }] };
  const oldKey = process.env.LOGISTICS_HANDOFF_KEY; process.env.LOGISTICS_HANDOFF_KEY = "offer-service-key";
  try {
    assert.equal((await request("/internal/delivery-legs/offers", s.sessions.ngo, body)).status, 401);
    const service: Session = { ...s.sessions.admin, token: "offer-service-key" }, key = randomUUID();
    assert.equal((await request("/internal/delivery-legs/offers", service, body, key)).status, 201);
    const deadline = (await trips.get(tripId(id)))!.offer!.deadline;
    assert.equal((await request("/internal/delivery-legs/offers", service, body, key)).status, 201);
    assert.equal((await trips.get(tripId(id)))!.offer!.deadline, deadline);
    assert.equal((await request("/internal/delivery-legs/offers", service, { ...body, servings: 9 }, key)).status, 409);
    assert.equal((await listings.get(id))!.assessment!.source, "food_agent");
    assert.equal((await request(`/offers/${id}/accept`, s.sessions.ngo, {})).status, 200);
    assert.equal((await trips.get(tripId(id)))!.sample, false);
    assert.equal((await trips.get(tripId(id)))!.candidatePhones?.length, 3);
  } finally { if (oldKey === undefined) delete process.env.LOGISTICS_HANDOFF_KEY; else process.env.LOGISTICS_HANDOFF_KEY = oldKey; }
});

test("one volunteer stream delivers the pickup notification, winner's trip and losing volunteer's withdrawal", async () => {
  const o = await offer(); await acceptOffer(o);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Demo router unavailable in stream test."); };
  const frames = async function* (reader: ReadableStreamDefaultReader<Uint8Array>) {
    let buffer = ""; const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.includes("event: snapshot")) yield JSON.parse(frame.split("\n").find(l => l.startsWith("data:"))!.slice(5));
      }
    }
  };
  try {
    const winnerResponse = await request("/partner/requests/stream", o.s.volunteers[0].session);
    const loserResponse = await request("/partner/requests/stream", o.s.volunteers[1].session);
    const winnerReader = winnerResponse.body!.getReader(), loserReader = loserResponse.body!.getReader(); readers.push(winnerReader, loserReader);
    const winner = frames(winnerReader), loser = frames(loserReader);
    assert.equal((await winner.next()).value.requests[0].id, o.leg);
    assert.equal((await loser.next()).value.requests[0].pickup, null);
    assert.equal((await request(`/partner/requests/${o.leg}/accept`, o.s.volunteers[0].session, {})).status, 200);
    let assigned;
    do { assigned = (await winner.next()).value; } while (!assigned.leg);
    assert.equal(assigned.leg.id, o.leg); assert.equal(assigned.leg.status, "to_pickup"); assert.ok(assigned.leg.pickup);
    assert.deepEqual(assigned.requests, []);
    let withdrawn;
    do { withdrawn = (await loser.next()).value; } while (!withdrawn.withdrawn.length);
    assert.equal(withdrawn.withdrawn[0].reason, "Taken by someone else, thanks!");
    assert.equal(withdrawn.leg, null); assert.deepEqual(withdrawn.requests, []);
  } finally {
    await Promise.all(readers.map(reader => reader.cancel())); globalThis.fetch = fetchBefore;
  }
});

test("every listing gets a food check: rules-only and Unsure when the Food Agent isn't connected", async () => {
  const s = await accounts(), { id } = await (await request("/listings", s.sessions.donor, input(s))).json();
  const l = (await listings.get(id))!;
  assert.equal(l.foodCheck?.source, "rules_only"); assert.equal(l.foodCheck?.unsure, true); assert.equal(l.foodCheck?.photoChecked, false);
  assert.equal(l.foodCheck?.grade, "A"); assert.equal(l.assessment?.grade, "A"); assert.equal(l.assessment?.servings, 10);
  assert.match(l.foodCheck?.reasoning?.summary ?? "", /^Grade A/); assert.equal(l.foodCheck?.reasoning?.steps.at(-1)?.title, "Final grade");
});
test("Food Agent results map onto the listing; its safe-until and grade drive the offer", async () => {
  const s = await accounts(), base = { ...input(s), id: "lst_x", version: 1, donorPhone: s.sessions.donor.phone, donorName: "Annapurna Kitchen",
    createdAt: Date.now(), sample: true, fingerprint: "f", state: "checking" as const, approval: null, assessment: null, foodCheck: null };
  process.env.FOOD_AGENT_URL = "http://agent.test";
  try {
    const safe = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    let sent: Record<string, unknown> = {};
    const fake = (async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({
      decision: "ELIGIBLE", restaurant_message: "Looks fresh.", reasons: [], photo: { checked: true, seen: "biryani in a tray" },
      models: { photo: "gemini:gemini-2.5-flash-lite", reasoning: "gemini:gemini-2.5-flash" },
      explanation: { summary: "Grade B (Good): set by the time left (4.0 h).", steps: [{ title: "Final grade", detail: "B · Good.", effect: "", status: "pass" }] },
      freshness: { score: 82, grade: "B", unsure: false, photo_checked: true, condition: "fresh", safe_until: safe } }), { status: 200 }); }) as typeof fetch;
    const check = await requestFoodCheck(base, Date.now, fake);
    assert.equal(sent.storage_method, "hot_held"); assert.equal(sent.storage_temperature, 65); assert.equal(sent.quantity, 10); assert.equal(sent.food_category, "cooked_meal");
    assert.equal(check.models.photo, "gemini:gemini-2.5-flash-lite"); assert.equal(check.models.reasoning, "gemini:gemini-2.5-flash");
    assert.equal(check.source, "food_agent"); assert.equal(check.reasoning?.summary, "Grade B (Good): set by the time left (4.0 h)."); assert.equal(check.grade, "B"); assert.equal(check.unsure, false); assert.equal(check.safeUntil, Date.parse(safe));
    const l = structuredClone(base); applyFoodCheck(l, check);
    assert.equal(l.assessment?.grade, "B"); assert.equal(l.assessment?.source, "food_agent");
    const spoiled = await requestFoodCheck(base, Date.now, (async () => new Response(JSON.stringify({ decision: "INELIGIBLE", restaurant_message: "Mould on the bread.", reasons: ["Mould visible"],
      photo: { checked: true, seen: "bread" }, freshness: { score: 20, grade: "D", unsure: false, photo_checked: true, condition: "spoiled", safe_until: null } }))) as typeof fetch);
    const d = structuredClone(base); applyFoodCheck(d, spoiled);
    assert.equal(d.state, "not_for_people"); assert.equal(d.assessment, null);
    const down = await requestFoodCheck(base, Date.now, (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
    assert.equal(down.source, "rules_only"); assert.equal(down.unsure, true);
  } finally { delete process.env.FOOD_AGENT_URL; }
});
test("tags the photo contradicts hold the listing: sure means relist, unsure lets the donor keep them", async () => {
  const s = await accounts(), base = { ...input(s), id: "lst_tags", version: 1, donorPhone: s.sessions.donor.phone, donorName: "Annapurna Kitchen",
    createdAt: Date.now(), sample: false, fingerprint: "f", state: "checking" as const, approval: null, assessment: null, foodCheck: null };
  process.env.FOOD_AGENT_URL = "http://agent.test";
  try {
    const safe = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    let sent: Record<string, unknown> = {};
    const reply = (verdict: string, checks: unknown[]) => (async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({
      decision: "ELIGIBLE", restaurant_message: "", reasons: [], photo: { checked: true, seen: "rice with chicken pieces", diet_seen: "nonveg", tag_checks: checks, tags_verdict: verdict },
      freshness: { score: 75, grade: "C", unsure: false, photo_checked: true, condition: "acceptable", safe_until: safe } })); }) as typeof fetch;
    const sure = await requestFoodCheck(base, Date.now, reply("wrong", [{ tag: "diet", verdict: "wrong", certainty: "sure", seen: "chicken pieces", suggest: "nonveg", confidence: 0.95 }]));
    assert.deepEqual(sent.tags, { diet: "veg", jain: false, spice: "medium", contains: ["dairy", "onion_garlic"] });
    assert.equal(sure.tagsVerdict, "wrong"); assert.equal(sure.tagChecks?.[0].suggest, "nonveg");
    const l = structuredClone(base); applyFoodCheck(l, sure);
    assert.equal(l.state, "tags_held"); assert.equal(l.heldFrom, "checking"); assert.equal(l.assessment?.grade, "C");
    const ok = structuredClone(base); applyFoodCheck(ok, await requestFoodCheck(base, Date.now, reply("ok", [])));
    assert.equal(ok.state, "checking");

    // sure: can't be kept; unsure: the donor can keep their tags and the listing carries on
    await listings.create({ ...structuredClone(l), id: "lst_sure" });
    assert.equal((await request("/listings/lst_sure/keep-tags", s.sessions.donor, {})).status, 409);
    const maybe = structuredClone(base); applyFoodCheck(maybe, await requestFoodCheck(base, Date.now, reply("unsure", [{ tag: "contains:onion_garlic", verdict: "maybe", certainty: "unsure", seen: "gravy", suggest: "add", confidence: 0.5 }])));
    await listings.create({ ...maybe, id: "lst_maybe" });
    assert.equal((await request("/listings/lst_maybe/keep-tags", s.sessions.ngo, {})).status, 404);
    const kept = await (await request("/listings/lst_maybe/keep-tags", s.sessions.donor, {})).json();
    assert.equal(kept.state, "checking"); assert.ok((await listings.get("lst_maybe"))?.tagsKeptAt);
  } finally { delete process.env.FOOD_AGENT_URL; }

  // relisting points the held listing at the corrected one
  const { id } = await (await request("/listings", s.sessions.donor, { ...input(s), diet: "nonveg", replaces: "lst_sure" })).json();
  assert.equal((await listings.get("lst_sure"))?.replacedBy, id);
  assert.equal("replaces" in (await listings.get(id))!, false);
});
test("a checked listing opens a case: the NGO Agent offers it to a listed NGO that can take it, never to a sample one", async () => {
  const { Hono } = await import("hono");
  const { mountMatching, matchingStore } = await import("../src/matching/index.ts");
  const { config } = await import("../src/matching/config.ts");
  const { recipientFrom } = await import("../src/matching/directory.ts");
  config.simulateUnclaimed = false;
  await mountMatching(new Hono());
  const s = await accounts(), now = Date.now(), ngoPhone = s.sessions.ngo.phone;
  const listed = recipientFrom({ ngo_id: `NGO-${ngoPhone}`, name: "Listed Kitchen", address: "Indiranagar, Bengaluru", location: { latitude: 12.9719, longitude: 77.6412 },
    service_area_km: 10, capacity: { daily_meal_capacity: 200, available_capacity_today: 200 }, current_demand: { meals_needed: 80, urgency: "HIGH" },
    accepted_categories: ["cooked_meal"], dietary_constraints: [], receiving_hours: { start: "00:00", end: "23:59" }, status: "ACTIVE" }, "NGO")!;
  await matchingStore.put("recipient", listed);
  const f = s.profiles.donor.fields;
  const l = { ...input(s), id: "lst_case", version: 1, donorPhone: s.sessions.donor.phone, donorName: "Annapurna Kitchen", createdAt: now, sample: false, fingerprint: "f",
    pickup: { name: "Kitchen", address: "100 Feet Road", area: "Indiranagar", notes: "", lat: 12.9711, lng: 77.6400 }, contactPhone: s.sessions.donor.phone,
    state: "checking" as const, approval: null, assessment: { grade: "B" as const, safeUntil: now + 4 * 60 * 60_000, servings: 10, unsure: false, source: "food_agent" as const },
    foodCheck: { status: "done" as const, at: now, source: "food_agent" as const, grade: "B" as const, unsure: false, photoChecked: true, score: 85, condition: "fresh", safeUntil: now + 4 * 60 * 60_000, message: "", reasons: [], seen: "", models: { photo: null, reasoning: "rules" } } };
  void f;
  await listings.create(structuredClone(l));
  // nobody online yet: the NGO still hears about the food straight away, pushed to its open app
  const { onPing } = await import("../src/matching/live.ts");
  const pings: string[] = [];
  const off = onPing(ngoPhone, p => pings.push(p.kind));
  const handed = await handOff("lst_case", now);
  off();
  assert.deepEqual(pings, ["recipient"]);
  assert.ok(handed?.matchId);
  await handOff("lst_case", now);                                 // only once
  assert.equal((await matchingStore.list("listing", { sourceListingId: "lst_case" })).length, 1);
  const { agents } = await import("../src/matching/index.ts");
  let shares = await matchingStore.list("share", { listingId: handed!.matchId! });
  assert.equal(shares.length, 1); assert.equal(shares[0].ngoId, listed.id); assert.equal(shares[0].status, "offering");
  // the NGO accepts; with no partner free the share waits instead of moving on
  assert.equal((await agents()!.ngoReply(shares[0].id, true, { phone: ngoPhone }, now)).ok, true);
  shares = await matchingStore.list("share", { listingId: handed!.matchId! });
  assert.equal(shares[0].status, "finding_partner"); assert.equal(shares[0].askedPartnerId, undefined); assert.ok(shares[0].waitingForPartnerSince);
  // the NGO's own volunteer comes online before an independent one nearer the kitchen; the tick asks the NGO's own first
  await matchingStore.put("partner", { id: "prt_indie", phone: "9000000002", name: "Kavya", areaId: "indiranagar", lat: 12.9712, lng: 77.6401, travel: "two_wheeler", online: true, source: "volunteer" });
  await matchingStore.put("partner", { id: "prt_own", phone: "9000000001", name: "Arjun", areaId: "indiranagar", lat: 12.975, lng: 77.645, travel: "two_wheeler", online: true, source: "volunteer", ngoId: listed.id });
  await agents()!.tick(now + 30_000);
  shares = await matchingStore.list("share", { listingId: handed!.matchId! });
  assert.equal(shares[0].askedPartnerId, "prt_own");
  // the donor's view follows the case
  const view = await (await request("/listings/lst_case", s.sessions.donor)).json() as ListingView;
  assert.equal(view.agentCase?.shares[0].ngoName, "Listed Kitchen");
  assert.match(view.progress, /Listed Kitchen accepted/);
  assert.equal(view.agentCase?.ranked[0].ngoName, "Listed Kitchen");
  assert.ok(view.agentCase!.timeline.some(d => d.agent === "logistics" && d.kind === "offered"));
  assert.equal(view.agentCase!.timeline[0].agent, "food");
  // held listings never open a case
  await listings.create({ ...structuredClone(l), id: "lst_held2", state: "tags_held" as const });
  assert.equal((await handOff("lst_held2"))?.matchId, undefined);
});
test("a new donor's first real listing goes to the agents at once and is flagged for the team to double-check", async () => {
  const s = await accounts(), donor = { ...s.sessions.donor };
  const { createdAt: _c, ...rest } = s.profiles.donor; void _c;
  const realPhone = "9876500111";
  const { store: authStore } = await import("../src/store.ts");
  await authStore.putProfile({ ...rest, phone: realPhone, fields: { ...rest.fields, sample: "false" }, createdAt: Date.now() });
  const session = { ...donor, phone: realPhone, token: "tok-" + realPhone };
  await authStore.putSession(session);
  const { id } = await (await request("/listings", session, { ...input(s), contactPhone: realPhone })).json();
  const l = await listings.get(id);
  assert.equal(l?.sample, false); assert.equal(l?.state, "checking"); assert.equal(l?.reviewPending, true);
});
test("the live stream pushes an update to the signed-in person the moment an agent messages them", async () => {
  const { Hono } = await import("hono");
  const { matchingRoutes } = await import("../src/matching/routes.ts");
  const { matchingStore, agents, mountMatching } = await import("../src/matching/index.ts");
  const { ping } = await import("../src/matching/live.ts");
  if (!agents()) await mountMatching(new Hono());
  const s = await accounts(), app = new Hono();
  app.route("/agents", matchingRoutes(agents()!, matchingStore));
  const res = await app.request("/agents/me/stream", { headers: { Authorization: `Bearer ${s.sessions.ngo.token}` } });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let text = "";
  const read = async (until: string) => { while (!text.includes(until)) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } };
  await read("event: ready");
  setTimeout(() => ping(s.sessions.ngo.phone, "recipient"), 10);
  const t0 = Date.now();
  await read("event: update");
  assert.ok(Date.now() - t0 < 1000, "pushed, not polled");
  assert.match(text, /"kind":"recipient"/);
  await reader.cancel();
});
test("the background sweep finishes a food check that was interrupted, with nobody signed in", async () => {
  const s = await accounts(), now = Date.now();
  const { sweepListings } = await import("../src/listings/routes.ts");
  // a listing saved, then the process restarted before its check ran: no session involved from here on
  await listings.create({ ...input(s), id: "lst_orphan", version: 1, donorPhone: "9876500222", donorName: "Night Kitchen", createdAt: now - 5 * 60_000, sample: false,
    fingerprint: "f", state: "checking", approval: null, assessment: null, foodCheck: null, reviewPending: true });
  const r = await sweepListings(now);
  assert.ok(r.checked >= 1);
  const l = await listings.get("lst_orphan");
  assert.ok(l?.foodCheck, "checked by the sweep");
  assert.equal(l?.foodCheck?.source, "rules_only");   // no Food Agent URL in tests
});
