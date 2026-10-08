import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { sessionFrom } from "../auth.ts";
import { store, type Session } from "../store.ts";
import { listings } from "../listings/repository.ts";
import { startNgoOffer } from "../listings/offers.ts";
import { TRIP_CONFIG as C } from "./config.ts";
import { accept, assignPartner, arrive, assertActive, assertCandidate, assertPartner, canView, createTrip, event, ingest, pickupCheck, present, redirect, requestPartners, resumeHeld, verifyCode } from "./engine.ts";
import { validPoint } from "./geo.ts";
import { trips } from "./repository.ts";
import { authorized, mutate, TripError, view } from "./service.ts";
import type { NgoOfferCandidate, PickupCheck, RedirectInput, TripInput, TripPoint } from "./types.ts";

type Env = { Variables: { session: Session } };
export const delivery = new Hono<Env>();
delivery.onError((err, c) => {
  if (err instanceof TripError) return c.json({ error: err.message }, err.status);
  // Domain errors are actionable; provider/database details are never sent to the browser.
  if (err.message === "You're already on a pickup.") return c.json({ error: err.message }, 409);
  console.error("trip request failed", err.name);
  return c.json({ error: "Delivery updates are temporarily unavailable. Please retry." }, 503);
});
const tripPath = (path: string) => /^\/(trips|partner|cases|internal\/delivery-legs)(\/|$)/.test(path);
const limit = bodyLimit({ maxSize: C.maxRequestBytes, onError: c => c.json({ error: "Delivery request is too large. Compress the pickup photo and retry." }, 413) });
delivery.use("*", async (c, next) => {
  if (tripPath(c.req.path) && process.env.DATABASE_URL && !process.env.TRIP_CODE_SECRET)
    return c.json({ error: "Delivery trips need to be configured on the Luna API." }, 503);
  return tripPath(c.req.path) ? limit(c, next) : next();
});
const demoEnabled = () => process.env.ENABLE_TRIP_DEMO === "1" || !process.env.DATABASE_URL && process.env.ENABLE_TRIP_DEMO !== "0";
delivery.use("*", async (c, next) => {
  if (!c.req.path.startsWith("/internal/delivery-legs")) return next();
  const secret = process.env.LOGISTICS_HANDOFF_KEY;
  const header = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
  const equal = secret && timingSafeEqual(createHash("sha256").update(secret).digest(), createHash("sha256").update(header).digest());
  if (!equal) return c.json({ error: "Not authorized." }, 401);
  return next();
});
delivery.post("/internal/delivery-legs", async c => {
  const body = await c.req.json().catch(() => null) as TripInput | null;
  const key = c.req.header("Idempotency-Key");
  if (!key || key.length > 200 || !validInput(body, Date.now())) return c.json({ error: "A valid delivery handoff and Idempotency-Key are required." }, 400);
  for (const [role, phone] of [["donor", body!.donorPhone], ["ngo", body!.ngoPhone], ["volunteer", body!.partnerPhone]] as const) {
    if (role === "volunteer" && phone === null) continue;
    if (!await store.getProfile(role, phone!)) return c.json({ error: "All delivery participants must have a Luna profile." }, 400);
  }
  const id = `dlv_${createHash("sha256").update(`${body!.shareId}:${key}`).digest("hex").slice(0, 24)}`;
  const existing = await trips.get(id);
  if (existing && JSON.stringify(tripInput(existing)) !== JSON.stringify(tripInput(body!))) return c.json({ error: "This handoff key was already used with different details." }, 409);
  if (!existing) await trips.create(createTrip(body!, id, Date.now()));
  return c.json({ id, listingId: body!.listingId, trackingUrl: `/deliveries?id=${id}` }, 201);
});

const handoffSession: Session = { role: "admin", phone: "internal", token: "", signedInAt: 0 };
/** Friends' agents supply a checked food passport and ranked NGOs; this service owns the deadline. */
delivery.post("/internal/delivery-legs/offers", async c => {
  const body = await c.req.json().catch(() => null), now = Date.now(), key = c.req.header("Idempotency-Key");
  if (!key || key.length > 200 || !validInput(body, now) || body.partnerPhone !== null) throw new TripError("A checked offer handoff and Idempotency-Key are required.", 400);
  const extra = body as TripInput & { remainingNgos?: NgoOfferCandidate[]; partnerPhones?: string[] };
  const remaining = extra.remainingNgos ?? [], phones = extra.partnerPhones ?? [];
  const validPhones = (values: unknown): values is string[] => Array.isArray(values) && values.length <= C.partnerWaveSize && new Set(values).size === values.length && values.every(p => typeof p === "string" && /^[6-9]\d{9}$/.test(p));
  if (!Array.isArray(remaining) || remaining.length > 7 || !validPhones(phones) || remaining.some(n => !n || !/^[6-9]\d{9}$/.test(n.phone) || !validStop(n.drop, now) || !validPhones(n.partnerPhones ?? [])) || new Set([body.ngoPhone, ...remaining.map(n => n.phone)]).size !== remaining.length + 1) throw new TripError("Supply distinct ranked NGOs, stops and eligible volunteer waves.", 400);
  for (const phone of [body.ngoPhone, ...remaining.map(n => n.phone)]) if (!await store.getProfile("ngo", phone)) throw new TripError("Every NGO must have a registered profile.", 400);
  for (const phone of [...phones, ...remaining.flatMap(n => n.partnerPhones ?? [])]) if (!await store.getProfile("volunteer", phone)) throw new TripError("Every volunteer must have a registered profile.", 400);
  const id = `dlv_${body.listingId.slice(4)}`, fingerprint = createHash("sha256").update(JSON.stringify(extra)).digest("hex"), keyHash = createHash("sha256").update(key).digest("hex");
  let current = await trips.get(id);
  if (current && (current.offerHandoff?.keyHash !== keyHash || current.offerHandoff.fingerprint !== fingerprint)) throw new TripError("This listing already has an offer handoff.");
  let listing = await listings.get(body.listingId);
  if (!listing || listing.state === "in_review" || listing.donorPhone !== body.donorPhone || listing.dish !== body.food || body.servings > listing.count * listing.feedsEach) throw new TripError("Approve the listing first and send its checked food passport.", 400);
  if (!current) {
    const t = createTrip(tripInput(body), id, now, false, false);
    t.offerHandoff = { keyHash, fingerprint };
    startNgoOffer(t, remaining, listing.readyFrom, now, phones);
    await trips.create(t); current = await trips.get(id);
    if (current?.offerHandoff?.keyHash !== keyHash || current.offerHandoff.fingerprint !== fingerprint) throw new TripError("Another handoff already created this offer.");
  }
  // Recover the listing projection if a previous attempt created the offer before an API interruption.
  for (let attempt = 0; attempt < C.casRetries; attempt++) {
    listing = await listings.get(body.listingId);
    if (!listing) throw new TripError("Listing not found.", 404);
    if (listing.state === "offered" && listing.assessment?.source === "food_agent") break;
    const version = listing.version++;
    listing.state = "offered";
    listing.assessment = { grade: body.grade, safeUntil: body.safeUntil, servings: body.servings, unsure: body.unsure, source: "food_agent" };
    if (await listings.save(listing, version)) break;
    if (attempt === C.casRetries - 1) throw new TripError("Listing changed during the handoff. Retry with the same key.");
  }
  return c.json({ id, offerDeadline: current!.offer!.deadline, listingId: body.listingId }, 201);
});
for (const action of ["assign", "redirect"] as const) delivery.post(`/internal/delivery-legs/:id/${action}`, async c => {
  const body = await c.req.json().catch(() => ({})), now = Date.now();
  if (action === "assign") {
    const phones = body.partnerPhones ?? [body.partnerPhone];
    if (!Array.isArray(phones) || !phones.length || phones.length > C.partnerWaveSize || new Set(phones).size !== phones.length || !phones.every(p => typeof p === "string" && /^[6-9]\d{9}$/.test(p)) || !["foot", "bicycle", "two_wheeler", "car"].includes(body.vehicle)) throw new TripError("A wave of registered partners and a vehicle are required.", 400);
    const profiles = await Promise.all(phones.map(phone => store.getProfile("volunteer", phone)));
    if (profiles.some(p => !p)) throw new TripError("Every partner must have a Luna profile.", 400);
    try { await mutate(c.req.param("id"), handoffSession, c.req.header("Idempotency-Key") ?? "", { action, body }, t => {
      if (body.partnerPhones) { t.vehicle = body.vehicle; requestPartners(t, profiles.map(p => ({ phone: p!.phone, name: p!.fields.name })), now); }
      else assignPartner(t, phones[0], profiles[0]!.fields.name, body.vehicle, now);
    }); }
    catch (e) { if (e instanceof TripError) throw e; throw new TripError((e as Error).message); }
  } else {
    if (!/^shr_[\w-]+$/.test(body.shareId) || !/^[6-9]\d{9}$/.test(body.ngoPhone) || !validStop(body.drop, now) || !await store.getProfile("ngo", body.ngoPhone)) throw new TripError("A registered NGO, accepted share and valid drop are required.", 400);
    try { await mutate(c.req.param("id"), handoffSession, c.req.header("Idempotency-Key") ?? "", { action, body }, t => redirect(t, body as RedirectInput, now)); }
    catch (e) { if (e instanceof TripError) throw e; throw new TripError((e as Error).message); }
  }
  return c.json({ id: c.req.param("id"), trackingUrl: `/deliveries?id=${c.req.param("id")}` });
});

delivery.use("*", async (c, next) => {
  if (!tripPath(c.req.path)) return next();
  const s = await sessionFrom(c.req.header("Authorization"));
  if (!s) return c.json({ error: "Sign in to see deliveries." }, 401);
  c.set("session", s); c.header("Cache-Control", "no-store");
  return next();
});
delivery.get("/trips/config", c => c.json({ demoEnabled: demoEnabled() }));
delivery.post("/trips/:id/receipt", async c => {
  const s = c.get("session"), body = await c.req.json().catch(() => null);
  if (s.role !== "ngo" || !body || !Number.isInteger(body.servings) || body.servings < 0 || typeof body.problem !== "string" || body.problem.length > 200) throw new TripError("Confirm received servings and an optional short problem report.", 400);
  const t = await mutate(c.req.param("id"), s, c.req.header("Idempotency-Key") ?? "", { action: "receipt", body }, t => {
    if (t.ngoPhone !== s.phone || t.status !== "delivered") throw new TripError("Confirm receipt after the verified drop.");
    if (t.receipt) throw new TripError("Receipt already confirmed.");
    if (body.servings > t.servings) throw new TripError("Received servings cannot exceed the collected amount.");
    t.receipt = { servings: body.servings, problem: body.problem.trim(), at: Date.now() };
    event(t, "ngo.receipt_confirmed", `${t.drop.name} confirmed ${body.servings} servings received.${body.problem.trim() ? ` Report: ${body.problem.trim()}` : ""}`, Date.now());
    if (body.servings < t.servings || body.problem.trim()) event(t, "escalation.opened", "The NGO reported a short delivery or a problem. Review this delivery.", Date.now());
  });
  return c.json(present(t, s, Date.now()));
});
delivery.post("/trips/:id/resume", async c => {
  const s = c.get("session"), body = await c.req.json().catch(() => ({}));
  if (s.role !== "admin") throw new TripError("Luna team access required.", 403);
  try {
    const t = await mutate(c.req.param("id"), s, c.req.header("Idempotency-Key") ?? "", { action: "resume", body }, t => resumeHeld(t, body.reason, Date.now()));
    return c.json(present(t, s, Date.now()));
  } catch (e) { if (e instanceof TripError) throw e; throw new TripError((e as Error).message); }
});
delivery.get("/trips", async c => {
  const s = c.get("session"), now = Date.now();
  return c.json({ trips: (await trips.list()).filter(t => canView(t, s)).map(t => present(t, s, now)) });
});
delivery.get("/partner/requests", async c => {
  const s = c.get("session");
  if (s.role !== "volunteer") return c.json({ error: "Delivery partner access required." }, 403);
  return c.json({ requests: (await trips.list()).filter(t => canView(t, s) && t.requestStatus === "pending" && t.requestDeadline > Date.now()).map(t => present(t, s, Date.now())) });
});
delivery.get("/partner/requests/stream", async c => {
  const s = c.get("session"), token = c.req.header("Authorization");
  if (s.role !== "volunteer") throw new TripError("Delivery partner access required.", 403);
  return streamSSE(c, async stream => {
    let previous = "", last = new Set<string>();
    while (!stream.aborted && await sessionFrom(token)) {
      const all = await trips.list(), now = Date.now();
      const pending = all.filter(t => canView(t, s) && t.requestStatus === "pending" && t.requestDeadline > now);
      const current = new Set(pending.map(t => t.id));
      const withdrawn = [...last].filter(id => !current.has(id)).map(id => {
        const t = all.find(t => t.id === id);
        return { id, reason: t?.requestStatus === "accepted" ? t.partnerPhone === s.phone ? "You accepted this pickup." : "Taken by someone else, thanks!" : "This pickup request is no longer available." };
      });
      const leg = all.filter(t => t.partnerPhone === s.phone && t.requestStatus === "accepted").sort((a, b) => Number(!!a.closedAt) - Number(!!b.closedAt) || (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt))[0];
      const data = JSON.stringify({ requests: pending.map(t => present(t, s, now)), withdrawn, leg: leg ? present(leg, s, now) : null });
      if (data !== previous) { await stream.writeSSE({ event: "snapshot", data }); previous = data; }
      else await stream.writeSSE({ event: "heartbeat", data: "{}" });
      last = current;
      // One volunteer stream supplies both request notifications and their current navigation.
      if (leg && !leg.closedAt) {
        try { await stream.writeSSE({ event: "leg", data: JSON.stringify(await view(leg, s, Date.now())) }); }
        catch (e) { if (!(e instanceof TripError)) throw e; }
      }
      await stream.sleep(C.streamPollMs);
    }
  });
});
delivery.get("/partner/legs/current", async c => {
  const s = c.get("session");
  if (s.role !== "volunteer") return c.json({ error: "Delivery partner access required." }, 403);
  const t = (await trips.list()).find(t => t.partnerPhone === s.phone && t.requestStatus === "accepted" && !t.closedAt);
  return c.json({ leg: t ? await view(t, s, Date.now()) : null });
});
delivery.get("/trips/:id", async c => c.json(await view(await authorized(c.req.param("id"), c.get("session")), c.get("session"), Date.now())));

for (const action of ["accept", "decline"] as const) delivery.post(`/partner/requests/:id/${action}`, async c => {
  const s = c.get("session"), body = await c.req.json().catch(() => ({}));
  const profile = await store.getProfile("volunteer", s.phone);
  try {
    const t = await mutate(c.req.param("id"), s, c.req.header("Idempotency-Key") ?? "", { action, body }, t => {
      assertCandidate(t, s);
      if (action === "accept") {
        t.partnerPhone = s.phone; t.partnerName = profile?.fields.name || t.partnerName;
        accept(t, body.hasContainers === true, Date.now());
      }
      else {
        if (t.candidatePhones?.length) { t.candidatePhones = t.candidatePhones.filter(p => p !== s.phone); if (!t.candidatePhones.length) t.requestStatus = "finding_partner"; }
        else t.requestStatus = "declined";
        event(t, "partner_request.declined", `${profile?.fields.name || "A volunteer"} cannot take this pickup.`, Date.now());
      }
    });
    return action === "decline" ? c.json({ declined: true }) : c.json(present(t, s, Date.now()));
  } catch (e) { if (e instanceof TripError) throw e; throw new TripError((e as Error).message); }
});

for (const action of ["arrived", "code", "pickup-check", "location", "sample-location", "late", "sos"] as const) delivery.post(`/partner/legs/:id/${action}`, async c => {
  const s = c.get("session"), body = await c.req.json().catch(() => ({})), now = Date.now();
  // Buffered handovers keep their observation time; the server checks sequence, GPS and hashes again.
  const occurredAt = typeof body.occurredAt === "number" ? body.occurredAt : now;
  if (occurredAt > now + C.futureToleranceMs || occurredAt < now - C.locationRetentionMs) throw new TripError("This action has an invalid observation time.", 400);
  try {
    const t = await mutate(c.req.param("id"), s, c.req.header("Idempotency-Key") ?? "", { action, body }, t => {
      assertPartner(t, s);
      if (["arrived", "code", "pickup-check"].includes(action) && ((t.routeRevision ?? 1) > 1 || body.routeRevision !== undefined) && body.routeRevision !== (t.routeRevision ?? 1)) throw new Error("The destination changed. Reload the route before continuing the handover.");
      if (action === "sample-location") {
        if (!t.sample || !demoEnabled()) throw new Error("Location simulation is only available on sample deliveries.");
        if (!validPoint(body.point)) throw new Error("A valid sample point is required.");
        return { points: ingest(t, [body.point], now) };
      }
      if (occurredAt < (t.acceptedAt ?? now)) throw new Error("This action predates delivery acceptance.");
      if (action === "location") {
        if (!Array.isArray(body.points) || body.points.length > C.maxBatch || !body.points.every(validPoint)) throw new Error("Send up to 100 valid GPS points.");
        return { points: ingest(t, body.points, now) };
      }
      if (action === "sos") {
        if (t.requestStatus !== "accepted" || t.closedAt) throw new Error("This delivery is not active.");
        event(t, "partner.sos", "The delivery partner needs urgent help. Review their last location now.", now);
        event(t, "escalation.opened", "Urgent: delivery partner requested help.", now); return;
      }
      if (action === "arrived" || action === "code") {
        if (body.kind !== "pickup" && body.kind !== "drop") throw new Error("Choose pickup or drop.");
        if (action === "arrived") arrive(t, body.kind, occurredAt);
        else {
          if (body.point !== null && !validPoint(body.point)) throw new Error("Send a GPS point or explicitly continue without GPS.");
          const error = verifyCode(t, body.kind, String(body.code ?? ""), body.point as TripPoint | null, occurredAt);
          if (now - occurredAt > C.staleMs) event(t, "handover.offline_synced", "An offline handover was rechecked on reconnect and needs a review.", now);
          return { error };
        }
      } else if (action === "pickup-check") pickupCheck(t, body as PickupCheck, occurredAt);
      else { assertActive(t, now); event(t, "partner.running_late", "The delivery partner reported a delay. Review the arrival time and food safety.", now); }
    });
    return c.json(present(t, s, now));
  } catch (e) { if (e instanceof TripError) throw e; throw new TripError((e as Error).message); }
});

// fetch-based SSE keeps bearer tokens out of URLs, browser history and access logs.
delivery.get("/trips/:id/stream", async c => {
  const s = c.get("session"), id = c.req.param("id"), token = c.req.header("Authorization");
  const initial = await authorized(id, s);
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async stream => {
    // Show stops immediately. A slow directions provider must not delay NGO acceptance.
    await stream.writeSSE({ event: "snapshot", id: String(initial.version), data: JSON.stringify(present(initial, s, Date.now())) });
    let previous = "", heartbeat = 0;
    while (!stream.aborted) {
      if (!await sessionFrom(token)) { await stream.writeSSE({ event: "access_revoked", data: "{}" }); break; }
      const t = await trips.get(id);
      if (!t || !canView(t, s)) { await stream.writeSSE({ event: "access_revoked", data: "{}" }); break; }
      const v = await view(t, s, Date.now()), data = JSON.stringify(v);
      if (data !== previous) { await stream.writeSSE({ event: "snapshot", id: String(v.version), data }); previous = data; }
      if (Date.now() - heartbeat > C.streamHeartbeatMs) { await stream.writeSSE({ event: "heartbeat", data: "{}" }); heartbeat = Date.now(); }
      await stream.sleep(C.streamPollMs);
    }
  });
});
delivery.get("/cases/:id/stream", async c => {
  const s = c.get("session"), listingId = c.req.param("id"), token = c.req.header("Authorization");
  if (!(await trips.list()).some(t => t.listingId === listingId && canView(t, s))) throw new TripError("Case not found.", 404);
  return streamSSE(c, async stream => {
    let previous = "";
    while (!stream.aborted && await sessionFrom(token)) {
      const legs = (await trips.list()).filter(t => t.listingId === listingId && canView(t, s));
      if (!legs.length) break;
      const data = JSON.stringify({ legs: legs.map(t => present(t, s, Date.now())) });
      if (previous !== data) { await stream.writeSSE({ event: "snapshot", data }); previous = data; }
      else await stream.writeSSE({ event: "heartbeat", data: "{}" });
      await stream.sleep(C.streamPollMs);
    }
  });
});

function validInput(v: TripInput | null, now: number): v is TripInput {
  if (!v || !/^lst_[\w-]+$/.test(v.listingId) || !/^shr_[\w-]+$/.test(v.shareId)) return false;
  if (![v.donorPhone, v.ngoPhone].every(p => typeof p === "string" && /^[6-9]\d{9}$/.test(p)) || v.partnerPhone !== null && !/^[6-9]\d{9}$/.test(v.partnerPhone)) return false;
  if (![v.pickup, v.drop].every(p => validStop(p, now))) return false;
  return typeof v.partnerName === "string" && typeof v.food === "string" && typeof v.containers === "string"
    && ["foot", "bicycle", "two_wheeler", "car"].includes(v.vehicle) && ["A", "B", "C"].includes(v.grade)
    && Number.isInteger(v.servings) && v.servings > 0 && typeof v.unsure === "boolean" && typeof v.partnerBringsContainers === "boolean"
    && Number.isFinite(v.safeUntil) && v.safeUntil > now && Number.isFinite(v.collectBy) && v.collectBy > now && v.collectBy <= v.safeUntil
    && Number.isFinite(v.requestDeadline) && v.requestDeadline > now && v.requestDeadline <= v.collectBy
    && (v.maxTransitMin === null || Number.isFinite(v.maxTransitMin) && v.maxTransitMin > 0);
}
function validStop(p: TripInput["pickup"], now: number) {
  return p && typeof p.name === "string" && typeof p.address === "string" && typeof p.area === "string" && typeof p.notes === "string" && validPoint({ ...p, at: now, accuracyM: 0, speedMps: null, heading: null });
}
function tripInput(t: TripInput): TripInput {
  const { listingId, shareId, donorPhone, ngoPhone, partnerPhone, partnerName, vehicle, pickup, drop, food, servings, grade, unsure, safeUntil, collectBy, maxTransitMin, containers, partnerBringsContainers, requestDeadline } = t;
  return { listingId, shareId, donorPhone, ngoPhone, partnerPhone, partnerName, vehicle, pickup, drop, food, servings, grade, unsure, safeUntil, collectBy, maxTransitMin, containers, partnerBringsContainers, requestDeadline };
}
