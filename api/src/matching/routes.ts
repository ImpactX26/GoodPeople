/**
 * REST routes for Luna's agents. Restaurants, NGOs and delivery partners can do
 * everything here that they can do on WhatsApp, for the apps.
 */
import { Hono, type Context } from "hono";
import { sessionFrom } from "../auth.ts";
import { AREAS } from "../map/model.ts";
import { store as authStore, type Profile, type Role, type Session } from "../store.ts";
import { config } from "./config.ts";
import { straightKm } from "./engine/geo.ts";
import { effectiveGrade, safeUntil } from "./engine/safety.ts";
import type { Actor, Luna, NewListing, Result } from "./luna.ts";
import { areaById, areaIdFromName } from "./seed.ts";
import type { MatchingStore } from "./store.ts";
import { reliabilityLine } from "./reliability.ts";
import { listings as foodListings } from "../listings/repository.ts";
import { distanceKm, etaMs } from "./engine/geo.ts";
import { syncDirectory } from "./directory.ts";
import { onPing, onShare, pingShare, type LivePing } from "./live.ts";
import { liveTrack } from "./live-track.ts";
import { streamSSE } from "hono/streaming";
import type { Decision, Diet, Grade, Item, Quantity, Share, Storage } from "./types.ts";

const GRADES: Grade[] = ["A", "B", "C", "D"];
const DIETS: Diet[] = ["veg", "jain", "egg", "nonveg", "unknown"];
const STORAGE: Storage[] = ["room", "fridge", "hot"];

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const strs = (v: unknown, max = 20) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 80)).slice(0, max) : [];
const isPhone = (p: unknown): p is string => typeof p === "string" && /^[6-9]\d{9}$/.test(p);
const newestFirst = (a: Decision, b: Decision) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0);

function quantityOf(v: unknown, unit: unknown): Quantity | undefined {
  if (v && typeof v === "object") return quantityOf((v as Record<string, unknown>).amount, (v as Record<string, unknown>).unit);
  const amount = num(v);
  const u = str(unit, 20);
  return amount !== undefined && amount > 0 && u ? { amount, unit: u } : undefined;
}

/**
 * The only place the Food Passport (listing) is read. Food Agent fields
 * (servings, grade, confidence, safeTime, ...) and restaurant fields are
 * provisional names; when they change, change them here. Missing restaurant
 * fields get the safe default.
 */
export function parseListing(body: unknown, session: Session, profile: Profile | null, now: number): NewListing | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (!rawItems.length || rawItems.length > 10) return { error: "Add between 1 and 10 food items." };

  const items: Item[] = [];
  for (const [i, raw] of rawItems.entries()) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const servings = num(it.servings);
    const grade = typeof it.grade === "string" ? (it.grade.toUpperCase() as Grade) : undefined;
    const confidence = num(it.confidence);
    const safeTime = num(it.safeTime);
    if (!servings || servings < 1 || servings > 5000 || !Number.isInteger(servings)) return { error: `Item ${i + 1}: servings must be a whole number from 1 to 5000.` };
    if (!grade || !GRADES.includes(grade)) return { error: `Item ${i + 1}: grade must be A, B, C or D.` };
    if (confidence === undefined || confidence < 0 || confidence > 100) return { error: `Item ${i + 1}: confidence must be 0–100.` };
    if (safeTime === undefined || safeTime < 0) return { error: `Item ${i + 1}: safeTime (minutes the food stays safe) is required.` };
    const diet = DIETS.includes(it.diet as Diet) ? (it.diet as Diet) : "unknown";
    const tags = strs(it.tags);
    const allergens = strs(it.allergens).map((a) => a.toLowerCase());
    items.push({
      id: `i${i + 1}`,
      name: str(it.name, 80) ?? str(it.label, 80),
      tags: tags.length ? tags : undefined,
      packing: str(it.packing, 80),
      quantity: quantityOf(it.quantity, it.unit),
      servings,
      grade,
      confidence,
      safeTime,
      diet,
      halal: it.halal === true || undefined,
      allergens: allergens.length ? allergens : undefined,
    });
  }

  const fields = profile?.fields ?? {};
  let lat = num(b.lat);
  let lng = num(b.lng);
  let areaId = areaIdFromName(str(b.area)) ?? areaIdFromName(fields.area);
  if (lat !== undefined && lng !== undefined) {
    if (!areaId) areaId = [...AREAS].sort((x, y) => straightKm(x, { lat: lat!, lng: lng! }) - straightKm(y, { lat: lat!, lng: lng! }))[0].id;
  } else {
    if (!areaId) return { error: "Choose an area or send the pickup location." };
    ({ lat, lng } = areaById(areaId)!);
  }
  const area = areaById(areaId)!;
  const donorName = fields.org?.trim() || fields.name?.trim() || "A donor";
  const readyFrom = Math.max(now, num(b.readyFrom) ?? now);
  const collectBy = Math.max(readyFrom, num(b.collectBy) ?? readyFrom + config.defaultCollectWithinMs);
  const contact = isPhone(b.pickupContactPhone) ? b.pickupContactPhone : undefined;
  const cookedAt = num(b.cookedAt);

  return {
    donorPhone: session.phone,
    donorName,
    areaId,
    lat,
    lng,
    pickupAddress: str(b.pickupAddress) ?? `${donorName}, ${area.name}`,
    pickupNotes: str(b.pickupNotes, 300),
    pickupContactPhone: contact,
    readyFrom,
    collectBy,
    storage: STORAGE.includes(b.storage as Storage) ? (b.storage as Storage) : "room",
    cookedAt: cookedAt !== undefined && cookedAt <= now ? cookedAt : undefined,
    containers: strs(b.containers),
    items,
  };
}

/** What each party may see of a share: the restaurant gets the pickup code, the NGO the drop code, partners neither. */
function view(s: Share, who: "donor" | "ngo" | "partner" | "admin") {
  const { pickupCode, dropCode, ...rest } = s;
  return { ...rest, ...(who === "donor" || who === "admin" ? { pickupCode } : {}), ...(who === "ngo" || who === "admin" ? { dropCode } : {}) };
}

import { partnerClockOf } from "./partner-clock.ts";

export function matchingRoutes(luna: Luna, store: MatchingStore, clock: () => number = Date.now) {
  const app = new Hono();

  async function signedIn(c: Context, ...roles: Role[]): Promise<Session | Response> {
    const s = await sessionFrom(c.req.header("Authorization"));
    if (!s) return c.json({ error: "Not signed in." }, 401);
    if (!roles.includes(s.role) && s.role !== "admin") return c.json({ error: `Only for ${roles.join(" or ")} accounts.` }, 403);
    return s;
  }
  const actorOf = (s: Session): Actor => (s.role === "admin" ? { admin: true } : { phone: s.phone });
  const reply = (c: Context, r: Result) => (r.ok ? c.json(r) : c.json(r, (r.status ?? 409) as 400 | 403 | 404 | 409));
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  /** Which side of a share this session is on, if any. */
  async function sideOf(s: Session, share: Share): Promise<"donor" | "ngo" | "partner" | "admin" | null> {
    if (s.role === "admin") return "admin";
    const l = await store.get("listing", share.listingId);
    if (s.role === "donor" && l?.donorPhone === s.phone) return "donor";
    const ngoIds = [share.ngoId, share.redirect?.ngoId].filter(Boolean);
    if (s.role === "ngo" && (await store.list("recipient", { phone: s.phone })).some((r) => ngoIds.includes(r.id))) return "ngo";
    const pid = share.partnerId ?? share.askedPartnerId;
    if (s.role === "volunteer" && (await store.list("partner", { phone: s.phone })).some((p) => p.id === pid)) return "partner";
    return null;
  }

  /**
   * Live pings for whoever is signed in: the moment an agent sends them something, their app reloads.
   * fetch-based SSE (Authorization header), like the delivery streams, so tokens stay out of URLs.
   */
  app.get("/me/stream", async (c) => {
    const s = await signedIn(c, "donor", "ngo", "volunteer");
    if (s instanceof Response) return s;
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const queue: LivePing[] = [];
      let wake: (() => void) | null = null;
      const off = onPing(s.phone, (p) => { queue.push(p); wake?.(); });
      stream.onAbort(off);
      await stream.writeSSE({ event: "ready", data: "{}" });
      try {
        while (!stream.aborted) {
          if (!queue.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 20_000); });   // heartbeat every 20 s
          wake = null;
          if (queue.length) await stream.writeSSE({ event: "update", data: JSON.stringify(queue.splice(0)) });
          else await stream.writeSSE({ event: "heartbeat", data: "{}" });
        }
      } finally { off(); }
    });
  });

  /** Which sample NGO or partner this phone stands in for (linked by an admin). */
  app.get("/linked", async (c) => {
    const s = await signedIn(c, "donor", "ngo", "volunteer");
    if (s instanceof Response) return s;
    // A volunteer who just signed up (or an NGO that just listed) shouldn't wait for the minute sync.
    if (c.req.query("refresh") === "1" || (s.role === "volunteer" && !(await store.list("partner", { phone: s.phone })).length) || (s.role === "ngo" && !(await store.list("recipient", { phone: s.phone })).length))
      await syncDirectory(store);
    const recipients = s.role === "ngo" ? (await store.list("recipient", { phone: s.phone })).map((r) => ({ id: r.id, name: r.name, areaId: r.areaId })) : [];
    const partners =
      s.role === "volunteer" ? (await store.list("partner", { phone: s.phone })).map((p) => ({ id: p.id, name: p.name, online: p.online, ngoId: p.ngoId, helpsOthers: !!p.helpsOthers,
        reliability: { line: reliabilityLine(p.reliability), score: p.reliability?.score ?? null, trips: p.reliability?.trips ?? 0, onTime: p.reliability?.onTime ?? 0 } })) : [];
    return c.json({ recipients, partners });
  });

  /** What the agents told this person, newest first: the same words as WhatsApp, shown in the app. */
  app.get("/me/updates", async (c) => {
    const s = await signedIn(c, "donor", "ngo", "volunteer");
    if (s instanceof Response) return s;
    const mine = (await store.list("outbox", { to: s.phone })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
    return c.json(mine.map((m) => ({ id: m.id, at: m.createdAt, text: m.text })));
  });

  /** The listing's photos (one per food in a session), for anyone in this share's delivery (restaurant, NGO, partner). */
  async function sharePhotos(c: Context) {
    const s = await signedIn(c, "donor", "ngo", "volunteer");
    if (s instanceof Response) return s;
    const share = await store.get("share", c.req.param("id")!);
    const askedMe = share && s.role === "volunteer" && (await store.list("partner", { phone: s.phone })).some((p) => p.id === share.askedPartnerId);
    // A partner looking at the open pickups board sees the photos of what they could take.
    const onMyBoard = share && s.role === "volunteer" && share.status === "finding_partner" && (await luna.openPickups(s.phone, clock())).some((o) => o.share.id === share.id);
    if (!share || !(askedMe || onMyBoard || (await sideOf(s, share)))) return c.json({ error: "Not found." }, 404);
    const l = await store.get("listing", share.listingId);
    const src = l?.sourceListingId ? await foodListings.get(l.sourceListingId) : null;
    if (!src) return [];
    return (src.items?.length ? src.items.map((it) => ({ dish: it.dish, photo: it.photo })) : [{ dish: src.dish, photo: src.photo }]).filter((p) => !!p.photo);
  }

  /** Which photos there are: one per food, with its name, so a viewer can show them all. */
  app.get("/shares/:id/photos", async (c) => {
    const all = await sharePhotos(c);
    if (all instanceof Response) return all;
    return c.json({ photos: all.map((p, i) => ({ i, dish: p.dish })) });
  });

  /** One photo (`?i=` picks which food; the first by default). */
  app.get("/shares/:id/photo", async (c) => {
    const all = await sharePhotos(c);
    if (all instanceof Response) return all;
    const m = all[Math.max(0, Number(c.req.query("i") ?? 0) || 0)]?.photo.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!m) return c.json({ error: "No photo." }, 404);
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(Buffer.from(m[2], "base64"), 200, { "Content-Type": m[1] });
  });

  /* ---------- restaurant (donor) ---------- */

  app.post("/listings", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const parsed = parseListing(await c.req.json().catch(() => null), s, await authStore.getProfile(s.role, s.phone), clock());
    if ("error" in parsed) return c.json(parsed, 400);
    return c.json(await luna.submitListing(parsed, clock()), 201);
  });

  app.get("/listings", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const mine = await store.list("listing", { donorPhone: s.phone });
    return c.json(mine.sort((a, b) => b.createdAt - a.createdAt));
  });

  app.get("/listings/:id", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const l = await store.get("listing", c.req.param("id"));
    if (!l || (s.role !== "admin" && l.donorPhone !== s.phone)) return c.json({ error: "Not found." }, 404);
    const names = new Map((await store.list("recipient")).map((r) => [r.id, r.name]));
    const shares = (await store.list("share", { listingId: l.id })).map((sh) => ({ ...view(sh, s.role === "admin" ? "admin" : "donor"), ngoName: sh.ngoId ? names.get(sh.ngoId) : undefined }));
    const timeline = (await store.list("decision", { listingId: l.id })).sort((a, b) => -newestFirst(a, b));
    return c.json({ listing: l, shares, timeline });
  });

  app.post("/pledges/:id/:answer{yes|no}", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    return reply(c, await luna.gapReply(c.req.param("id"), c.req.param("answer") === "yes", actorOf(s), clock()));
  });

  /* ---------- live trip on the map (restaurant, NGO, partner) ---------- */

  /**
   * The live map for a share, as Server-Sent Events over fetch: a fresh view on every GPS fix and every step
   * (pickup, drop), and at least every few seconds. Each side sees what spec §12.7 allows (live-track.ts).
   */
  app.get("/shares/:id/live", async (c) => {
    const s = await signedIn(c, "donor", "ngo", "volunteer");
    if (s instanceof Response) return s;
    const id = c.req.param("id");
    const first = await store.get("share", id);
    const side = first && (await sideOf(s, first));
    if (!first || !side) return c.json({ error: "Not found." }, 404);
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      const off = onShare(id, () => wake?.());
      stream.onAbort(off);
      let last = "", quietSince = Date.now();
      try {
        while (!stream.aborted) {
          const share = await store.get("share", id);
          if (!share) break;
          const view = JSON.stringify(await liveTrack(store, share, side, clock()));
          if (view !== last) {
            await stream.writeSSE({ event: "snapshot", data: view });
            last = view;
            quietSince = Date.now();
          } else if (Date.now() - quietSince > 15_000) {
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
            quietSince = Date.now();
          }
          await new Promise<void>((r) => ((wake = r), setTimeout(r, 3_000)));
          wake = null;
        }
      } finally {
        off();
      }
    });
  });

  app.get("/shares/:id/track", async (c) => {
    const s = await signedIn(c, "donor", "ngo", "volunteer");
    if (s instanceof Response) return s;
    const share = await store.get("share", c.req.param("id"));
    if (!share || !(await sideOf(s, share))) return c.json({ error: "Not found." }, 404);
    return c.json(await luna.track(share, clock()));
  });

  /* ---------- NGO ---------- */

  app.get("/shares", async (c) => {
    const s = await signedIn(c, "ngo");
    if (s instanceof Response) return s;
    const mine = new Set((await store.list("recipient", { phone: s.phone })).map((r) => r.id));
    const shares = (await store.list("share")).filter((sh) => (sh.ngoId && mine.has(sh.ngoId)) || (sh.redirect && mine.has(sh.redirect.ngoId)));
    // The NGO's own volunteers, with their numbers, so it can call them when nobody has taken a pickup.
    const volunteers = (await store.list("partner")).filter((p) => p.ngoId && mine.has(p.ngoId) && !p.manual && p.phone)
      .map((p) => ({ name: p.name, phone: p.phone!, online: p.online, busy: !!p.activeShareId }))
      .sort((a, b) => Number(b.online) - Number(a.online) || Number(a.busy) - Number(b.busy) || a.name.localeCompare(b.name));
    const out = [];
    for (const sh of shares.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)) {
      const l = await store.get("listing", sh.listingId);
      const waiting = sh.status === "finding_partner" && l;
      out.push({ ...view(sh, "ngo"), donorName: l?.donorName, food: sh.lines.map((ln) => {
        const item = l?.items.find((i) => i.id === ln.itemId);
        return { ...item, servings: ln.servings, ...(item && l ? { grade: effectiveGrade(item), safeUntil: safeUntil(item, l.createdAt) } : {}) };
      }), ...(waiting ? { partnerClock: await partnerClockOf(store, sh, l, clock()), volunteers } : {}) });
    }
    return c.json(out);
  });

  app.post("/shares/:id/:answer{accept|decline}", async (c) => {
    const s = await signedIn(c, "ngo");
    if (s instanceof Response) return s;
    return reply(c, await luna.ngoReply(c.req.param("id"), c.req.param("answer") === "accept", actorOf(s), clock()));
  });

  app.post("/shares/:id/redirect/:answer{accept|decline}", async (c) => {
    const s = await signedIn(c, "ngo");
    if (s instanceof Response) return s;
    return reply(c, await luna.redirectReply(c.req.param("id"), c.req.param("answer") === "accept", actorOf(s), clock()));
  });

  /** Coordinator assigns someone by hand (e.g. staff not on the app). */
  app.post("/shares/:id/assign", async (c) => {
    const s = await signedIn(c, "ngo");
    if (s instanceof Response) return s;
    const b = await body(c);
    const name = str(b.name, 80);
    if (!name) return c.json({ error: "Enter the name of the person collecting." }, 400);
    if (b.phone !== undefined && !isPhone(b.phone)) return c.json({ error: "Enter a 10-digit Indian mobile number, or leave it out." }, 400);
    return reply(c, await luna.assignManual(c.req.param("id"), { name, phone: b.phone as string | undefined }, actorOf(s), clock()));
  });

  app.post("/shares/:id/feedback", async (c) => {
    const s = await signedIn(c, "ngo");
    if (s instanceof Response) return s;
    const { result } = await body(c);
    if (result !== "fewer" && result !== "right" && result !== "more") return c.json({ error: "result must be fewer, right or more." }, 400);
    return reply(c, await luna.feedback(c.req.param("id"), result, actorOf(s), clock()));
  });

  /* ---------- delivery partner (volunteer accounts) ---------- */

  app.post("/partner/online", async (c) => {
    const s = await signedIn(c, "volunteer");
    if (s instanceof Response) return s;
    const b = await body(c);
    if (typeof b.online !== "boolean") return c.json({ error: "Send online: true or false." }, 400);
    const lat = num(b.lat);
    const lng = num(b.lng);
    return reply(c, await luna.setOnline(s.phone, b.online, lat !== undefined && lng !== undefined ? { lat, lng } : undefined));
  });

  /** A share as a partner sees it: the trip, how far, the pickup details (contact only once it's theirs). */
  async function tripView(sh: Share, phone: string, mine: Set<string>) {
    const l = await store.get("listing", sh.listingId);
    // The pickup contact is only for the partner actually on the trip.
    const onTrip = !!sh.partnerId && mine.has(sh.partnerId);
    const pickupDetails = l && { address: l.pickupAddress, notes: l.pickupNotes, contact: onTrip ? (l.pickupContactPhone ?? l.donorPhone) : undefined };
    // how long to reach the restaurant from where this partner is, and then the NGO
    const me = (await store.list("partner", { phone }))[0];
    const ngo = sh.ngoId ? await store.get("recipient", sh.ngoId) : null;
    const travel = l && me ? { toPickupMin: Math.max(1, Math.round(etaMs(distanceKm(me, l), me.travel) / 60_000)), toDropMin: ngo ? Math.max(1, Math.round(etaMs(distanceKm(l, ngo), me.travel) / 60_000)) : null } : null;
    return { ...view(sh, "partner"), ...(await luna.track(sh, clock())), pickupDetails, travel, servings: sh.lines.reduce((n, x) => n + x.servings, 0), hasPhoto: !!l?.sourceListingId };
  }

  app.get("/trips", async (c) => {
    const s = await signedIn(c, "volunteer");
    if (s instanceof Response) return s;
    const mine = new Set((await store.list("partner", { phone: s.phone })).map((p) => p.id));
    const trips = (await store.list("share")).filter((sh) => mine.has(sh.partnerId ?? sh.askedPartnerId ?? ""));
    const out = [];
    for (const sh of trips.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)) out.push(await tripView(sh, s.phone, mine));
    return c.json(out);
  });

  /** The open pickups board: accepted by an NGO, taken by nobody, and reachable by me (ones I missed are marked). */
  app.get("/partner/open", async (c) => {
    const s = await signedIn(c, "volunteer");
    if (s instanceof Response) return s;
    const mine = new Set((await store.list("partner", { phone: s.phone })).map((p) => p.id));
    const out = [];
    for (const { share, missed, reach } of await luna.openPickups(s.phone, clock()))
      out.push({ ...(await tripView(share, s.phone, mine)), missed, reach, waitingSince: share.waitingForPartnerSince ?? share.askedAt ?? share.createdAt });
    return c.json(out);
  });

  app.post("/trips/:id/claim", async (c) => {
    const s = await signedIn(c, "volunteer");
    if (s instanceof Response) return s;
    return reply(c, await luna.claimPickup(c.req.param("id"), actorOf(s), clock()));
  });

  app.post("/trips/:id/:answer{accept|decline}", async (c) => {
    const s = await signedIn(c, "volunteer");
    if (s instanceof Response) return s;
    return reply(c, await luna.partnerReply(c.req.param("id"), c.req.param("answer") === "accept", actorOf(s), clock()));
  });

  app.post("/trips/:id/late", async (c) => {
    const s = await signedIn(c, "volunteer");
    if (s instanceof Response) return s;
    return reply(c, await luna.late(c.req.param("id"), actorOf(s), clock()));
  });

  app.post("/trips/:id/location", async (c) => {
    const s = await signedIn(c, "volunteer");
    if (s instanceof Response) return s;
    const b = await body(c);
    const lat = num(b.lat);
    const lng = num(b.lng);
    if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) return c.json({ error: "Send lat and lng." }, 400);
    // Optional, straight from the phone's GPS: how accurate, how fast (m/s) and which way (degrees).
    const accuracy = num(b.accuracyM), speed = num(b.speedMps), heading = num(b.heading);
    const fix = {
      accuracyM: accuracy !== undefined && accuracy >= 0 && accuracy <= 5000 ? accuracy : undefined,
      speedMps: speed !== undefined && speed >= 0 && speed < 70 ? speed : null,
      heading: heading !== undefined && heading >= 0 && heading < 360 ? heading : null,
    };
    const r = await luna.location(c.req.param("id"), { lat, lng }, actorOf(s), clock(), fix);
    if (r.ok) pingShare(c.req.param("id"));
    return reply(c, r);
  });

  /** Pickup code (from the restaurant) and drop code (from the NGO). An NGO coordinator enters them for a hand-assigned partner. */
  app.post("/trips/:id/:which{pickup|drop}", async (c) => {
    const s = await signedIn(c, "volunteer", "ngo");
    if (s instanceof Response) return s;
    const { code } = await body(c);
    if (typeof code !== "string") return c.json({ error: "Send the 4-digit code." }, 400);
    const r = await luna.enterCode(c.req.param("id"), c.req.param("which") as "pickup" | "drop", code, actorOf(s), clock());
    if (r.ok) pingShare(c.req.param("id"));   // the map switches to the drop, or closes
    return reply(c, r);
  });

  /* ---------- admin ---------- */

  app.get("/admin/decisions", async (c) => {
    const s = await signedIn(c, "admin");
    if (s instanceof Response) return s;
    const listingId = c.req.query("listingId");
    const since = Number(c.req.query("since") ?? 0);
    const limit = Math.min(500, Number(c.req.query("limit") ?? 200));
    const all = await store.list("decision", listingId ? { listingId } : undefined);
    return c.json(all.filter((d) => d.at > since).sort(newestFirst).slice(0, limit));
  });

  app.get("/admin/escalations", async (c) => {
    const s = await signedIn(c, "admin");
    if (s instanceof Response) return s;
    const all = await store.list("decision", { kind: "escalated" });
    return c.json(all.sort(newestFirst).slice(0, 200));
  });

  app.get("/admin/listings", async (c) => {
    const s = await signedIn(c, "admin");
    if (s instanceof Response) return s;
    const status = c.req.query("status");
    const all = await store.list("listing", status ? { status } : undefined);
    return c.json(all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100));
  });

  app.post("/admin/listings/:id/approve", async (c) => {
    const s = await signedIn(c, "admin");
    if (s instanceof Response) return s;
    return reply(c, await luna.approveListing(c.req.param("id"), clock()));
  });

  app.get("/admin/:kind{recipients|partners}", async (c) => {
    const s = await signedIn(c, "admin");
    if (s instanceof Response) return s;
    const kind = c.req.param("kind") === "recipients" ? "recipient" : "partner";
    const all = await store.list(kind);
    return c.json(all.sort((a, b) => a.id.localeCompare(b.id)));
  });

  app.post("/admin/:kind{recipients|partners}/:id/claim", async (c) => {
    const s = await signedIn(c, "admin");
    if (s instanceof Response) return s;
    const { phone } = await body(c);
    if (!isPhone(phone)) return c.json({ error: "Enter a 10-digit Indian mobile number." }, 400);
    const kind = c.req.param("kind") === "recipients" ? "recipient" : "partner";
    return reply(c, await luna.claim(kind, c.req.param("id"), phone));
  });

  app.post("/admin/gaps/run", async (c) => {
    const s = await signedIn(c, "admin");
    if (s instanceof Response) return s;
    return c.json(await luna.runGaps(clock()));
  });

  return app;
}
