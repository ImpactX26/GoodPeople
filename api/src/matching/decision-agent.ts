/**
 * Decision Agent. Opens a case when a Food Passport arrives, runs it to the
 * end and closes it. It asks the NGO Agent for shares, hands each to the
 * Logistics Agent, and reacts to what Logistics reports: it keeps the
 * restaurant, NGO and partner updated, re-plans food nobody took, redirects
 * when a delay would make food unsafe, escalates when stuck, and logs a
 * plain-language reason for every decision. It also runs proactive gap closing.
 */
import { config } from "./config.ts";
import { distanceKm, round1 } from "./engine/geo.ts";
import { itemName } from "./engine/reasons.ts";
import { keepReady, packingLines, reviewPassport, shareContainers } from "./food-agent.ts";
import { findGaps, mapDonors, planOutreach, windowLabel, type GapDonor } from "./gaps.ts";
import type { LogisticsAgent, LogisticsEvent } from "./logistics-agent.ts";
import type { NgoAgent } from "./ngo-agent.ts";
import { code4, fail, foodOf, itemsOf, ok, owns, servingsOf, usable, type Actor, type Result, type Runtime } from "./runtime.ts";
import { areaById } from "./seed.ts";
import { comeByFor, leftoverOf, linesText, nearestCollector } from "./biogas.ts";
import { safeUntil } from "./engine/safety.ts";
import { fmtTime } from "./time.ts";
import type { DecisionKind, Item, Listing, Partner, Share, TripMark } from "./types.ts";
import { markFor, reliabilityLine, withMark } from "./reliability.ts";
import * as msg from "./whatsapp/templates.ts";

export type NewListing = Omit<Listing, "id" | "status" | "createdAt" | "unplacedServings">;

const LIVE = new Set<Share["status"]>(["offering", "finding_partner", "assigned", "picked_up"]);
const FEEDBACK = { fewer: "fed fewer people than expected", right: "fed about the expected number", more: "fed more people than expected" };

export function createDecisionAgent(rt: Runtime, deps: { ngo: NgoAgent; logistics: LogisticsAgent; listDonors?: () => Promise<GapDonor[]> }) {
  const { store } = rt;
  const { ngo: ngoAgent, logistics } = deps;
  const decide = (now: number, kind: DecisionKind, subject: string, reason: string, listingId?: string, data?: unknown) =>
    rt.decide("decision", now, kind, subject, reason, listingId, data);
  let lastGapRun = 0;

  /* ---------- opening a case ---------- */

  /** `reviewed`: the Luna API already ran first-listing review (and the food check), so the case opens now. */
  async function submitListing(input: NewListing, now: number, opts: { reviewed?: boolean } = {}): Promise<Listing> {
    const first = (await store.list("listing", { donorPhone: input.donorPhone })).length === 0;
    const listing: Listing = { pickupCode: code4(), ...input, id: rt.id("l"), createdAt: now, status: first && config.reviewFirstListing && !opts.reviewed ? "review" : "matching", unplacedServings: 0 };
    await store.insert("listing", listing);
    for (const n of reviewPassport(listing)) await rt.decide("food", now, "graded", n.itemId, n.reason, listing.id);

    if (listing.status === "review") {
      await decide(now, "review", listing.donorPhone, `First listing from ${listing.donorName}: waiting for an admin to check it before matching.`, listing.id);
      await rt.toDonor(now, listing, "Thanks for listing! As it's your first donation, someone from Luna will check it in a few minutes, then we'll find it a home.");
      return listing;
    }
    await openCase(listing, now);
    return (await store.get("listing", listing.id))!;
  }

  async function approveListing(listingId: string, now: number): Promise<Result> {
    const l = await store.get("listing", listingId);
    if (!l) return fail("Unknown listing.", 404);
    const next = { ...l, status: "matching" as const };
    if (!(await store.cas("listing", next, "review"))) return fail("This listing isn't waiting for review.");
    await decide(now, "review", l.donorPhone, `An admin approved ${l.donorName}'s first listing.`, l.id);
    await openCase(next, now);
    return ok();
  }

  async function openCase(l: Listing, now: number) {
    await decide(now, "review", l.id, `Opened a case for ${l.donorName}: ${l.items.map((i) => `${i.servings} × ${itemName(i)}`).join(", ")}.`, l.id);
    await place(l, l.items, now, true);
  }

  /** Ask the NGO Agent to split these servings into shares, and start each with Logistics. */
  async function place(l: Listing, items: Item[], now: number, initial: boolean) {
    const shares = await store.list("share", { listingId: l.id });
    const exclude = new Set(shares.flatMap((s) => s.triedNgoIds));
    const capUsed = new Map<string, number>();
    for (const s of shares.filter((s) => LIVE.has(s.status) || s.status === "delivered"))
      if (s.ngoId) capUsed.set(s.ngoId, (capUsed.get(s.ngoId) ?? 0) + servingsOf(s.lines));

    const plan = await ngoAgent.planShares(l, items, now, { exclude, capUsed, logSkips: initial });
    for (const s of plan.shares) await logistics.startShare(l, s, now);

    const unplaced = servingsOf(plan.unallocated);
    const fresh = (await store.get("listing", l.id))!;
    const placedAny = plan.shares.length > 0 || (await store.list("share", { listingId: l.id })).some((s) => LIVE.has(s.status) || s.status === "delivered");
    await store.put("listing", { ...fresh, unplacedServings: (initial ? 0 : fresh.unplacedServings) + unplaced, ...(unplaced > 0 ? { stuckWhy: plan.why } : {}) });
    // Later re-plans (an NGO passed) are explained by whoever asked for them, so the restaurant hears it once.
    if (unplaced > 0 && initial) {
      const what = plan.unallocated.map((u) => `${u.servings} × ${itemName(l.items.find((i) => i.id === u.itemId)!)}`).join(", ");
      const plant = await nearestCollector(store, l);
      await decide(now, "escalated", l.id, `No NGO can safely take ${what}: ${plan.why}.${plant ? ` Offering ${l.donorName} a biogas pickup instead (${plant.name}, ${plant.km} km).` : " No biogas plant is set up nearby, so a person needs to decide what to do with it."}`, l.id, { unallocated: plan.unallocated });
      await rt.toDonor(now, l, noNgoText(placedAny ? what : "your food", plan.why, !!plant));
    }
    await refreshListing(l.id, now);
  }

  /** What the restaurant hears when no NGO can take some food: the real reason, and the biogas way out. */
  const noNgoText = (what: string, why: string, plant: boolean) =>
    `No NGO can take ${what} before it stops being safe: ${why}.${plant ? ' You can send it to a biogas plant instead; they collect it from you. Open the donation in Luna and tap "Send to biogas".' : " The Luna team has been alerted and will get back to you."}`;

  async function refreshListing(listingId: string, now: number) {
    const l = await store.get("listing", listingId);
    if (!l || l.status === "review" || l.lapsed) return;
    const shares = await store.list("share", { listingId });
    const live = shares.filter((s) => LIVE.has(s.status));
    const bio = await store.list("biogas", { listingId });
    const status: Listing["status"] = live.some((s) => s.status === "offering" || s.status === "finding_partner")
      ? "matching"
      : live.length || bio.some((b) => b.status === "booked")
        ? l.unplacedServings > 0 ? "partially_matched" : "matched"
        : shares.some((s) => s.status === "delivered") || bio.length ? "closed" : "unmatched";
    if (status === l.status) return;
    await store.put("listing", { ...l, status });
    if (status === "closed") {
      const fed = shares.filter((s) => s.status === "delivered").reduce((n, s) => n + servingsOf(s.lines), 0);
      const gas = bio.reduce((n, b) => n + servingsOf(b.lines), 0);
      await decide(now, "closed", l.id, `Closed the case for ${l.donorName}: ${fed} servings delivered${gas ? `, ${gas} sent to biogas` : ""}${l.unplacedServings ? `, ${l.unplacedServings} couldn't be placed` : ""}.`, l.id);
    }
  }

  /**
   * While the donor is waiting on an NGO or a partner, silence is filled: a short "still on it" every
   * few minutes with where things stand (spec §14.1, heartbeat).
   */
  async function heartbeat(now: number) {
    for (const l of await store.list("listing")) {
      if (l.status === "closed" || l.status === "review") continue;
      const waiting = (await store.list("share", { listingId: l.id })).filter((s) => s.status === "offering" || s.status === "finding_partner");
      if (!waiting.length) continue;
      const last = Math.max(l.lastHeartbeatAt ?? 0, ...(await store.list("decision", { listingId: l.id })).map((d) => d.at));
      if (now - last < config.heartbeatMs) continue;
      await store.put("listing", { ...l, lastHeartbeatAt: now });
      const parts: string[] = [];
      for (const s of waiting) {
        const ngo = s.ngoId ? await store.get("recipient", s.ngoId) : null;
        if (s.status === "offering" && ngo) parts.push(`waiting for ${ngo.name} to reply (${Math.max(0, Math.round(((s.offerDeadlineAt ?? now) - now) / 60_000))} min left)`);
        else if (ngo) parts.push(`${ngo.name} accepted; finding a delivery partner`);
      }
      await rt.toDonor(now, l, `Still on it: ${parts.join("; ")}.`);
    }
  }

  /**
   * Servings no NGO could take (all closed, full, or too far for the food's safe time) get another look while
   * the food is safe and collectable: an NGO may open, list itself, or free up room. Quiet unless it places food.
   */
  async function replanUnplaced(now: number) {
    for (const l of await store.list("listing")) {
      if (l.unplacedServings <= 0 || l.status === "review" || l.status === "closed" || now >= l.collectBy) continue;
      if (now - (l.lastReplanAt ?? l.createdAt) < config.replanEveryMs) continue;
      await store.put("listing", { ...l, lastReplanAt: now });
      const shares = await store.list("share", { listingId: l.id });
      const placed = new Map<string, number>();
      for (const s of shares) if (LIVE.has(s.status) || s.status === "delivered" || s.status === "unplaced") for (const ln of s.lines) placed.set(ln.itemId, (placed.get(ln.itemId) ?? 0) + ln.servings);
      const items = l.items.map((i) => ({ ...i, servings: i.servings - (placed.get(i.id) ?? 0) })).filter((i) => i.servings > 0);
      if (!items.length) continue;
      const declined = new Set((await store.list("decision", { listingId: l.id })).filter((d) => d.kind === "declined" || d.kind === "expired").map((d) => d.subject));
      const capUsed = new Map<string, number>();
      for (const s of shares.filter((s) => LIVE.has(s.status) || s.status === "delivered")) if (s.ngoId) capUsed.set(s.ngoId, (capUsed.get(s.ngoId) ?? 0) + servingsOf(s.lines));
      const plan = await ngoAgent.planShares(l, items, now, { exclude: declined, capUsed, logSkips: false });
      if (!plan.shares.length) continue;
      const n = plan.shares.reduce((sum, s) => sum + servingsOf(s.lines), 0);
      await decide(now, "replanned", l.id, `Looked again: ${n} servings that no NGO could take earlier can now go out.`, l.id);
      for (const s of plan.shares) await logistics.startShare(l, s, now);
      const fresh = (await store.get("listing", l.id))!;
      await store.put("listing", { ...fresh, unplacedServings: Math.max(0, fresh.unplacedServings - n) });
      await refreshListing(l.id, now);
    }
  }

  /* ---------- reacting to Logistics ---------- */

  async function onLogistics(e: LogisticsEvent, now: number) {
    const l = await rt.mustGet("listing", e.share.listingId);
    switch (e.type) {
      case "ngo_accepted": {
        for (const c of await store.list("credit", { recipientId: e.ngo.id, status: "open" })) await store.put("credit", { ...c, status: "used" });
        await rt.toDonor(now, l, `Matched! ${servingsOf(e.share.lines)} servings are going to ${e.ngo.name}. We're finding a delivery partner now.`);
        break;
      }
      case "partner_assigned": {
        // The packing note (spec §12.6.1): who's coming, for which NGO, exactly what to pack for them, and the one code.
        const live = (await store.list("share", { listingId: l.id })).filter((s) => s.partnerId || s.id === e.share.id).sort((a, b) => a.createdAt - b.createdAt);
        const k = live.findIndex((s) => s.id === e.share.id) + 1;
        const pack = packingLines(l, e.share.lines).map((p) => `• ${p.name}: ${p.amount ? `${p.amount} (${p.servings} servings)` : `${p.servings} servings`}`).join("\n");
        const many = live.length > 1 || (await store.list("share", { listingId: l.id })).length > 1;
        await rt.toDonor(now, l, [
          `Pack for ${e.partner.name}, delivering to ${e.ngo.name}. Arrives about ${fmtTime(e.pickupAt)}; please have it ready by ${fmtTime(e.pickupAt - 5 * 60_000)}:`,
          pack,
          `${e.partner.name} brings ${(l.containers.length ? l.containers : shareContainers(l, e.share.lines)).join(" + ")}.`,
          `Pickup code: ${e.share.pickupCode}${many ? " (the same for every partner collecting from this listing)" : ""}. Show it when you hand over the food.`,
          many ? `This is pickup ${Math.max(k, 1)} from your listing; keep each partner's food packed separately.` : "",
        ].filter(Boolean).join("\n"));
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.dropCode({ partner: partnerLabel(e.partner), servings: servingsOf(e.share.lines), arriveBy: e.arriveBy, code: e.share.dropCode }));
        break;
      }
      case "picked_up":
        await rt.toDonor(now, l, `Picked up by ${e.partner.name}. On the way to ${e.ngo.name}.`);
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.text(`${e.partner.name} picked up the ${foodOf(l, e.share.lines)}${e.share.promisedArrival ? `, arriving about ${fmtTime(Math.max(now, e.share.promisedArrival))}` : ""}. Keep your drop code ready.`));
        break;
      /* Keeping everyone in the loop (spec §14.3). The NGO and partner already get their own offer/request. */
      case "offered":
        await rt.toDonor(now, l, `Asked ${e.ngo.name} to take ${servingsOf(e.share.lines)} servings of ${foodOf(l, e.share.lines)}. They have ${e.minutes} min to reply.`);
        break;
      case "ngo_passed":
        await rt.toDonor(now, l, `${e.ngo.name} couldn't take it${e.how === "expired" ? " in time" : " right now"}. Luna is asking the next NGO.`);
        break;
      case "partner_asked":
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.text(`Asking ${e.partner.name}${e.own ? " (one of your volunteers)" : " (a delivery partner nearby)"} to collect the ${foodOf(l, e.share.lines)}.`));
        break;
      case "partner_waiting":
        await rt.toDonor(now, l, `${e.ngo.name} will take it. No delivery partner is free just now; one is asked the moment they are. Please keep the food ready.`);
        break;
      case "partner_exhausted":
        await rt.toDonor(now, l, `${e.ngo.name} couldn't get a delivery partner in time, so Luna is asking another NGO.`);
        break;
      case "eta":
        await onEta(e.share, e.partner, e.ngo.name, e.ngo.phone, e.ngo.id, l, e.arrival, e.pickupAt, now);
        break;
      case "delivered": {
        const n = servingsOf(e.share.lines);
        if (e.share.promisedArrival && !e.partner.manual) {
          const lateMin = Math.max(0, Math.round((now - e.share.promisedArrival) / 60_000));
          await rate(e.partner, { shareId: e.share.id, at: now, lateMin, reported: !!e.share.lateReported, final: true, kind: lateMin > config.lateness.graceMin ? "late" : "on_time" }, l.id, now);
        }
        await rt.toDonor(now, l, `Delivered to ${e.ngo.name} at ${fmtTime(now)}, fed ${n}. Thank you!`);
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.feedbackAsk({ shareId: e.share.id, servings: n, donor: l.donorName }));
        if (!e.partner.manual) await rt.send(now, e.partner.phone, `partner:${e.partner.id}`, msg.text(`Delivered! Thank you, ${e.partner.name}. You just helped feed ${n} people.`));
        break;
      }
      case "unplaced": {
        const before = (await store.list("share", { listingId: l.id })).length;
        await place(l, itemsOf(l, e.share.lines), now, false);
        if ((await store.list("share", { listingId: l.id })).length > before) break;
        // Say which it is: every NGO said no (biogas is the way out), or an NGO would take it but nobody can collect yet.
        const fresh = (await store.get("listing", l.id))!;
        const left = await leftoverOf(store, fresh);
        const food = `${servingsOf(e.share.lines)} servings of ${foodOf(l, e.share.lines)}`;
        if (left.servings > 0) {
          const plant = await nearestCollector(store, fresh);
          await decide(now, "escalated", l.id, `Every NGO that could safely take ${food} has passed.${plant ? ` Offering ${l.donorName} a biogas pickup instead (${plant.name}, ${plant.km} km).` : " No biogas plant is set up nearby, so a person needs to decide."}`, l.id, { shareId: e.share.id });
          await store.put("listing", { ...fresh, stuckWhy: "every NGO that could safely take it said no or didn't reply in time" });
          await rt.toDonor(now, l, noNgoText(food, "every NGO that could safely take it said no or didn't reply in time", !!plant));
        } else {
          await decide(now, "escalated", l.id, `${food}: an NGO would take it, but no delivery partner can collect it yet. Luna asks again as soon as one can, while it's safe.`, l.id, { shareId: e.share.id });
          await rt.toDonor(now, l, `An NGO would take your ${foodOf(l, e.share.lines)}, but no delivery partner can collect it yet. Luna asks again the moment one can, while it's still safe.`);
        }
        break;
      }
      case "behind_schedule":
        await decide(now, "delayed", e.share.id, `The partner is behind schedule but the food still reaches ${e.ngo.name} safely (about ${fmtTime(e.arrival)}).`, l.id, { shareId: e.share.id });
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.text(`The delivery partner is running a little late. New arrival time: about ${fmtTime(e.arrival)}.`));
        break;
      case "unsafe_delay": {
        const s = (await store.get("share", e.share.id))!;
        const p = s.partnerId ? await store.get("partner", s.partnerId) : null;
        if (p && !p.manual) await rate(p, { shareId: s.id, at: now, lateMin: s.promisedArrival ? Math.max(0, Math.round((now - s.promisedArrival) / 60_000)) : 0, reported: !!s.lateReported, final: true, kind: "unsafe_delay" }, l.id, now);
        await redirect(s, now);
        break;
      }
      case "redirect_failed":
        await redirect((await store.get("share", e.share.id))!, now);
        break;
      case "redirected": {
        await store.insert("credit", { id: rt.id("c"), recipientId: e.from.id, status: "open", reason: `Redirected away on listing ${l.id}`, createdAt: now });
        await decide(now, "redirected", e.to.id, `Redirected ${e.partner.name}'s food from ${e.from.name} to ${e.to.name} (${round1(e.dropKm)} km away, arriving about ${fmtTime(e.arriveBy)}) because the delay meant it would no longer be safe when ${e.from.name} served it. ${e.from.name} gets priority on the next listing.`, l.id, { shareId: e.share.id, from: e.from.id, to: e.to.id });
        await rt.send(now, e.to.phone, `recipient:${e.to.id}`, msg.dropCode({ partner: partnerLabel(e.partner), servings: servingsOf(e.share.lines), arriveBy: e.arriveBy, code: e.share.dropCode }));
        await rt.send(now, e.from.phone, `recipient:${e.from.id}`, msg.text("Sorry: the partner bringing your food was delayed, and it wouldn't have stayed safe until you serve it, so it went to a closer place. You'll get priority on the next listing."));
        await rt.toDonor(now, l, `Change of plan: the partner was delayed, so your food is going to ${e.to.name} instead, where it can be served while it's still safe.`);
        break;
      }
      case "stuck":
        await decide(now, "escalated", e.share.id, e.reason, l.id, { shareId: e.share.id });
        break;
    }
    await refreshListing(l.id, now);
  }

  /** Updates a partner's reliability with this trip's mark (live while late, final at the drop) and logs why. */
  async function rate(p: Partner, m: Omit<TripMark, "score">, listingId: string, now: number) {
    const fresh = (await store.get("partner", p.id)) ?? p;
    const before = fresh.reliability?.score;
    const reliability = withMark(fresh.reliability, { ...m, score: markFor(m.kind, m.lateMin, m.reported) });
    await store.put("partner", { ...fresh, reliability });
    if (before === undefined || Math.abs(reliability.score - before) >= 0.05)
      await decide(now, "rated", p.id, `${p.name}'s reliability is now ${reliability.score.toFixed(1)} / 5 (${m.kind === "on_time" ? "on time" : m.kind === "late" ? `${m.lateMin} min late${m.reported ? ", warned us" : ""}` : m.kind === "reassigned" ? "pickup reassigned for lateness" : "delay made the food unsafe for its NGO"}).`, listingId, { partnerId: p.id, score: reliability.score });
    return reliability;
  }

  /**
   * A live trip's estimate against what was promised. Late past the grace: the partner's rating moves now,
   * the NGO, the restaurant and the partner hear the new times (again each time it slips another few
   * minutes), and before pickup a much faster free partner takes over.
   */
  async function onEta(share: Share, partner: Partner, ngoName: string, ngoPhone: string | undefined, ngoId: string, l: Listing, arrival: number, pickupAt: number | null, now: number) {
    if (!share.promisedArrival || partner.manual) return;
    const L = config.lateness;
    const lateMin = Math.max(0, Math.round((arrival - share.promisedArrival) / 60_000));
    if (lateMin <= L.graceMin) return;
    const reported = !!share.lateReported;
    const rel = await rate(partner, { shareId: share.id, at: now, lateMin, reported, final: false, kind: "late" }, l.id, now);
    if (lateMin - (share.lateNoticeMin ?? 0) < L.noticeStepMin) return;
    if (!(await store.cas("share", { ...share, lateNoticeMin: lateMin }, share.status))) return;
    const food = foodOf(l, share.lines), until = fmtTime(Math.min(...itemsOf(l, share.lines).map((i) => l.createdAt + i.safeTime * 60_000)));

    // Before pickup and badly late: hand the pickup to someone who'd get there clearly sooner.
    if (share.status === "assigned" && pickupAt && lateMin >= L.reassignAfterMin) {
      const alt = await logistics.fasterPartner(share, now);
      if (alt && alt.pickupAt <= pickupAt - L.reassignGainMin * 60_000) {
        await rate(partner, { shareId: share.id, at: now, lateMin, reported, final: true, kind: "reassigned" }, l.id, now);
        await decide(now, "reassigned", share.id, `${partner.name} is ${lateMin} min behind and hasn't collected the food; ${alt.partner.name} can reach ${l.donorName} by ${fmtTime(alt.pickupAt)} instead of ${fmtTime(pickupAt)}, so the pickup moves to them.`, l.id, { shareId: share.id, from: partner.id, to: alt.partner.id });
        if (await logistics.replacePartner(share, now, `You're about ${lateMin} min behind.`)) {
          await rt.toDonor(now, l, `${partner.name} is running late, so another delivery partner is coming for the ${food} instead. Please keep it ready.`);
          await rt.send(now, ngoPhone, `recipient:${ngoId}`, msg.text(`${partner.name} was running late, so Luna is sending another delivery partner for the ${food}. We'll send the new arrival time.`));
          return;
        }
      }
    }

    const was = fmtTime(share.promisedArrival);
    await decide(now, "delayed", share.id, `${partner.name} is about ${lateMin} min behind${reported ? " (they warned us)" : ""}: ${share.status === "assigned" ? `pickup now about ${fmtTime(pickupAt ?? now)}, ` : ""}arrival at ${ngoName} about ${fmtTime(arrival)} instead of ${was}. The food stays safe until ${until}. Told ${ngoName}, ${l.donorName} and ${partner.name}.`, l.id, { shareId: share.id, lateMin });
    await rt.send(now, ngoPhone, `recipient:${ngoId}`, msg.text(`${partner.name} is running about ${lateMin} min late. The ${food} now reaches you about ${fmtTime(arrival)} (was ${was}). It's still safe to serve.`));
    await rt.toDonor(now, l, share.status === "assigned"
      ? `${partner.name} is running about ${lateMin} min late and now reaches you about ${fmtTime(pickupAt ?? now)}. Please keep the ${food} hot and ready.`
      : `Your ${food} is running about ${lateMin} min late to ${ngoName}, arriving about ${fmtTime(arrival)}. It's still safe.`);
    await rt.send(now, partner.phone, `partner:${partner.id}`, msg.text(reported
      ? `Thanks for the heads-up. ${ngoName} and ${l.donorName} know you're about ${lateMin} min behind. Your reliability: ${reliabilityLine(rel)}.`
      : `You're about ${lateMin} min behind. We've told ${ngoName} and ${l.donorName}. Next time tap "Running late" to warn them early. Your reliability: ${reliabilityLine(rel)}.`));
  }

  const partnerLabel = (p: { name: string; phone?: string }) => (p.phone ? `${p.name} (${p.phone})` : p.name);

  /** Ask the NGO Agent for the best NGO reachable from the partner now, and have Logistics offer it. */
  async function redirect(share: Share, now: number) {
    if (share.held || share.redirect) return;
    const l = await rt.mustGet("listing", share.listingId);
    const origin = await logistics.originFor(share, now);
    const best = await ngoAgent.findRedirect(l, share.lines, origin, new Set([share.ngoId!, ...share.redirectTried]), now);
    if (!best) {
      await store.put("share", { ...share, held: true });
      await decide(now, "escalated", share.id, `The partner is delayed and no other NGO can take the food before it becomes unsafe.`, l.id, { shareId: share.id });
      const p = share.partnerId ? await store.get("partner", share.partnerId) : null;
      if (p && !p.manual) await rt.send(now, p.phone, `partner:${p.id}`, msg.text("Please hold on. The food may not stay safe long enough to deliver, so the Luna team will call you shortly."));
      return;
    }
    await logistics.offerRedirect(share, best.ngoId, best.arriveBy, now);
  }

  /* ---------- closing: NGO feedback ---------- */

  /** "Fed fewer / about right / more". Recorded for the Food Agent's portion table and the NGO Agent's reliability and hunger levels. */
  async function feedback(shareId: string, result: "fewer" | "right" | "more", by: Actor, now: number): Promise<Result> {
    const share = await store.get("share", shareId);
    if (!share || share.status !== "delivered" || !share.ngoId) return fail("Unknown delivery.", 404);
    const ngo = await rt.mustGet("recipient", share.ngoId);
    if (!owns(by, ngo.phone)) return fail("This delivery isn't yours.", 403);
    if (share.feedback) return fail("Thanks, we already have your answer.");
    await store.put("share", { ...share, feedback: result });
    await decide(now, "feedback", ngo.id, `${ngo.name} ${FEEDBACK[result]} with ${servingsOf(share.lines)} servings.`, share.listingId, { shareId, result });
    return ok("Thank you! This helps us size future deliveries.");
  }

  /* ---------- proactive gap closing ---------- */

  async function runGaps(now: number) {
    const donors = [...(deps.listDonors ? await deps.listDonors() : []), ...mapDonors()];
    const plan = planOutreach(findGaps(now), donors, await store.list("contact"), now);
    for (const { gap, donors: picks } of plan) {
      for (const d of picks) {
        const pledge = { id: rt.id("p"), donorKey: d.key, areaId: gap.areaId, status: "asked" as const, until: gap.end, createdAt: now };
        await store.insert("pledge", pledge);
        await store.insert("contact", { id: rt.id("k"), donorKey: d.key, at: now });
        await rt.send(now, d.phone, `donor:${d.key}`, msg.gapRequest({ pledgeId: pledge.id, area: gap.areaName, when: windowLabel(gap) }));
        await decide(now, "gap_outreach", gap.areaId, `${gap.areaName} is usually ${Math.round(gap.gapRatio * 100)}% short of food ${windowLabel(gap)}; asked ${d.name} (${d.km} km away) whether they'll have surplus${d.phone ? "" : " (sample donor, no message sent)"}.`, undefined, { pledgeId: pledge.id, gap });
      }
    }
    return plan;
  }

  async function gapReply(pledgeId: string, yes: boolean, by: Actor, now: number): Promise<Result> {
    const p = await store.get("pledge", pledgeId);
    if (!p) return fail("Unknown request.", 404);
    if (!owns(by, p.donorKey)) return fail("This request isn't yours.", 403);
    if (!(await store.cas("pledge", { ...p, status: yes ? "yes" : "no" }, "asked"))) return fail("Thanks, we already have your answer.");
    if (!yes) return ok("No problem, thanks for letting us know.");
    const area = areaById(p.areaId)!;
    await decide(now, "pledged", p.areaId, `A donor pledged surplus for ${area.name}; NGOs there get a boost when they list it.`, undefined, { pledgeId });
    const partner = usable(await store.list("partner"))
      .filter((x) => x.online && !x.activeShareId && !x.manual)
      .sort((a, b) => distanceKm(a, area) - distanceKm(b, area))[0];
    if (partner) {
      await rt.send(now, partner.phone, `partner:${partner.id}`, msg.text(`Heads-up: a donor near ${area.name} expects surplus food before ${fmtTime(p.until)}. We may ask you for a pickup there.`));
      await decide(now, "gap_outreach", partner.id, `Gave ${partner.name} a heads-up for a likely pickup near ${area.name}.`, undefined, { pledgeId });
    }
    return ok("Thank you! List the food in Luna when it's ready and we'll send a partner.");
  }

  /* ---------- biogas: when no NGO can take it ---------- */

  /**
   * The restaurant sends the food no NGO can take to the nearest biogas plant, which collects it itself. Only
   * what's truly left over (no NGO left to ask, not just waiting for a partner); NGO deliveries carry on.
   */
  async function sendToBiogas(listingId: string, by: Actor, now: number): Promise<Result & { pickupId?: string }> {
    const l = await store.get("listing", listingId);
    if (!l) return fail("Unknown donation.", 404);
    if (!owns(by, l.donorPhone)) return fail("This donation isn't yours.", 403);
    const left = await leftoverOf(store, l);
    if (!left.servings) return fail(left.waitingOnPartner ? "An NGO will take this food; Luna is still finding someone to collect it." : "Nothing is waiting for a home: it's all going to NGOs.");
    const plant = await nearestCollector(store, l);
    if (!plant) {
      await decide(now, "escalated", l.id, `${l.donorName} wants to send ${left.servings} servings to biogas, but no biogas plant is set up within reach.`, l.id);
      return fail("No biogas plant is set up near you yet. The Luna team has been told and will call you.");
    }
    const pickup = { id: rt.id("bg"), listingId: l.id, collectorId: plant.id, lines: left.lines, status: "booked" as const, comeBy: comeByFor(plant.km, now), createdAt: now };
    await store.insert("biogas", pickup);
    // Servings stuck only for want of a partner stay with the NGOs; the ones that went unplaced for good stop being retried.
    for (const s of await store.list("share", { listingId: l.id, status: "unplaced" })) {
      const covered = s.lines.every((ln) => left.lines.some((x) => x.itemId === ln.itemId && x.servings >= ln.servings));
      if (covered) await store.put("share", { ...s, held: true });
    }
    const fresh = (await store.get("listing", l.id))!;
    await store.put("listing", { ...fresh, unplacedServings: Math.max(0, fresh.unplacedServings - left.servings) });
    const what = linesText(l, left.lines);
    await decide(now, "biogas", plant.id, `${l.donorName} sent ${what} to ${plant.name} (${plant.km} km) for biogas, because ${left.why}. It collects by about ${fmtTime(pickup.comeBy)}${plant.phone ? "" : " (sample plant, no message sent)"}.`, l.id, { pickupId: pickup.id, km: plant.km });
    if (plant.phone)
      await rt.send(now, plant.phone, `recipient:${plant.id}`, msg.text(`Biogas pickup from ${l.donorName}: ${what} (${left.servings} servings), at ${l.pickupAddress}${l.pickupNotes ? ` (${l.pickupNotes})` : ""}. Please collect by about ${fmtTime(pickup.comeBy)}.${l.pickupContactPhone ? ` Call ${l.pickupContactPhone} on arrival.` : ""}`), l.id);
    await rt.toDonor(now, l, `Booked: ${plant.name} will collect ${what} for biogas by about ${fmtTime(pickup.comeBy)}. Keep it packed and apart from fresh food, and tap "Collected" in Luna once they've taken it.`);
    await refreshListing(l.id, now);
    return { ...ok(`${plant.name} will collect it by about ${fmtTime(pickup.comeBy)}.`), pickupId: pickup.id };
  }

  async function biogasCollected(pickupId: string, by: Actor, now: number): Promise<Result> {
    const p = await store.get("biogas", pickupId);
    if (!p) return fail("Unknown pickup.", 404);
    const l = await rt.mustGet("listing", p.listingId);
    if (!owns(by, l.donorPhone)) return fail("This pickup isn't yours.", 403);
    if (!(await store.cas("biogas", { ...p, status: "collected", collectedAt: now }, "booked"))) return fail("Already marked collected.");
    const plant = await store.get("recipient", p.collectorId);
    await decide(now, "biogas", p.collectorId, `${plant?.name ?? "The biogas plant"} collected ${linesText(l, p.lines)} from ${l.donorName}. Nothing wasted.`, l.id, { pickupId, collected: true });
    await refreshListing(l.id, now);
    return ok("Thanks! Marked as collected.");
  }

  /**
   * The food's window has closed (the restaurant's collect-by time, or the last food stops being safe) and no NGO
   * took any of it: close the case and say sorry, plainly, so it doesn't sit "in progress" forever. A biogas
   * plant can still collect it; the restaurant is told so.
   */
  async function closeLapsed(now: number) {
    for (const l of await store.list("listing")) {
      if (l.status === "closed" || l.status === "review" || l.lapsed) continue;
      const lastSafe = Math.max(...l.items.map((i) => safeUntil(i, l.createdAt)));
      if (now < Math.min(l.collectBy, lastSafe)) continue;
      const shares = await store.list("share", { listingId: l.id });
      if (shares.some((s) => LIVE.has(s.status) || s.status === "delivered")) continue;
      if ((await store.list("biogas", { listingId: l.id })).length) continue;
      const asked = new Set((await store.list("decision", { listingId: l.id })).filter((d) => d.kind === "offered").map((d) => d.subject)).size;
      const ended = now >= lastSafe ? "unsafe" : "collect_by";
      for (const s of shares) if (s.status === "unplaced" && !s.held) await store.put("share", { ...s, held: true });
      await store.put("listing", { ...l, status: "closed", lapsed: { at: now, asked, ended } });
      const food = l.items.map((i) => itemName(i)).join(" and ");
      const why = asked ? `${asked} NGO${asked === 1 ? " was" : "s were"} offered it and none said yes in time` : (l.stuckWhy ?? "no NGO could take it");
      await decide(now, "closed", l.id, `No one took ${l.donorName}'s ${food} before ${ended === "unsafe" ? "it stopped being safe" : "the collect-by time"}: ${why}. Closed the case and said sorry.`, l.id, { lapsed: true, asked, ended });
      const plant = await nearestCollector(store, l);
      await rt.toDonor(now, l, `Sorry, no one could take your ${food} in time: ${why}. ${ended === "unsafe" ? "It's past its safe time now, so please don't give it to anyone." : "Your collect-by time has passed, so Luna has stopped looking."}${plant ? ' A biogas plant can still collect it: tap "Send to biogas" in Luna.' : ""} Thank you for trying.`);
    }
  }

  async function tick(now: number) {
    await logistics.tick(now);
    await heartbeat(now);
    await closeLapsed(now);
    await replanUnplaced(now);
    // Food stranded only for want of a partner goes out again once someone can collect it.
    for (const s of await logistics.retryUnplaced(now)) {
      const l = await store.get("listing", s.listingId);
      if (!l) continue;
      const n = servingsOf(s.lines);
      await store.put("listing", { ...l, unplacedServings: Math.max(0, l.unplacedServings - n) });
      await rt.toDonor(now, l, `Good news: a delivery partner is free now, so we're offering ${n} servings to an NGO again.`);
      await refreshListing(l.id, now);
    }
    if (now - lastGapRun >= config.gapRunEveryMs) {
      lastGapRun = now;
      await rt.safely("gap outreach", () => runGaps(now));
    }
  }

  return { submitListing, approveListing, onLogistics, feedback, runGaps, gapReply, sendToBiogas, biogasCollected, tick };
}

export type DecisionAgent = ReturnType<typeof createDecisionAgent>;
