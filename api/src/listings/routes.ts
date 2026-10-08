import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sessionFrom } from "../auth.ts";
import { store, type Session } from "../store.ts";
import { TRIP_CONFIG as C } from "../trips/config.ts";
import { acceptShare, canView, createTrip, event, requestPartners } from "../trips/engine.ts";
import { trips } from "../trips/repository.ts";
import { mutate, TripError } from "../trips/service.ts";
import { validPoint } from "../trips/geo.ts";
import type { TripInput } from "../trips/types.ts";
import { listings } from "./repository.ts";
import { assertOfferOpen, startNgoOffer, tickNgoOffers } from "./offers.ts";
import { currentScenario, localScenarioEnabled, provisionScenario, scenarioFor } from "./scenario.ts";
import { applyFoodCheck, foodAgentUrl, requestFoodCheck, servingsOf } from "./foodCheck.ts";
import { applySessionCheck, checkItems, parseSession } from "./session.ts";
import { agents, matchingStore } from "../matching/index.ts";
import { syncDirectory } from "../matching/directory.ts";
import { ping } from "../matching/live.ts";
import { passportFrom } from "../matching/bridge.ts";
import { packingLines, shareContainers } from "../matching/food-agent.ts";
import type { AgentCase } from "./types.ts";
import { FOOD_CATEGORIES, type FoodListing, type ListingInput, type ListingView } from "./types.ts";

type Env = { Variables: { session: Session } };
export const food = new Hono<Env>();
const owned = (path: string) => /^\/(listings|offers|app-demo)(\/|$)/.test(path);
const limit = bodyLimit({ maxSize: C.maxRequestBytes, onError: c => c.json({ error: "Compress the food photo before submitting." }, 413) });
food.onError((err, c) => {
  if (err instanceof TripError) return c.json({ error: err.message }, err.status);
  console.error("listing request failed", err.name);
  return c.json({ error: "The food listing could not be updated. Please retry." }, 503);
});
food.use("*", (c, next) => owned(c.req.path) ? limit(c, next) : next());
food.post("/app-demo/start", async c => {
  if (!localScenarioEnabled()) return c.json({ error: "This walkthrough needs the local demo API." }, 403);
  const key = actionKey(c.req.header("Idempotency-Key"));
  c.header("Cache-Control", "no-store");
  return c.json(await provisionScenario(key), 201);
});
food.get("/app-demo/current", c => {
  if (!localScenarioEnabled()) return c.json({ error: "This walkthrough needs the local demo API." }, 403);
  c.header("Cache-Control", "no-store");
  const scenario = currentScenario();
  return scenario ? c.json(scenario) : c.json({ error: "No walkthrough accounts yet." }, 404);
});
food.use("*", async (c, next) => {
  if (!owned(c.req.path)) return next();
  const s = await sessionFrom(c.req.header("Authorization"));
  if (!s) return c.json({ error: "Sign in to view food listings." }, 401);
  c.set("session", s); c.header("Cache-Control", "no-store"); return next();
});
food.get("/listings", async c => {
  const s = c.get("session");
  if (s.role !== "donor" && s.role !== "admin") throw new TripError("Donor or reviewer access required.", 403);
  const values = (await listings.list()).filter(l => s.role === "admin" || l.donorPhone === s.phone);
  return c.json({ listings: await Promise.all(values.map(l => listingView(l, s))) });
});
food.post("/listings", async c => {
  const s = c.get("session"), now = Date.now();
  if (s.role !== "donor") throw new TripError("Only donors can post food.", 403);
  const profile = await store.getProfile("donor", s.phone);
  if (!profile) throw new TripError("Finish your donor profile first.", 400);
  const raw = await c.req.json().catch(() => null);
  // "replaces": relisting food whose photo didn't match its veg / non-veg label.
  const { replaces, ...sent } = raw && typeof raw === "object" ? raw as Record<string, unknown> : { replaces: undefined };
  // A session lists several foods at once (items[]); a single-dish body still works.
  const session = Array.isArray(sent.items) ? parseSession(sent, now) : null;
  if (session && "error" in session) throw new TripError(session.error, 400);
  const body = (session ? session.input : sent) as ListingInput;
  // the shared fields (pickup, timing, containers, contact, declaration) are checked the same way
  if (!validListing(session ? { ...body, count: Math.min((body as ListingInput).count, 200) } : body, now)) throw new TripError("Complete the food, photo, tags, timing, pickup details and declaration.", 400);
  const key = actionKey(c.req.header("Idempotency-Key"));
  const id = `lst_${createHash("sha256").update(`${s.phone}:${key}`).digest("hex").slice(0, 24)}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(sent)).digest("hex");
  const existing = await listings.get(id);
  if (existing && existing.fingerprint !== fingerprint) throw new TripError("This submission key was already used for different food.");
  const value: FoodListing = { ...body, id, version: 1, donorPhone: s.phone, donorName: profile.fields.org || profile.fields.name,
    createdAt: now, fingerprint, sample: !!scenarioFor(s.phone), state: "in_review", approval: null, assessment: null, foodCheck: null,
    ...(session ? { items: session.items } : {}) };
  const background = !!foodAgentUrl();
  if (!existing) {
    // Real listings go straight on to the agents; a new donor's first one is flagged for the Luna team to
    // double-check alongside. The walkthrough keeps its blocking review step.
    const approvedBefore = (await listings.list()).some(l => l.donorPhone === s.phone && !!l.approval);
    if (approvedBefore || !value.sample) value.state = "checking";
    if (!approvedBefore && !value.sample) value.reviewPending = true;
    // Without a Food Agent the rules-only grade is instant; with one, the check runs after the reply.
    if (!background) {
      if (value.items) applySessionCheck(value, await checkItems(value));
      else applyFoodCheck(value, await requestFoodCheck(value));
    }
    if (value.state === "checking" && value.foodCheck && value.sample) assessScenario(value, now);
    if (await listings.create(value) && background) void checkListing(id);
  }
  const saved = existing ?? value;
  if (typeof replaces === "string") await markReplaced(replaces, s.phone, id);
  if (saved.state === "offered") await ensureScenarioOffer(saved);
  return c.json({ id, listingUrl: `/listings/${id}` }, 201);
});
food.get("/listings/:id", async c => {
  const value = await listings.get(c.req.param("id"));
  if (!value) throw new TripError("Listing not found.", 404);
  return c.json(await listingView(value, c.get("session")));
});
food.post("/listings/:id/approve", async c => {
  const s = c.get("session"); if (s.role !== "admin") throw new TripError("Reviewer access required.", 403);
  const key = actionKey(c.req.header("Idempotency-Key")), body = await c.req.json().catch(() => ({}));
  if (typeof body?.reason !== "string" || !body.reason.trim() || body.reason.length > 200) throw new TripError("Enter a short review reason.", 400);
  let value: FoodListing | null = null;
  for (let attempt = 0; attempt < C.casRetries; attempt++) {
    value = await listings.get(c.req.param("id")); if (!value) throw new TripError("Listing not found.", 404);
    if (value.approval) {
      if (value.approval.key !== key || value.approval.reason !== body.reason.trim()) throw new TripError("This listing has already been reviewed.");
      break;
    }
    const now = Date.now(), reviewer = await store.getProfile("admin", s.phone);
    value.approval = { by: reviewer?.fields.name ?? "Luna reviewer", at: now, reason: body.reason.trim(), key };
    value.reviewPending = false;
    if (value.state === "tags_held") value.heldFrom = "checking";
    else if (value.state === "in_review") value.state = "checking";
    // Only the isolated walkthrough offers food here; real NGO matching remains external.
    if (value.state === "checking" && value.foodCheck && value.sample && scenarioFor(value.donorPhone)) assessScenario(value, now);
    const version = value.version; value.version++;
    if (await listings.save(value, version)) break;
    value = null;
  }
  if (!value) throw new TripError("The listing changed during review. Retry.");
  if (value.state === "offered") await ensureScenarioOffer(value);
  if (value.state === "checking") value = await handOff(value.id) ?? value;
  return c.json(await listingView(value, s));
});
food.get("/offers", async c => {
  const s = c.get("session"); if (s.role !== "ngo") throw new TripError("NGO access required.", 403);
  await tickNgoOffers();
  const all = await trips.list();
  const own = all.filter(t => t.ngoPhone === s.phone && t.offer?.status === "pending" && t.offer.deadline > Date.now() && !t.shareAcceptedAt && t.collectBy > Date.now() && t.safeUntil > Date.now());
  const views: ListingView[] = [];
  for (const t of own) { const l = await listings.get(t.listingId); if (l) views.push(await listingView(l, s)); }
  const expired = all.flatMap(t => (t.offer?.history ?? []).filter(h => h.phone === s.phone).map(h => ({ id: t.listingId, at: h.at, reason: `This offer ended at ${new Date(h.deadline).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}.${t.offer?.status !== "exhausted" ? ` The food was offered to ${t.drop.name} next.` : " Luna is finding another safe option."}` }))).sort((a, b) => b.at - a.at).slice(0, 3);
  return c.json({ offers: views, expired });
});
food.post("/offers/:id/accept", async c => {
  const s = c.get("session"), l = await listings.get(c.req.param("id"));
  if (s.role !== "ngo" || !l) throw new TripError("Offer not found.", 404);
  const scn = scenarioFor(l.donorPhone);
  const id = tripId(l.id), key = actionKey(c.req.header("Idempotency-Key"));
  await tickNgoOffers();
  const current = await trips.get(id);
  if (!current?.offer || l.sample && !scn) throw new TripError("The Logistics Agent must confirm this offer before acceptance.", 503);
  if (current?.offer?.history.some(h => h.phone === s.phone)) throw new TripError("Sorry, your offer deadline passed and the food has gone to the next eligible NGO.");
  const candidates: { phone: string; name: string }[] = [];
  const active = await trips.list();
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(Date.now()));
  const night = hour >= 21 || hour < 6;
  for (const phone of current.offer.partnerPhones) {
    const profile = await store.getProfile("volunteer", phone);
    // Production candidate membership/capacity/route eligibility comes from the trusted agent.
    if (profile?.fields.online === "true" && (!night || profile.fields.nightTasks === "true") && (!scn || (profile.fields.affiliatedNgo === s.phone || profile.fields.affiliatedNgos?.split(",").includes(s.phone)) && Number(profile.fields.capacity) >= (l.assessment?.servings ?? Infinity)) && !active.some(t => t.partnerPhone === profile.phone && t.requestStatus === "accepted" && !t.closedAt)) candidates.push({ phone: profile.phone, name: profile.fields.name });
  }
  try {
    const t = await mutate(id, s, key, { action: "accept-offer", listingId: l.id }, next => {
      if (s.phone !== next.ngoPhone || !l.assessment) throw new Error("This offer is not for your NGO.");
      const now = Date.now(), serveAt = Math.max(now, l.readyFrom) + 45 * 60_000;
      assertOfferOpen(next, now);
      if (serveAt > next.safeUntil || now >= next.collectBy) throw new Error("This offer no longer fits the food's safety deadline.");
      acceptShare(next, now);
      // NGO acceptance triggers the tier-one wave; no coordinator send action exists.
      if (candidates.length) requestPartners(next, candidates, now);
      else event(next, "partner.search_waiting", "No eligible affiliated volunteers are online. The Logistics Agent needs to continue the partner search.", now);
    });
    return c.json({ id: t.id, trackingUrl: `/deliveries?id=${t.id}` });
  } catch (e) { if (e instanceof TripError) throw e; throw new TripError((e as Error).message); }
});

export const tripId = (listingId: string) => `dlv_${listingId.slice(4)}`;

/** Runs the Food Agent for one listing and records the result (compare-and-set, retried). */
/**
 * The background worker. Everything a listing needs after the donor submits runs on the server from
 * Postgres, whether or not anyone is signed in: an interrupted food check (e.g. a restart mid-check) is
 * run again, and checked food that hasn't reached the agents is handed over. Runs on start and every 30 s.
 */
export async function sweepListings(now = Date.now()) {
  let checked = 0;
  for (const l of await listings.list()) {
    if (l.foodCheck || l.sample || !["checking", "in_review"].includes(l.state)) continue;
    if (now - l.createdAt < 60_000 || now - l.cookedAt > 72 * 60 * 60_000) continue;   // let the first attempt finish
    await checkListing(l.id); checked++;
  }
  const handed = await handOffWaiting(now);
  return { checked, handed };
}

/** On start: checked listings still safe and collectable that never reached the agents get their case. */
export async function handOffWaiting(now = Date.now()) {
  let n = 0;
  for (const old of await listings.list()) {
    if (old.state !== "in_review" || old.sample || !old.foodCheck) continue;
    const l = structuredClone(old);
    l.state = l.foodCheck!.tagsVerdict && l.foodCheck!.tagsVerdict !== "ok" ? "tags_held" : l.assessment ? "checking" : "not_for_people";
    if (l.state === "tags_held") l.heldFrom = "checking";
    l.reviewPending = true;
    const version = l.version; l.version++;
    await listings.save(l, version);
  }
  for (const l of await listings.list())
    if (l.state === "checking" && !l.sample && l.assessment && l.assessment.safeUntil > now && l.collectBy > now && (!l.matchId || l.matchId.startsWith("MATCH-")))
      if ((await handOff(l.id, now))?.matchId) n++;
  return n;
}
/** The donor keeps tags the photo check was only unsure about; the listing carries on where it was held. */
food.post("/listings/:id/keep-tags", async c => {
  const s = c.get("session");
  for (let attempt = 0; attempt < C.casRetries; attempt++) {
    const l = await listings.get(c.req.param("id"));
    if (!l || s.role !== "donor" || l.donorPhone !== s.phone) throw new TripError("Listing not found.", 404);
    if (l.state !== "tags_held") return c.json(await listingView(l, s));
    if (l.replacedBy) throw new TripError("You already relisted this food.");
    if (l.foodCheck?.tagsVerdict !== "unsure") throw new TripError("The photo clearly doesn't match these tags. Relist it with the suggested tags.");
    l.tagsKeptAt = Date.now(); l.state = l.heldFrom ?? "checking";
    if (l.state === "checking" && l.sample && scenarioFor(l.donorPhone)) assessScenario(l, Date.now());
    const version = l.version; l.version++;
    if (await listings.save(l, version)) {
      if ((l.state as FoodListing["state"]) === "offered") await ensureScenarioOffer(l);
      return c.json(await listingView(await handOff(l.id) ?? l, s));
    }
  }
  throw new TripError("The listing changed. Try again.");
});
/** The old listing points at its corrected relisting; only the donor's own held listing can be replaced. */
async function markReplaced(oldId: string, phone: string, newId: string) {
  for (let attempt = 0; attempt < C.casRetries; attempt++) {
    const old = await listings.get(oldId);
    if (!old || old.donorPhone !== phone || old.state !== "tags_held" || old.replacedBy) return;
    old.replacedBy = newId;
    const version = old.version; old.version++;
    if (await listings.save(old, version)) return;
  }
}
/**
 * Food Agent → Decision Agent. A checked listing that isn't held (review, tags, unsafe) becomes a Food
 * Passport and opens a case: the NGO Agent ranks and splits, the Logistics Agent offers and delivers.
 * Walkthrough (sample) listings keep their own scripted offer.
 */
export async function handOff(id: string, now = Date.now()): Promise<FoodListing | null> {
  const first = await listings.get(id);
  const luna = agents();
  // "MATCH-…" ids came from the retired Python matcher; those listings get a real case now.
  const handed = !!first?.matchId && !first.matchId.startsWith("MATCH-");
  if (!luna || !first || first.state !== "checking" || !first.foodCheck || !first.assessment || first.sample || handed) return first;
  let matchId: string;
  await syncDirectory(matchingStore);   // NGOs' latest default/today listings and partners before ranking
  try {
    matchId = (await luna.submitListing(passportFrom(first, now), now, { reviewed: true })).id;
    // The Food Agent's verdict opens the case's log, like every other agent's decision.
    const c = first.foodCheck, model = c.models?.photo ? ` Photo judged by ${c.models.photo.replace(/^[^:]*:/, "")}.` : " Photo not judged by AI.";
    await matchingStore.insert("decision", { id: `d-food-${first.id}`, at: now - 1, agent: "food", kind: "graded", subject: matchId, listingId: matchId,
      reason: `Checked ${first.dish}: Grade ${c.grade}, ${first.assessment.servings} servings, safe until ${new Date(first.assessment.safeUntil).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}${c.unsure ? ", unsure (the partner checks it at pickup)" : ""}.${model}` });
  }
  catch (e) { console.error("case handoff failed", (e as Error).message); return first; }
  for (let attempt = 0; attempt < C.casRetries; attempt++) {
    const l = await listings.get(id);
    if (!l || (l.matchId && !l.matchId.startsWith("MATCH-"))) return l;
    l.matchId = matchId;
    const version = l.version; l.version++;
    if (await listings.save(l, version)) return l;
  }
  return null;
}
const checking = new Set<string>();   // food checks in flight in this process, so the sweep doesn't start a second
export async function checkListing(id: string) {
  if (checking.has(id)) return;
  checking.add(id);
  try { await runCheck(id); } finally { checking.delete(id); }
}
async function runCheck(id: string) {
  const first = await listings.get(id);
  if (!first || first.foodCheck) return;
  // a session checks every food (in parallel); a single dish has one check
  const checks = first.items ? await checkItems(first) : [await requestFoodCheck(first)];
  for (let attempt = 0; attempt < C.casRetries; attempt++) {
    const l = await listings.get(id);
    if (!l || l.foodCheck) return;
    if (l.items) applySessionCheck(l, checks); else applyFoodCheck(l, checks[0]);
    if (l.state === "checking" && l.sample && scenarioFor(l.donorPhone)) assessScenario(l, Date.now());
    const version = l.version; l.version++;
    if (await listings.save(l, version)) {
      ping(l.donorPhone, "food_check");
      if (l.state === "offered") await ensureScenarioOffer(l).catch(e => console.error("walkthrough offer failed", (e as Error).message));
      if (l.state === "checking") await handOff(id);
      return;
    }
  }
  console.error(`food check for ${id} could not be saved`);
}
/** The agents' case: its shares (pickup code only for the donor and admin) and the decision timeline. */
async function caseOf(caseId: string, withCode: boolean): Promise<AgentCase | null> {
  const c = await matchingStore.get("listing", caseId);
  if (!c) return null;
  const shares = await matchingStore.list("share", { listingId: caseId });
  const out: AgentCase["shares"] = [];
  for (const sh of shares.sort((a, b) => a.createdAt - b.createdAt)) {
    const ngo = sh.ngoId ? await matchingStore.get("recipient", sh.ngoId) : null;
    const partner = sh.partnerId ? await matchingStore.get("partner", sh.partnerId) : null;
    out.push({ id: sh.id, lines: packingLines(c, sh.lines).map(p => ({ name: p.name, servings: p.servings, amount: p.amount })), containers: shareContainers(c, sh.lines),
      status: sh.status, servings: sh.lines.reduce((n, x) => n + x.servings, 0), ngoName: ngo?.name ?? null,
      offerDeadlineAt: sh.status === "offering" ? sh.offerDeadlineAt ?? null : null, partnerName: partner?.name ?? null,
      pickupCode: withCode && (sh.status === "assigned" || sh.status === "finding_partner") ? sh.pickupCode : null,
      arriveBy: sh.arriveBy ?? null, pickedUpAt: sh.pickedUpAt ?? null, held: !!sh.held });
  }
  const timeline = (await matchingStore.list("decision", { listingId: caseId }))
    .filter(d => d.kind !== "filtered").sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0))
    .map(d => ({ at: d.at, agent: d.agent ?? null, kind: d.kind, reason: d.reason }));
  const ranked: AgentCase["ranked"] = [];
  for (const cand of shares[0]?.candidates ?? []) {
    const r = await matchingStore.get("recipient", cand.ngoId);
    if (r) ranked.push({ ngoName: r.name, arriveBy: cand.arriveBy });
  }
  return { id: c.id, status: c.status, unplacedServings: c.unplacedServings, shares: out, ranked, timeline };
}
function caseProgress(c: AgentCase, lead: AgentCase["shares"][number] | undefined) {
  if (!lead) return c.unplacedServings ? "No NGO can safely take it in time · the Luna team is on it" : "Finding the right NGO";
  switch (lead.status) {
    case "offering": return `Offered to ${lead.ngoName} · waiting for them to accept`;
    case "finding_partner": return `${lead.ngoName} accepted · finding a delivery partner`;
    case "assigned": return `${lead.partnerName ?? "A partner"} is coming to collect`;
    case "picked_up": return `On the way to ${lead.ngoName}`;
    case "delivered": return `Delivered to ${lead.ngoName}`;
    default: return "Finding the right NGO";
  }
}
export async function listingView(l: FoodListing, s: Session): Promise<ListingView> {
  const t = await trips.get(tripId(l.id));
  const agentCase = l.matchId ? await caseOf(l.matchId, s.role === "donor" || s.role === "admin") : null;
  const live = agentCase?.shares.filter(x => x.status !== "unplaced" && x.status !== "failed") ?? [];
  const lead = live.find(x => x.status === "delivered") ?? live.find(x => x.status === "picked_up") ?? live.find(x => x.status === "assigned") ?? live.find(x => x.status === "finding_partner") ?? live[0];
  if (!(s.role === "admin" || s.role === "donor" && s.phone === l.donorPhone || s.role === "ngo" && t && canView(t, s))) throw new TripError("Listing not found.", 404);
  const { donorPhone: _phone, fingerprint: _fingerprint, contactPhone: _contact, pickup, approval, ...publicFields } = l;
  const accepted = !!t?.shareAcceptedAt;
  const hidden = !!t?.closedAt && Date.now() > t.closedAt + C.contactAfterCloseMs;
  const exact = !hidden && (s.role === "donor" || s.role === "admin" || accepted);
  const delivered = t?.status === "delivered";
  return { ...publicFields, ...(t?.pickedUpAt ? { count: t.receipt?.servings ?? t.servings, feedsEach: 1, assessment: l.assessment ? { ...l.assessment, servings: t.receipt?.servings ?? t.servings } : null } : {}), pickup: exact ? pickup : null, pickupArea: pickup.area,
    approval: approval ? { by: approval.by, at: approval.at, reason: approval.reason } : null,
    progress: l.state === "not_for_people" ? "Not safe for people · see the food check" : l.state === "tags_held" ? (l.replacedBy ? "Relisted with corrected tags" : l.foodCheck?.tagsVerdict === "wrong" ? "Tags don't match the photo · relist it" : "Check your tags · relist or keep them") : delivered ? "Delivered" : t?.status === "failed_at_pickup" ? "Food did not pass pickup checks" : t?.pickedUpAt ? "On the way to the NGO" : accepted ? "NGO accepted · pickup arranged" : t?.offer?.status === "exhausted" ? "NGO offer expired · finding another safe option" : t?.offer?.history.length ? `${t.offer.history.at(-1)!.name} did not reply · asking ${t.drop.name} next` : l.state === "offered" ? "Food checked · NGO offer sent" : l.state === "checking" ? (agentCase ? caseProgress(agentCase, lead) : l.assessment && l.assessment.safeUntil < Date.now() ? "No longer safe to give out" : l.foodCheck ? "Food checked · finding the right NGO" : "Checking your food") : l.state === "unplaced" ? "This food cannot be offered in this walkthrough" : "First listing · awaiting Luna review",
    tripId: t?.id ?? null, trackingUrl: accepted && t ? `/deliveries?id=${t.id}` : null,
    recipientName: accepted && t ? t.drop.name : lead && lead.status !== "offering" ? lead.ngoName : null, deliveredAt: delivered ? t!.closedAt : [...agentCase?.timeline ?? []].reverse().find(d => d.kind === "delivered")?.at ?? null,
    offerDeadline: t?.offer?.status === "pending" ? t.offer.deadline : null, offerRecipientName: t?.offer?.status === "pending" ? t.drop.name : null, serverNow: Date.now(), agentCase };
}
function actionKey(key: string | undefined) { if (!key || key.length > 200) throw new TripError("An Idempotency-Key is required.", 400); return key; }
const allergens = ["dairy", "nuts", "peanuts", "gluten", "egg", "soy", "sesame", "seafood", "onion_garlic"];
export function validListing(v: unknown, now: number): v is ListingInput {
  if (!v || typeof v !== "object") return false; const b = v as ListingInput;
  return typeof b.dish === "string" && !!b.dish.trim() && b.dish.length <= 120 && ["veg", "egg", "nonveg"].includes(b.diet) && typeof b.jain === "boolean"
    && ["yes", "no", "unsure"].includes(b.halal) && ["mild", "medium", "hot"].includes(b.spice) && Array.isArray(b.contains) && b.contains.length <= allergens.length && b.contains.every(a => allergens.includes(a))
    && !(b.jain && (b.diet !== "veg" || b.contains.some(a => ["egg", "seafood", "onion_garlic"].includes(a))))
    && ["per_person_pack", "shared_pack"].includes(b.entryMode) && Number.isInteger(b.count) && b.count > 0 && b.count <= 200 && Number.isInteger(b.feedsEach) && b.feedsEach > 0 && b.feedsEach <= 50 && (b.entryMode !== "per_person_pack" || b.feedsEach === 1)
    && typeof b.photo === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.photo) && b.photo.length <= C.maxPhotoBytes
    && Number.isFinite(b.cookedAt) && b.cookedAt <= now && b.cookedAt >= now - 72 * 60 * 60_000 && ["hot", "room", "fridge"].includes(b.storage)
    && Number.isFinite(b.readyFrom) && b.readyFrom >= now - 5 * 60_000 && b.readyFrom <= now + 24 * 60 * 60_000 && Number.isFinite(b.collectBy) && b.collectBy > Math.max(now, b.readyFrom) && b.collectBy <= now + 25 * 60 * 60_000
    && (b.category === undefined || FOOD_CATEGORIES.includes(b.category)) && (b.temperatureC === undefined || b.temperatureC === null || Number.isFinite(b.temperatureC) && b.temperatureC >= -30 && b.temperatureC <= 120)
    && ["donor_packs", "partner_brings"].includes(b.containers) && !!b.pickup && [b.pickup.name, b.pickup.address, b.pickup.area, b.pickup.notes].every(x => typeof x === "string" && x.length <= 200) && !!b.pickup.address.trim()
    && validPoint({ ...b.pickup, at: now, accuracyM: 0, speedMps: null, heading: null }) && typeof b.contactName === "string" && !!b.contactName.trim() && b.contactName.length <= 120 && /^[6-9]\d{9}$/.test(b.contactPhone) && b.declarationAccepted === true;
}
function assessScenario(l: FoodListing, now: number) {
  const scn = scenarioFor(l.donorPhone)!;
  const servings = servingsOf(l);
  // The Food Agent's safe-until when it ran; otherwise the high-risk rule (Appendix B).
  const hours = { hot: 8, room: 4, fridge: 24 }[l.storage], safeUntil = l.assessment?.safeUntil ?? l.cookedAt + hours * 60 * 60_000;
  const remaining = safeUntil - now;
  // This fixture is deliberately restricted to the known rice meal and the adult veg NGO.
  if (!/^(vegetable|veg) biryani$/i.test(l.dish.trim()) || l.diet !== "veg" || servings > Number(scn.profiles.volunteer.fields.capacity) || l.readyFrom + 45 * 60_000 > safeUntil || remaining <= 0 || l.collectBy > safeUntil - 15 * 60_000) { l.state = "unplaced"; return; }
  l.assessment = { grade: l.assessment?.grade ?? (remaining >= 6 * 60 * 60_000 ? "A" : remaining >= 3 * 60 * 60_000 ? "B" : "C"), safeUntil, servings,
    unsure: l.assessment?.unsure ?? true, source: l.assessment?.source ?? "rules_only_demo" };
  l.state = "offered";
}
async function ensureScenarioOffer(l: FoodListing) {
  const scn = scenarioFor(l.donorPhone), a = l.assessment;
  if (!scn || !a) throw new TripError("The demo accounts are no longer available. Start a fresh walkthrough.");
  const f = scn.profiles.ngo.fields, now = Date.now();
  const input: TripInput = { listingId: l.id, shareId: `shr_${l.id.slice(4)}`, donorPhone: l.donorPhone, ngoPhone: scn.sessions.ngo.phone,
    partnerPhone: null, partnerName: "Finding a delivery partner", vehicle: "two_wheeler", pickup: l.pickup,
    drop: { name: f.org, address: f.address, area: f.area, notes: f.notes, lat: Number(f.lat), lng: Number(f.lng) },
    food: l.dish, servings: a.servings, grade: a.grade, unsure: a.unsure, safeUntil: a.safeUntil, collectBy: l.collectBy, maxTransitMin: 90,
    containers: l.containers === "donor_packs" ? `${a.servings} sealed meal boxes` : "2 × 5 L food boxes, 1 carry bag", partnerBringsContainers: l.containers === "partner_brings",
    requestDeadline: Math.min(now + 10 * 60_000, l.collectBy) };
  const t = createTrip(input, tripId(l.id), now, true, false);
  event(t, "listing.submitted", `${l.donorName} listed ${a.servings} servings of ${l.dish}.`, l.createdAt);
  if (l.approval) event(t, "listing.approved", `${l.approval.by} approved the first listing: ${l.approval.reason}`, now);
  event(t, "food.assessed", `Grade ${a.grade} · ${a.servings} servings${a.unsure ? " · pickup food check required" : ""}.`, now);
  const partnerPhones = scn.volunteers.map(v => v.session.phone);
  startNgoOffer(t, scn.ngos.slice(1).map(n => ({ phone: n.session.phone, partnerPhones, drop: { name: n.profile.fields.org, address: n.profile.fields.address, area: n.profile.fields.area, notes: n.profile.fields.notes, lat: Number(n.profile.fields.lat), lng: Number(n.profile.fields.lng) } })), l.readyFrom, now, partnerPhones);
  await trips.create(t);
}
