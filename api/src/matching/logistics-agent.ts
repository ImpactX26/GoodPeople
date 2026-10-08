/**
 * Logistics Agent. Runs each share from the NGO offer to the drop:
 *
 *   offering ──NGO accepts──▶ finding_partner ──partner accepts──▶ assigned
 *     │ decline / timeout /        │ nobody can collect:              │ pickup code
 *     │ no partner online          │ share goes to the next NGO       ▼
 *     ▼                                                           picked_up ──drop code──▶ delivered
 *   next NGO … none left ─▶ unplaced (Decision Agent re-plans)
 *
 * It talks to the people it negotiates with (NGOs being offered food, partners
 * being asked, the partner on a trip) and reports everything else to the
 * Decision Agent as events, which keeps the restaurant and NGO updated.
 */
import { config } from "./config.ts";
import { distanceKm, etaMs, mapsLink, round1 } from "./engine/geo.ts";
import { legFor, type Origin } from "./engine/match.ts";
import { itemName } from "./engine/reasons.ts";
import { effectiveGrade, isUnsure, safeUntil } from "./engine/safety.ts";
import { keepReady, shareContainers } from "./food-agent.ts";
import {
  code4,
  countdown,
  fail,
  foodOf,
  itemsOf,
  ok,
  owns,
  safeUntilOf,
  servingsOf,
  usable,
  worstGrade,
  type Actor,
  type Result,
  type Runtime,
} from "./runtime.ts";
import { areaById } from "./seed.ts";
import { fmtMinutes, fmtTime } from "./time.ts";
import { reliabilityLine } from "./reliability.ts";
import type { DecisionKind, LatLng, Listing, Partner, Recipient, Share } from "./types.ts";
import type { SharePlan } from "./ngo-agent.ts";
import * as msg from "./whatsapp/templates.ts";

export type LogisticsEvent =
  | { type: "ngo_accepted"; share: Share; ngo: Recipient }
  | { type: "partner_assigned"; share: Share; ngo: Recipient; partner: Partner; pickupAt: number; arriveBy: number }
  | { type: "picked_up"; share: Share; ngo: Recipient; partner: Partner }
  | { type: "delivered"; share: Share; ngo: Recipient; partner: Partner }
  /** Every candidate NGO passed: the Decision Agent should re-plan these servings. */
  | { type: "unplaced"; share: Share }
  /** Late, but the food is still safe when served. */
  | { type: "behind_schedule"; share: Share; ngo: Recipient; arrival: number }
  /** Progress the Decision Agent passes on to everyone involved (spec §14.3). */
  | { type: "offered"; share: Share; ngo: Recipient; minutes: number }
  | { type: "ngo_passed"; share: Share; ngo: Recipient; how: "declined" | "expired" }
  | { type: "partner_asked"; share: Share; ngo: Recipient; partner: Partner; own: boolean }
  | { type: "partner_waiting"; share: Share; ngo: Recipient }
  | { type: "partner_exhausted"; share: Share; ngo: Recipient }
  /** A live trip's latest estimate: the Decision Agent judges lateness against what was promised. */
  | { type: "eta"; share: Share; ngo: Recipient; partner: Partner; arrival: number; pickupAt: number | null }
  /** Late enough that the food would no longer be safe when served: redirect needed. */
  | { type: "unsafe_delay"; share: Share }
  | { type: "redirect_failed"; share: Share }
  | { type: "redirected"; share: Share; from: Recipient; to: Recipient; partner: Partner; arriveBy: number; dropKm: number }
  /** Needs a person (e.g. codes wrong 3 times). */
  | { type: "stuck"; share: Share; reason: string };

export interface LogisticsDeps {
  emit(e: LogisticsEvent, now: number): Promise<void>;
}

const GONE = "This has already gone to someone else — thanks!";

/** Each food in a share with its own grade and safe-until: foods in one listing are checked one by one. */
const foodsOf = (l: Listing, lines: Share["lines"]) =>
  itemsOf(l, lines).map((i) => ({ name: itemName(i), servings: i.servings, grade: effectiveGrade(i), safeUntil: safeUntil(i, l.createdAt) }));

export function createLogisticsAgent(rt: Runtime, deps: LogisticsDeps) {
  const { store } = rt;
  const decide = (now: number, kind: DecisionKind, subject: string, reason: string, listingId?: string, data?: unknown) =>
    rt.decide("logistics", now, kind, subject, reason, listingId, data);
  const toNgo = (now: number, r: Recipient, m: msg.Message) => rt.send(now, r.phone, `recipient:${r.id}`, m);
  const toPartner = (now: number, p: Partner, m: msg.Message) => rt.send(now, p.phone, `partner:${p.id}`, m);
  const simulatedPartner = (p: Partner) => !p.phone && !p.manual;

  /* ---------- starting a share ---------- */

  async function startShare(l: Listing, plan: SharePlan, now: number) {
    const share: Share = {
      id: rt.id("s"),
      listingId: l.id,
      lines: plan.lines,
      status: "offering",
      candidates: plan.candidates,
      triedNgoIds: [],
      triedPartnerIds: [],
      pickupBy: 0,
      deliverBy: 0,
      pickupCode: l.pickupCode ?? code4(),   // the session's one code
      dropCode: code4(),
      pickupTriesLeft: config.codeTries,
      dropTriesLeft: config.codeTries,
      needsPickupCheck: itemsOf(l, plan.lines).some(isUnsure),
      redirectTried: [],
      createdAt: now,
    };
    await store.insert("share", share);
    await offerNext(share, now);
    return share;
  }

  /* ---------- partners ---------- */

  /**
   * Partners who could collect this share for this NGO and get it there while
   * it's safe: the NGO's own riders first, then independents, nearest first.
   */
  async function partnersFor(share: Share, l: Listing, ngo: Recipient, now: number) {
    const until = safeUntilOf(l, share.lines);
    return usable(await store.list("partner"))
      .filter((p) => p.online && !p.manual && (!p.activeShareId || p.activeShareId === share.id))
      // its own riders, independents, and other NGOs' riders who said they'll help others too
      .filter((p) => !share.triedPartnerIds.includes(p.id) && (!p.ngoId || p.ngoId === ngo.id || p.helpsOthers))
      .map((p) => {
        const toPickup = etaMs(distanceKm(p, l), p.travel);
        const leg = legFor(ngo, l, { pos: p, startAt: now, travel: p.travel, pickedUp: false });
        return { p, own: p.ngoId === ngo.id, toPickup, pickupAt: Math.max(now + toPickup, l.readyFrom), leg };
      })
      .filter((c) => c.pickupAt <= l.collectBy && c.leg.serveTime <= until)
      // own riders first; within a tier, partners rated below the low mark are asked after the rest
      .sort((a, b) => Number(b.own) - Number(a.own) || Number(lowRated(a.p)) - Number(lowRated(b.p)) || a.toPickup - b.toPickup);
  }

  /**
   * How this partner would do on this share: whether they may take it at all (ride for its NGO, independent,
   * or help others; not busy elsewhere), when they'd reach the restaurant, whether that's after its collect-by
   * time (allowed, with a warning: they should call first), and whether the food would stop being safe before
   * it reaches the NGO (never allowed). The NGO has already said yes, so the drop isn't held for its hours.
   */
  function reachOf(share: Share, l: Listing, ngo: Recipient, p: Partner, now: number) {
    if (p.manual || (p.activeShareId && p.activeShareId !== share.id)) return null;
    if (p.ngoId && p.ngoId !== ngo.id && !p.helpsOthers) return null;
    const pickupAt = Math.max(now + etaMs(distanceKm(p, l), p.travel), l.readyFrom);
    const leg = legFor(ngo, l, { pos: p, startAt: now, travel: p.travel, pickedUp: false }, false);
    return { pickupAt, late: pickupAt > l.collectBy, unsafe: leg.serveTime > safeUntilOf(l, share.lines) };
  }

  /** Whether this partner can take this share (late for collect-by is fine; unsafe is not). Missed asks count too. */
  function canTake(share: Share, l: Listing, ngo: Recipient, p: Partner, now: number) {
    const r = reachOf(share, l, ngo, p, now);
    return !!r && !r.unsafe;
  }

  /**
   * Pickups an NGO accepted that no partner has taken, for this partner: everything they may take, including ones
   * they missed, each with how they'd do on it, so nothing they missed just disappears.
   */
  async function openFor(phone: string, now: number) {
    const [p] = await store.list("partner", { phone });
    if (!p) return [];
    const out: { share: Share; missed: boolean; reach: { pickupAt: number; collectBy: number; late: boolean; unsafe: boolean } }[] = [];
    for (const share of await store.list("share", { status: "finding_partner" })) {
      if (!share.ngoId || share.askedPartnerId === p.id || share.held) continue;
      const l = await store.get("listing", share.listingId);
      const ngo = await store.get("recipient", share.ngoId);
      const r = l && ngo ? reachOf(share, l, ngo, p, now) : null;
      if (l && r) out.push({ share, missed: share.triedPartnerIds.includes(p.id), reach: { ...r, collectBy: l.collectBy } });
    }
    return out;
  }

  /**
   * A partner takes an open pickup from the board, including one they missed. First come: if someone else is
   * being asked right now, they're told it's covered.
   */
  async function claim(shareId: string, by: Actor, now: number): Promise<Result> {
    if (!("phone" in by)) return fail("Only a delivery partner can take a pickup.", 403);
    const share = await store.get("share", shareId);
    if (!share || !share.ngoId) return fail("Unknown pickup.", 404);
    if (share.status !== "finding_partner") return fail("Someone has already taken this pickup.");
    const [p] = await store.list("partner", { phone: by.phone });
    if (!p) return fail("Your partner account isn't set up yet.", 403);
    const l = await rt.mustGet("listing", share.listingId);
    const ngo = await rt.mustGet("recipient", share.ngoId);
    if (p.activeShareId && p.activeShareId !== share.id) return fail("Finish your current pickup first.");
    if (!canTake(share, l, ngo, p, now)) return fail("From where you are, the food would stop being safe before it reaches the NGO.");
    const asked = share.askedPartnerId && share.askedPartnerId !== p.id ? await store.get("partner", share.askedPartnerId) : null;
    if (asked) {
      await store.put("partner", { ...asked, activeShareId: undefined });
      await toPartner(now, asked, msg.text("Thanks! Another partner has taken that pickup, so you're no longer needed for it."));
    }
    const missed = share.triedPartnerIds.includes(p.id);
    await decide(now, "assigned", p.id, `${p.name} took the open pickup for ${ngo.name}${missed ? " after missing the first ask" : ""}.`, l.id, { shareId, claimed: true });
    await assign({ ...share, askedPartnerId: undefined, askDeadlineAt: undefined }, p, now);
    return ok("It's yours. Head to the restaurant.");
  }

  /** What a partner carries for this share: the donor's own list if given, else worked out from the share's food (§9.5). */
  const containersOf = (l: Listing, lines: Share["lines"]) => (l.containers.length ? l.containers : shareContainers(l, lines));

  const lowRated = (p: Partner) => (p.reliability?.trips ?? 0) >= config.reliability.newUntilTrips && (p.reliability?.score ?? 5) < config.reliability.lowScore;

  async function partnerOf(share: Share): Promise<Partner | null> {
    const pid = share.partnerId ?? share.askedPartnerId;
    return pid ? store.get("partner", pid) : null;
  }

  /* ---------- NGO offers ---------- */

  /** Offer the share to the next NGO on its list that has a partner online to collect it. */
  async function offerNext(share: Share, now: number) {
    const l = await rt.mustGet("listing", share.listingId);
    for (const c of share.candidates) {
      if (share.triedNgoIds.includes(c.ngoId)) continue;
      const ngo = await store.get("recipient", c.ngoId);
      if (!ngo || !ngo.active || (!config.simulateUnclaimed && !ngo.phone)) {
        share.triedNgoIds.push(c.ngoId);
        continue;
      }
      // NGOs hear about food first; partners are asked once one accepts (its own riders, then anyone nearby).
      const supply = (await partnersFor(share, l, ngo, now)).length;
      const ms = countdown(l, share.lines, now);
      const next: Share = { ...share, status: "offering", ngoId: ngo.id, offerSentAt: now, offerDeadlineAt: now + ms, arriveBy: c.arriveBy };
      await store.put("share", next);
      const minutes = Math.round(ms / 60_000);
      await decide(now, "offered", ngo.id, `Offered ${servingsOf(share.lines)} servings of ${foodOf(l, share.lines)} to ${ngo.name}${ngo.phone ? "" : " (sample NGO, answers automatically)"}, ${minutes} min to reply.${supply ? "" : " No delivery partner is online near it yet; if it accepts, its own volunteers are asked first as soon as one is."}`, l.id, { shareId: share.id });
      await toNgo(now, ngo, msg.foodOffer({ shareId: share.id, servings: servingsOf(share.lines), food: foodOf(l, share.lines), grade: worstGrade(l, share.lines), safeUntil: safeUntilOf(l, share.lines), arriveBy: c.arriveBy, minutes, foods: foodsOf(l, share.lines) }));
      await deps.emit({ type: "offered", share: next, ngo, minutes }, now);
      return;
    }
    const done: Share = { ...share, status: "unplaced", ngoId: undefined };
    await store.put("share", done);
    await decide(now, "escalated", share.id, `Every NGO lined up for ${servingsOf(share.lines)} servings of ${foodOf(l, share.lines)} passed or had no partner to collect it; handing it back to the Decision Agent.`, l.id, { shareId: share.id, tried: share.triedNgoIds });
    await deps.emit({ type: "unplaced", share: done }, now);
  }

  async function ngoReply(shareId: string, accept: boolean, by: Actor, now: number): Promise<Result> {
    const share = await store.get("share", shareId);
    if (!share) return fail("Unknown offer.", 404);
    if (share.status !== "offering" || !share.ngoId) return fail(GONE);
    const ngo = await rt.mustGet("recipient", share.ngoId);
    if (!owns(by, ngo.phone)) return fail("This offer isn't yours.", 403);
    if (now > (share.offerDeadlineAt ?? 0)) {
      await expireOffer(share, now);
      return fail(GONE);
    }
    const l = await rt.mustGet("listing", share.listingId);
    if (!accept) {
      const next: Share = { ...share, triedNgoIds: [...share.triedNgoIds, ngo.id], ngoId: undefined };
      if (!(await store.cas("share", next, "offering"))) return fail(GONE);
      await decide(now, "declined", ngo.id, `${ngo.name} declined ${servingsOf(share.lines)} servings of ${foodOf(l, share.lines)}.`, l.id, { shareId });
      await deps.emit({ type: "ngo_passed", share: next, ngo, how: "declined" }, now);
      await offerNext(next, now);
      return ok("Thanks for letting us know.");
    }
    const next: Share = { ...share, status: "finding_partner", acceptedAt: now };
    if (!(await store.cas("share", next, "offering"))) return fail(GONE);
    await decide(now, "accepted", ngo.id, `${ngo.name} accepted ${servingsOf(share.lines)} servings of ${foodOf(l, share.lines)}.`, l.id, { shareId });
    await deps.emit({ type: "ngo_accepted", share: next, ngo }, now);
    await askNextPartner(next, now);
    return ok("Thank you! We're finding a delivery partner and will send their details.");
  }

  async function expireOffer(share: Share, now: number) {
    const ngo = await rt.mustGet("recipient", share.ngoId!);
    const next: Share = { ...share, triedNgoIds: [...share.triedNgoIds, ngo.id], ngoId: undefined };
    if (!(await store.cas("share", next, "offering"))) return;
    await decide(now, "expired", ngo.id, `${ngo.name} didn't reply in time; moving on.`, share.listingId, { shareId: share.id });
    await toNgo(now, ngo, msg.text("That food offer has closed because the time ran out. We'll send the next one your way."));
    await deps.emit({ type: "ngo_passed", share: next, ngo, how: "expired" }, now);
    await offerNext(next, now);
  }

  /* ---------- finding a partner ---------- */

  async function askNextPartner(share: Share, now: number) {
    const l = await rt.mustGet("listing", share.listingId);
    const ngo = await rt.mustGet("recipient", share.ngoId!);
    const best = (await partnersFor(share, l, ngo, now))[0];
    if (!best && now < l.collectBy && safeUntilOf(l, share.lines) > now) {
      // Nobody free yet: keep the NGO's acceptance and keep looking (its own riders first) until the pickup window
      // closes. Meanwhile the pickup sits on the open pickups board, where anyone who can reach it (including
      // partners who missed the ask) can take it.
      const since = share.waitingForPartnerSince ?? now;
      if (share.waitingForPartnerSince && (await handOnToNextNgo(share, l, ngo, since, now))) return;
      // The board notice goes out once per share, including shares that were already waiting before it existed.
      const notice = !share.openNoticeAt;
      await store.put("share", { ...share, askedPartnerId: undefined, askDeadlineAt: undefined, waitingForPartnerSince: since, lastPartnerTryAt: now, openNoticeAt: share.openNoticeAt ?? now });
      if (notice) {
        const wait = waitLimit(l, share);
        await decide(now, "delayed", ngo.id, `No delivery partner has taken the pickup near ${l.donorName}. It's on the open pickups board for every partner who can reach it; if nobody takes it in ${fmtMinutes(wait)}, it moves to the next NGO with a partner free.`, l.id, { shareId: share.id });
        await toNgo(now, ngo, msg.text(`Accepted. No delivery partner has taken the pickup yet, so it's open to every partner nearby. If nobody takes it in ${fmtMinutes(wait)}, Luna passes it to another NGO so it isn't wasted. If your staff can collect, tap "Our own staff will collect".`));
        await deps.emit({ type: "partner_waiting", share, ngo }, now);
        // One heads-up to everyone who could still take it, including those who missed the ask.
        for (const p of usable(await store.list("partner")))
          if (p.online && canTake(share, l, ngo, p, now))
            await toPartner(now, p, msg.text(`Pickup still open: ${keepReady(l, share.lines)} from ${l.donorName} to ${ngo.name}, safe until ${fmtTime(safeUntilOf(l, share.lines))}. Nobody has taken it yet. Open Luna to take it.`));
      }
      return;
    }
    if (!best) {
      // The pickup window closed with nobody to collect it for this NGO: the share goes to the next NGO.
      const next: Share = { ...share, status: "offering", ngoId: undefined, askedPartnerId: undefined, askDeadlineAt: undefined, triedPartnerIds: [], triedNgoIds: [...share.triedNgoIds, ngo.id] };
      await store.put("share", next);
      await decide(now, "escalated", ngo.id, `No delivery partner could collect for ${ngo.name}, so the food is offered to the next NGO.`, l.id, { shareId: share.id });
      await toNgo(now, ngo, msg.text(`Sorry, no delivery partner could collect the food from ${l.donorName} for you in time, so we've offered it to another NGO.`));
      await deps.emit({ type: "partner_exhausted", share: next, ngo }, now);
      await offerNext(next, now);
      return;
    }
    const serveNow = itemsOf(l, share.lines).some((i) => effectiveGrade(i) === "C");
    const ms = serveNow ? config.partnerAcceptServeNowMs : config.partnerAcceptMs;
    await store.put("partner", { ...best.p, activeShareId: share.id });
    await store.put("share", { ...share, askedPartnerId: best.p.id, askedAt: now, askDeadlineAt: now + ms, lastPartnerTryAt: now });
    await deps.emit({ type: "partner_asked", share, ngo, partner: best.p, own: best.own }, now);
    const who = best.own ? `${ngo.name}'s own partner` : "an independent partner";
    await decide(now, "offered", best.p.id, `Asked ${best.p.name}, ${who} (${fmtMinutes(best.toPickup)} from the pickup), ${fmtMinutes(ms)} to accept${serveNow ? " because it's serve-now food" : ""}.`, l.id, { shareId: share.id });
    await toPartner(
      now,
      best.p,
      msg.partnerAsk({
        shareId: share.id,
        pickupKm: distanceKm(best.p, l),
        pickupPlace: `${l.donorName}, ${areaById(l.areaId)?.name ?? l.areaId}`,
        dropName: ngo.name,
        dropKm: best.leg.dropKm,
        minutes: Math.round((best.leg.arrival - now) / 60_000),
        safeUntil: safeUntilOf(l, share.lines),
        replyMinutes: ms / 60_000,
        containers: containersOf(l, share.lines),
      }),
    );
  }

  /** When this NGO accepted; older shares from before acceptedAt was kept use their first partner ask. */
  const acceptedAtOf = (share: Share) => share.acceptedAt ?? share.askedAt ?? share.waitingForPartnerSince ?? share.createdAt;

  const waitLimit = (l: Listing, share: Share) =>
    itemsOf(l, share.lines).some((i) => effectiveGrade(i) === "C") ? config.partnerWaitBeforeNextNgoServeNowMs : config.partnerWaitBeforeNextNgoMs;

  /**
   * The pickup has waited too long with no partner: if another NGO on the share's list has a partner free who
   * can get the food there safely, the share moves to it (no need to ask the first NGO), and the first NGO is
   * told why. Otherwise it stays with the first NGO, on the open board. True when it moved.
   */
  async function handOnToNextNgo(share: Share, l: Listing, ngo: Recipient, since: number | undefined, now: number) {
    // Either nobody has taken it for the wait limit since asking ran out, or the NGO has held it 30 minutes since
    // accepting, however the asking is going (partners being asked one by one can't stretch it past that).
    const accepted = acceptedAtOf(share);
    const waited = since !== undefined && now - since >= waitLimit(l, share);
    const held = now - accepted >= config.ngoHoldAfterAcceptMaxMs;
    if (!waited && !held) return false;
    const tried = new Set([...share.triedNgoIds, ngo.id]);
    let target: Recipient | null = null;
    for (const c of share.candidates) {
      if (tried.has(c.ngoId)) continue;
      const r = await store.get("recipient", c.ngoId);
      if (!r?.active || (!config.simulateUnclaimed && !r.phone)) continue;
      if ((await partnersFor({ ...share, triedPartnerIds: [] }, l, r, now)).length) { target = r; break; }
    }
    if (!target) return false;
    // A partner being asked right now is told it's covered elsewhere.
    const asked = share.askedPartnerId ? await store.get("partner", share.askedPartnerId) : null;
    if (asked) {
      await store.put("partner", { ...asked, activeShareId: undefined });
      await toPartner(now, asked, msg.text("Thanks! That pickup has moved to another NGO, so you're no longer needed for it."));
    }
    const took = now - (held ? accepted : since!);
    const candidates = [...share.candidates.filter((c) => c.ngoId === target!.id), ...share.candidates.filter((c) => c.ngoId !== target!.id)];
    const next: Share = { ...share, status: "offering", candidates, ngoId: undefined, askedPartnerId: undefined, askDeadlineAt: undefined, triedPartnerIds: [], triedNgoIds: [...share.triedNgoIds, ngo.id], waitingForPartnerSince: undefined, lastPartnerTryAt: undefined, acceptedAt: undefined, openNoticeAt: undefined };
    await store.put("share", next);
    const food = foodOf(l, share.lines);
    await decide(now, "replanned", ngo.id, `No delivery partner took the pickup for ${ngo.name} ${held ? `in the ${fmtMinutes(config.ngoHoldAfterAcceptMaxMs)} an NGO can hold accepted food` : `in ${fmtMinutes(took)}`}, so the ${food} moves to ${target.name}, which has a partner free. ${ngo.name} was told why.`, l.id, { shareId: share.id, from: ngo.id, to: target.id });
    await toNgo(now, ngo, msg.text(`No delivery partner took the ${food} pickup from ${l.donorName} within ${fmtMinutes(took)} of you accepting it, so Luna has passed it to another NGO that has a partner free, before it stops being safe. Nothing for you to do. Thank you for saying yes.`));
    await deps.emit({ type: "partner_exhausted", share: next, ngo }, now);
    await offerNext(next, now);
    return true;
  }

  async function releaseAsk(share: Share, p: Partner, now: number, how: "declined" | "expired") {
    await store.put("partner", { ...p, activeShareId: undefined });
    const next: Share = { ...share, askedPartnerId: undefined, askDeadlineAt: undefined, triedPartnerIds: [...share.triedPartnerIds, p.id] };
    await store.put("share", next);
    await decide(now, how, p.id, how === "declined" ? `${p.name} can't take this pickup.` : `${p.name} didn't reply in time.`, share.listingId, { shareId: share.id });
    await askNextPartner(next, now);
  }

  async function partnerReply(shareId: string, accept: boolean, by: Actor, now: number): Promise<Result> {
    const share = await store.get("share", shareId);
    if (!share) return fail("Unknown pickup.", 404);
    const p = share.askedPartnerId ? await store.get("partner", share.askedPartnerId) : null;
    if (share.status !== "finding_partner" || !p) return fail(GONE);
    if (!owns(by, p.phone)) return fail(GONE, 403);
    if (!accept || now > (share.askDeadlineAt ?? 0)) {
      await releaseAsk(share, p, now, accept ? "expired" : "declined");
      return accept ? fail(GONE) : ok("No problem, thanks!");
    }
    await assign(share, p, now);
    return ok();
  }

  /** An NGO coordinator assigns someone by hand, e.g. a staff member who isn't on the app. */
  async function assignManual(shareId: string, person: { name: string; phone?: string }, by: Actor, now: number): Promise<Result> {
    const share = await store.get("share", shareId);
    if (!share || !share.ngoId) return fail("Unknown pickup.", 404);
    const ngo = await rt.mustGet("recipient", share.ngoId);
    if (!owns(by, ngo.phone)) return fail("Only this NGO's coordinator can assign someone.", 403);
    if (share.status !== "finding_partner") return fail("A partner is already assigned, or the food isn't yours yet.");
    const asked = share.askedPartnerId ? await store.get("partner", share.askedPartnerId) : null;
    if (asked) {
      await store.put("partner", { ...asked, activeShareId: undefined });
      await toPartner(now, asked, msg.text("Thanks! That pickup has been covered by the NGO's own staff, so you're no longer needed for it."));
    }
    const p: Partner = { id: rt.id("p-manual"), name: person.name, phone: person.phone, areaId: ngo.areaId, lat: ngo.lat, lng: ngo.lng, travel: "two_wheeler", online: false, ngoId: ngo.id, manual: true };
    await store.insert("partner", p);
    await decide(now, "assigned", p.id, `${ngo.name}'s coordinator assigned ${p.name} by hand; the coordinator enters the pickup and drop codes for them.`, share.listingId, { shareId });
    await assign({ ...share, askedPartnerId: undefined, askDeadlineAt: undefined }, p, now);
    return ok(`${p.name} is assigned. Enter the pickup code they get from the restaurant, and the drop code at your end.`);
  }

  async function assign(share: Share, p: Partner, now: number) {
    const l = await rt.mustGet("listing", share.listingId);
    const ngo = await rt.mustGet("recipient", share.ngoId!);
    const toPickup = etaMs(distanceKm(p, l), p.travel);
    const toDrop = etaMs(distanceKm(l, ngo), p.travel);
    const pickupAt = Math.max(now + toPickup, l.readyFrom);
    const pickupBy = Math.max(now + toPickup * config.checkpointSlack, l.readyFrom);
    const promised = legFor(ngo, l, { pos: p, startAt: now, travel: p.travel, pickedUp: false });
    const next: Share = {
      ...share,
      promisedPickupAt: pickupAt,
      promisedArrival: promised.arrival,
      lateNoticeMin: 0,
      lateReported: false,
      lastEtaCheckAt: now,
      status: "assigned",
      partnerId: p.id,
      askedPartnerId: undefined,
      askDeadlineAt: undefined,
      assignedAt: now,
      pickupBy,
      deliverBy: pickupBy + toDrop * config.checkpointSlack,
      lastPos: { lat: p.lat, lng: p.lng },
    };
    if (!(await store.cas("share", next, "finding_partner"))) return;
    await store.put("partner", { ...p, activeShareId: share.id });
    const arriveBy = pickupAt + toDrop;
    if (!p.manual) await decide(now, "assigned", p.id, `${p.name} will pick up around ${fmtTime(pickupAt)} and reach ${ngo.name} around ${fmtTime(arriveBy)}.`, l.id, { shareId: share.id });

    const contact = l.pickupContactPhone ?? l.donorPhone;
    const place = l.pickupAddress.startsWith(l.donorName) ? l.pickupAddress : `${l.donorName}, ${l.pickupAddress}`;
    const lines = [
      `You're on! Collect ${keepReady(l, share.lines)} from ${place}.`,
      `Bring: ${containersOf(l, share.lines).join(", ")}.`,
      l.pickupNotes ? `Note: ${l.pickupNotes}` : "",
      `Pickup contact: ${contact}`,
      `Directions: ${mapsLink(p, l, p.travel)}`,
      `At the restaurant, ask for the 4-digit pickup code and send it here. Then drop at ${ngo.name}. Food is safe until ${fmtTime(safeUntilOf(l, share.lines))}.`,
      share.needsPickupCheck ? msg.PICKUP_CHECKLIST : "",
    ].filter(Boolean);
    await toPartner(now, p, msg.text(lines.join("\n"), msg.lateButton(share.id)));
    await deps.emit({ type: "partner_assigned", share: next, ngo, partner: p, pickupAt, arriveBy }, now);
  }

  /* ---------- pickup and drop codes ---------- */

  /** The partner enters a code; for a hand-assigned partner, the NGO coordinator does. */
  async function enterCode(shareId: string, which: "pickup" | "drop", code: string, by: Actor, now: number): Promise<Result> {
    const share = await store.get("share", shareId);
    if (!share) return fail("Unknown trip.", 404);
    const p = await partnerOf(share);
    const ngo = share.ngoId ? await store.get("recipient", share.ngoId) : null;
    if (!p || !ngo || !(owns(by, p.phone) || (p.manual && owns(by, ngo.phone)))) return fail("This trip isn't yours.", 403);
    const expected = which === "pickup" ? "assigned" : "picked_up";
    if (share.status !== expected) return fail(which === "pickup" ? "This trip isn't waiting for pickup." : "This trip isn't on its way to the NGO.");
    if (share.held) return fail("The Luna team has been alerted about this trip and will call you.", 400);
    const l = await rt.mustGet("listing", share.listingId);

    const right = which === "pickup" ? share.pickupCode : share.dropCode;
    const triesKey = which === "pickup" ? "pickupTriesLeft" : "dropTriesLeft";
    if (code.trim() !== right) {
      const left = share[triesKey] - 1;
      await store.put("share", { ...share, [triesKey]: left, held: left <= 0 || undefined });
      if (left > 0) return fail(`That ${which} code doesn't match. ${left} ${left === 1 ? "try" : "tries"} left.`, 400);
      // Held at the restaurant: the partner never got the food, so they're free for other pickups. Held at the
      // NGO, they still carry it and stay on this trip until the Luna team sorts it out.
      if (which === "pickup") await store.put("partner", { ...p, activeShareId: undefined });
      await deps.emit({ type: "stuck", share, reason: `${p.name} entered the wrong ${which} code ${config.codeTries} times at ${which === "pickup" ? l.donorName : ngo.name}.` }, now);
      return fail(`That ${which} code still doesn't match. The Luna team has been alerted and will call you.`, 400);
    }

    if (which === "pickup") {
      const next: Share = { ...share, status: "picked_up", pickedUpAt: now, lastPos: { lat: l.lat, lng: l.lng } };
      if (!(await store.cas("share", next, "assigned"))) return fail("This trip isn't waiting for pickup.");
      await decide(now, "picked_up", p.id, `${p.name} collected the food from ${l.donorName} (pickup code matched).`, l.id, { shareId });
      if (!p.manual) await toPartner(now, p, msg.text(`Picked up. Now drop at ${ngo.name}: ${mapsLink(l, ngo, p.travel)}\nAt the NGO, ask for their 4-digit drop code and send it here.`, msg.lateButton(shareId)));
      await deps.emit({ type: "picked_up", share: next, ngo, partner: p }, now);
      return ok();
    }
    const next: Share = { ...share, status: "delivered" };
    if (!(await store.cas("share", next, "picked_up"))) return fail("This trip isn't on its way to the NGO.");
    await store.put("partner", { ...p, activeShareId: undefined, lat: ngo.lat, lng: ngo.lng });
    await decide(now, "delivered", ngo.id, `${p.name} delivered ${servingsOf(share.lines)} servings of ${foodOf(l, share.lines)} to ${ngo.name} at ${fmtTime(now)} (drop code matched).`, l.id, { shareId });
    await deps.emit({ type: "delivered", share: next, ngo, partner: p }, now);
    return ok();
  }

  /* ---------- the trip: location, delays, redirects ---------- */

  function originOf(share: Share, p: Partner, l: Listing, now: number): Origin {
    return {
      pos: share.lastPos ?? (share.status === "picked_up" ? l : p),
      startAt: Math.max(now, share.delayUntil ?? now),
      travel: p.travel,
      pickedUp: share.status === "picked_up",
    };
  }

  async function originFor(share: Share, now: number) {
    const p = (await partnerOf(share))!;
    return originOf(share, p, await rt.mustGet("listing", share.listingId), now);
  }

  async function guardTrip(shareId: string, by: Actor) {
    const share = await store.get("share", shareId);
    if (!share) return { error: fail("Unknown trip.", 404) };
    const p = await partnerOf(share);
    if (!p || !owns(by, p.phone)) return { error: fail("This trip isn't yours.", 403) };
    if (share.status !== "assigned" && share.status !== "picked_up") return { error: fail("This trip isn't in progress.") };
    return { share, p };
  }

  async function late(shareId: string, by: Actor, now: number): Promise<Result> {
    const g = await guardTrip(shareId, by);
    if (g.error) return g.error;
    const delayUntil = Math.max(now, g.share.delayUntil ?? now) + config.lateStepMs;
    const next = { ...g.share, delayUntil, lateReported: true };
    await store.put("share", next);
    await decide(now, "delayed", g.p.id, `${g.p.name} says they're running late (about ${fmtMinutes(delayUntil - now)} more).`, next.listingId, { shareId });
    await watch(next, now, true);
    return ok("Thanks for telling us. We'll let the NGO know or find a closer drop.");
  }

  async function location(shareId: string, pos: LatLng, by: Actor, now: number, fix: { accuracyM?: number; speedMps?: number | null; heading?: number | null } = {}): Promise<Result> {
    const g = await guardTrip(shareId, by);
    if (g.error) return g.error;
    // Phones often report no speed: work it out from the last fix, so the live map can glide between fixes.
    const prev = g.share.lastFix;
    const gapS = prev ? (now - prev.at) / 1000 : 0;
    const derived = prev && gapS >= 1 && gapS <= 30 ? (distanceKm(prev, pos) * 1000) / config.roadFactor / gapS : null;
    const speedMps = fix.speedMps ?? (derived !== null && derived < 40 ? derived : null);
    const lastFix = { lat: pos.lat, lng: pos.lng, at: now, accuracyM: fix.accuracyM ?? 20, speedMps, heading: fix.heading ?? null };
    const next = { ...g.share, lastPos: pos, lastFix };
    await store.put("share", next);
    await store.put("partner", { ...g.p, ...pos });
    await watch(next, now, false);
    return ok();
  }

  /**
   * Re-check a trip. Still safe when served: move the checkpoint (and tell the
   * Decision Agent if it's behind). Not safe: ask the Decision Agent to redirect.
   */
  async function watch(share: Share, now: number, reportLate: boolean) {
    if (share.held || share.redirect || !share.partnerId || !share.ngoId) return;
    const l = await rt.mustGet("listing", share.listingId);
    const ngo = await rt.mustGet("recipient", share.ngoId);
    const p = await rt.mustGet("partner", share.partnerId);
    const origin = originOf(share, p, l, now);
    const leg = legFor(ngo, l, origin);
    const until = safeUntilOf(l, share.lines);
    if (leg.serveTime <= until) {
      const behind = reportLate || now > share.deliverBy || (share.status === "assigned" && now > share.pickupBy);
      const pickupBy = share.status === "assigned" ? origin.startAt + etaMs(distanceKm(origin.pos, l), p.travel) * config.checkpointSlack : share.pickupBy;
      const next: Share = { ...share, pickupBy, deliverBy: now + (leg.arrival - now) * config.checkpointSlack, lastEtaCheckAt: now };
      await store.put("share", next);
      const pickupAt = share.status === "assigned" ? Math.max(origin.startAt + etaMs(distanceKm(origin.pos, l), p.travel), l.readyFrom) : null;
      await deps.emit({ type: "eta", share: next, ngo, partner: p, arrival: leg.arrival, pickupAt }, now);
      if (behind && !share.promisedArrival) await deps.emit({ type: "behind_schedule", share: next, ngo, arrival: leg.arrival }, now);
      return;
    }
    await decide(now, "delayed", share.id, `${p.name} is delayed: the food would reach ${ngo.name} around ${fmtTime(leg.arrival)} and be served at ${fmtTime(leg.serveTime)}, but it's only safe until ${fmtTime(until)}.`, l.id, { shareId: share.id });
    await deps.emit({ type: "unsafe_delay", share }, now);
  }

  /** For the Decision Agent: a free partner (not the current one) who'd reach the pickup sooner, if any. */
  async function fasterPartner(share: Share, now: number): Promise<{ partner: Partner; pickupAt: number } | null> {
    if (share.status !== "assigned" || !share.ngoId || !share.partnerId) return null;
    const l = await rt.mustGet("listing", share.listingId);
    const ngo = await rt.mustGet("recipient", share.ngoId);
    const best = (await partnersFor({ ...share, triedPartnerIds: [...share.triedPartnerIds, share.partnerId] }, l, ngo, now))[0];
    return best ? { partner: best.p, pickupAt: best.pickupAt } : null;
  }

  /** On the Decision Agent's behalf: take the pickup off a late partner and ask the next one (own riders first). */
  async function replacePartner(share: Share, now: number, why: string): Promise<boolean> {
    const p = share.partnerId ? await store.get("partner", share.partnerId) : null;
    if (!p) return false;
    const next: Share = { ...share, status: "finding_partner", partnerId: undefined, assignedAt: undefined, triedPartnerIds: [...share.triedPartnerIds, p.id],
      promisedPickupAt: undefined, promisedArrival: undefined, lateNoticeMin: 0, lateReported: false, lastPartnerTryAt: now };
    if (!(await store.cas("share", next, "assigned"))) return false;
    await store.put("partner", { ...p, activeShareId: undefined });
    if (!p.manual) await toPartner(now, p, msg.text(`${why} We've passed this pickup to another partner so the food stays safe. No need to go to the restaurant now.`));
    await askNextPartner(next, now);
    return true;
  }

  /** On the Decision Agent's behalf: offer the in-flight food to a closer NGO. */
  async function offerRedirect(share: Share, ngoId: string, arriveBy: number, now: number) {
    const l = await rt.mustGet("listing", share.listingId);
    const ngo = await rt.mustGet("recipient", ngoId);
    const next: Share = { ...share, redirect: { ngoId, sentAt: now, deadlineAt: now + config.redirectCountdownMs, arriveBy }, redirectTried: [...share.redirectTried, ngoId] };
    await store.put("share", next);
    const minutes = Math.round(config.redirectCountdownMs / 60_000);
    await decide(now, "offered", ngo.id, `Offered the delayed ${foodOf(l, share.lines)} to ${ngo.name}, ${minutes} min to reply.`, l.id, { shareId: share.id, redirect: true });
    await toNgo(now, ngo, msg.foodOffer({ shareId: share.id, servings: servingsOf(share.lines), food: foodOf(l, share.lines), grade: worstGrade(l, share.lines), safeUntil: safeUntilOf(l, share.lines), arriveBy, minutes, redirect: true, foods: foodsOf(l, share.lines) }));
  }

  async function redirectReply(shareId: string, accept: boolean, by: Actor, now: number): Promise<Result> {
    const share = await store.get("share", shareId);
    if (!share?.redirect) return fail(GONE);
    const to = await rt.mustGet("recipient", share.redirect.ngoId);
    if (!owns(by, to.phone)) return fail("This offer isn't yours.", 403);
    const late = now > share.redirect.deadlineAt;
    if (!accept || late) {
      await store.put("share", { ...share, redirect: undefined });
      await decide(now, late ? "expired" : "declined", to.id, `${to.name} ${late ? "didn't reply in time to" : "declined"} the redirected food.`, share.listingId, { shareId });
      await deps.emit({ type: "redirect_failed", share: { ...share, redirect: undefined } }, now);
      return late ? fail(GONE) : ok("Thanks for letting us know.");
    }
    const l = await rt.mustGet("listing", share.listingId);
    const from = await rt.mustGet("recipient", share.ngoId!);
    const p = await rt.mustGet("partner", share.partnerId!);
    const origin = originOf(share, p, l, now);
    const leg = legFor(to, l, origin);
    const next: Share = {
      ...share,
      ngoId: to.id,
      redirect: undefined,
      redirectTried: [],
      dropCode: code4(),
      dropTriesLeft: config.codeTries,
      deliverBy: now + (leg.arrival - now) * config.checkpointSlack,
    };
    await store.put("share", next);
    await decide(now, "accepted", to.id, `${to.name} accepted the redirected food.`, l.id, { shareId });
    const fromPos = share.status === "picked_up" ? origin.pos : l;
    if (!p.manual)
      await toPartner(now, p, msg.text(`Change of plan: take the food to ${to.name} instead (${round1(leg.dropKm)} km). Directions: ${mapsLink(fromPos, to, p.travel)}\nAsk ${to.name} for their drop code at handover.`, msg.lateButton(shareId)));
    await deps.emit({ type: "redirected", share: next, from, to, partner: p, arriveBy: leg.arrival, dropKm: leg.dropKm }, now);
    return ok("Thank you! The partner is on the way.");
  }

  /* ---------- partner app helpers ---------- */

  /** Partner app: go online or offline, optionally with the current position. */
  async function setOnline(phone: string, online: boolean, pos: LatLng | undefined): Promise<Result> {
    const mine = await store.list("partner", { phone });
    if (!mine.length) return fail("This phone isn't registered as a delivery partner yet.", 404);
    for (const p of mine) await store.put("partner", { ...p, online, ...(pos ?? {}) });
    return ok(online ? "You're online." : "You're offline.");
  }

  /** The trip this phone's partner is on, for codes and location pins sent over WhatsApp. */
  async function activeTripFor(phone: string) {
    const mine = new Set((await store.list("partner", { phone })).map((p) => p.id));
    const live = [...(await store.list("share", { status: "picked_up" })), ...(await store.list("share", { status: "assigned" }))];
    return live.find((s) => s.partnerId && mine.has(s.partnerId)) ?? null;
  }

  /** Live trip for the map: where the partner is and when they'll arrive. */
  async function track(share: Share, now: number) {
    const l = await rt.mustGet("listing", share.listingId);
    const ngo = share.ngoId ? await store.get("recipient", share.ngoId) : null;
    const p = await partnerOf(share);
    const live = p && ngo && (share.status === "assigned" || share.status === "picked_up");
    const leg = live ? legFor(ngo, l, originOf(share, p, l, now)) : null;
    return {
      shareId: share.id,
      status: share.status,
      pickup: { name: l.donorName, lat: l.lat, lng: l.lng },
      drop: ngo ? { name: ngo.name, lat: ngo.lat, lng: ngo.lng } : null,
      partner: p && share.partnerId ? { name: p.name, lat: share.lastPos?.lat ?? p.lat, lng: share.lastPos?.lng ?? p.lng, manual: !!p.manual, rating: p.manual ? null : reliabilityLine(p.reliability) } : null,
      lateMin: share.promisedArrival && leg ? Math.max(0, Math.round((leg.arrival - share.promisedArrival) / 60_000)) : 0,
      eta: leg?.arrival ?? null,
      containers: containersOf(l, share.lines),
      keepReady: keepReady(l, share.lines),
    };
  }

  /* ---------- the clock ---------- */

  /**
   * Shares that went unplaced because nobody could collect them get another go once a partner who can
   * reach an NGO that hasn't said no is online. Quiet otherwise: no repeated escalations. Returns revived shares.
   */
  async function retryUnplaced(now: number): Promise<Share[]> {
    const revived: Share[] = [];
    for (const share of await store.list("share", { status: "unplaced" })) {
      if (share.held || now - (share.retriedAt ?? share.createdAt) < config.replanEveryMs) continue;
      const l = await store.get("listing", share.listingId);
      if (!l || l.status === "closed" || now >= l.collectBy || safeUntilOf(l, share.lines) <= now) continue;
      const passed = new Set((await store.list("decision", { listingId: l.id }))
        .filter((d) => (d.kind === "declined" || d.kind === "expired") && (d.data as { shareId?: string } | undefined)?.shareId === share.id)
        .map((d) => d.subject));
      let ready: Recipient | null = null;
      for (const c of share.candidates) {
        if (passed.has(c.ngoId)) continue;
        const ngo = await store.get("recipient", c.ngoId);
        if (ngo?.active && (config.simulateUnclaimed || ngo.phone) && (await partnersFor(share, l, ngo, now)).length) { ready = ngo; break; }
      }
      if (!ready) {
        await store.cas("share", { ...share, retriedAt: now }, "unplaced");
        continue;
      }
      const next: Share = { ...share, status: "offering", triedNgoIds: [...passed], retriedAt: now };
      if (!(await store.cas("share", next, "unplaced"))) continue;
      await decide(now, "replanned", ready.id, `A delivery partner who can reach ${ready.name} is online now, so ${servingsOf(share.lines)} servings of ${foodOf(l, share.lines)} are being offered again.`, l.id, { shareId: share.id });
      await offerNext(next, now);
      revived.push(next);
    }
    return revived;
  }

  async function tick(now: number) {
    for (const s of await store.list("share", { status: "offering" })) {
      if (s.ngoId && now > (s.offerDeadlineAt ?? 0)) await rt.safely(`expire ${s.id}`, () => expireOffer(s, now));
    }
    for (const s of await store.list("share", { status: "finding_partner" })) {
      // The 30-minute hold runs out even mid-ask: the food moves on if another NGO has a partner free.
      if (s.ngoId && now - acceptedAtOf(s) >= config.ngoHoldAfterAcceptMaxMs) {
        const l = await store.get("listing", s.listingId), ngo = await store.get("recipient", s.ngoId);
        let moved = false;
        if (l && ngo) await rt.safely(`hold ${s.id}`, async () => { moved = await handOnToNextNgo(s, l, ngo, s.waitingForPartnerSince, now); });
        if (moved) continue;
      }
      if (s.askedPartnerId && now > (s.askDeadlineAt ?? 0)) {
        const p = await store.get("partner", s.askedPartnerId);
        if (p) await rt.safely(`release ${s.id}`, () => releaseAsk(s, p, now, "expired"));
      } else if (!s.askedPartnerId && now - (s.lastPartnerTryAt ?? 0) >= config.partnerRetryMs) {
        await rt.safely(`partner search ${s.id}`, () => askNextPartner(s, now));
      }
    }
    for (const status of ["assigned", "picked_up"] as const) {
      for (const s of await store.list("share", { status })) {
        if (s.redirect && now > s.redirect.deadlineAt) {
          await rt.safely(`redirect ${s.id}`, () => redirectReply(s.id, false, { sim: true }, now));
          continue;
        }
        const due = status === "assigned" ? s.pickupBy : s.deliverBy;
        if (now > due || now - (s.lastEtaCheckAt ?? 0) >= config.lateness.etaCheckMs) await rt.safely(`watch ${s.id}`, () => watch(s, now, false));
      }
    }
    await freeIdlePartners();
    await simulate(now);
  }

  /**
   * A partner is busy only while their share is live with them: being asked, on the way, or carrying the
   * food. A share that ended any other way (finished, cancelled, held before pickup, gone) frees them, so
   * they keep getting pickup requests.
   */
  async function freeIdlePartners() {
    for (const p of await store.list("partner")) {
      if (!p.activeShareId) continue;
      const s = await store.get("share", p.activeShareId);
      const mine = s && (s.partnerId === p.id || s.askedPartnerId === p.id);
      const live = mine && (s.status === "finding_partner" || s.status === "picked_up" || (s.status === "assigned" && !s.held));
      if (!live) await store.put("partner", { ...p, activeShareId: undefined });
    }
  }

  /** Sample NGOs and partners that no real phone has claimed act on their own. */
  async function simulate(now: number) {
    if (!config.simulateUnclaimed) return;
    const sim = { sim: true } as const;
    for (const s of await store.list("share", { status: "offering" })) {
      const ngo = s.ngoId ? await store.get("recipient", s.ngoId) : null;
      if (ngo && !ngo.phone && now >= (s.offerSentAt ?? now) + config.simReplyMs) await rt.safely(`simulate ${s.id}`, () => ngoReply(s.id, true, sim, now));
    }
    for (const s of await store.list("share", { status: "finding_partner" })) {
      const p = s.askedPartnerId ? await store.get("partner", s.askedPartnerId) : null;
      if (p && simulatedPartner(p) && now >= (s.askedAt ?? now) + config.simReplyMs) await rt.safely(`simulate ${s.id}`, () => partnerReply(s.id, true, sim, now));
    }
    for (const status of ["assigned", "picked_up"] as const) {
      for (const s of await store.list("share", { status })) {
        await rt.safely(`simulate ${s.id}`, async () => {
          if (s.redirect) {
            const to = await rt.mustGet("recipient", s.redirect.ngoId);
            if (!to.phone && now >= s.redirect.sentAt + config.simReplyMs) await redirectReply(s.id, true, sim, now);
            return;
          }
          const p = await partnerOf(s);
          if (!p || !simulatedPartner(p) || s.held) return;
          const l = await rt.mustGet("listing", s.listingId);
          const ngo = await rt.mustGet("recipient", s.ngoId!);
          if (status === "assigned") {
            const leg = etaMs(distanceKm(p, l), p.travel) / config.simTravelSpeedup;
            if (now >= (s.assignedAt ?? now) + leg && now >= l.readyFrom) await enterCode(s.id, "pickup", s.pickupCode, sim, now);
          } else {
            const leg = etaMs(distanceKm(l, ngo), p.travel) / config.simTravelSpeedup;
            if (now >= (s.pickedUpAt ?? now) + leg) await enterCode(s.id, "drop", s.dropCode, sim, now);
          }
        });
      }
    }
  }

  return {
    startShare,
    ngoReply,
    partnerReply,
    openFor,
    claim,
    assignManual,
    enterCode,
    late,
    location,
    offerRedirect,
    redirectReply,
    originFor,
    setOnline,
    activeTripFor,
    track,
    tick,
    retryUnplaced,
    fasterPartner,
    replacePartner,
  };
}

export type LogisticsAgent = ReturnType<typeof createLogisticsAgent>;
