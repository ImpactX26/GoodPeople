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
import { keepReady, reviewPassport } from "./food-agent.ts";
import { findGaps, mapDonors, planOutreach, windowLabel, type GapDonor } from "./gaps.ts";
import type { LogisticsAgent, LogisticsEvent } from "./logistics-agent.ts";
import type { NgoAgent } from "./ngo-agent.ts";
import { fail, foodOf, itemsOf, ok, owns, servingsOf, usable, type Actor, type Result, type Runtime } from "./runtime.ts";
import { areaById } from "./seed.ts";
import { fmtTime } from "./time.ts";
import type { DecisionKind, Item, Listing, Share } from "./types.ts";
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
    const listing: Listing = { ...input, id: rt.id("l"), createdAt: now, status: first && config.reviewFirstListing && !opts.reviewed ? "review" : "matching", unplacedServings: 0 };
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
    if (unplaced > 0) {
      const what = plan.unallocated.map((u) => `${u.servings} × ${itemName(l.items.find((i) => i.id === u.itemId)!)}`).join(", ");
      await decide(now, "escalated", l.id, `No NGO can safely take ${what}. A person needs to decide what to do with it.`, l.id, { unallocated: plan.unallocated });
    }
    const fresh = (await store.get("listing", l.id))!;
    await store.put("listing", { ...fresh, unplacedServings: (initial ? 0 : fresh.unplacedServings) + unplaced });
    if (plan.shares.length === 0 && !(await store.list("share", { listingId: l.id })).some((s) => LIVE.has(s.status) || s.status === "delivered"))
      await rt.toDonor(now, l, "We couldn't find a place that can safely take this food right now. The Luna team has been alerted and will get back to you.");
    await refreshListing(l.id, now);
  }

  async function refreshListing(listingId: string, now: number) {
    const l = await store.get("listing", listingId);
    if (!l || l.status === "review") return;
    const shares = await store.list("share", { listingId });
    const live = shares.filter((s) => LIVE.has(s.status));
    const status: Listing["status"] = live.some((s) => s.status === "offering" || s.status === "finding_partner")
      ? "matching"
      : live.length
        ? l.unplacedServings > 0 ? "partially_matched" : "matched"
        : shares.some((s) => s.status === "delivered") ? "closed" : "unmatched";
    if (status === l.status) return;
    await store.put("listing", { ...l, status });
    if (status === "closed") {
      const fed = shares.filter((s) => s.status === "delivered").reduce((n, s) => n + servingsOf(s.lines), 0);
      await decide(now, "closed", l.id, `Closed the case for ${l.donorName}: ${fed} servings delivered${l.unplacedServings ? `, ${l.unplacedServings} couldn't be placed` : ""}.`, l.id);
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
        // "Ravi, 9:55 pm, keep 6 kg biryani + 4 L payasam ready."
        await rt.toDonor(now, l, `${e.partner.name}, ${fmtTime(e.pickupAt)}, keep ${keepReady(l, e.share.lines)} ready. Pickup code: ${e.share.pickupCode} (show it to ${e.partner.name} at pickup).`);
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.dropCode({ partner: partnerLabel(e.partner), servings: servingsOf(e.share.lines), arriveBy: e.arriveBy, code: e.share.dropCode }));
        break;
      }
      case "picked_up":
        await rt.toDonor(now, l, `Picked up by ${e.partner.name}. On the way to ${e.ngo.name}.`);
        break;
      case "delivered": {
        const n = servingsOf(e.share.lines);
        await rt.toDonor(now, l, `Delivered to ${e.ngo.name} at ${fmtTime(now)}, fed ${n}. Thank you!`);
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.feedbackAsk({ shareId: e.share.id, servings: n, donor: l.donorName }));
        if (!e.partner.manual) await rt.send(now, e.partner.phone, `partner:${e.partner.id}`, msg.text(`Delivered! Thank you, ${e.partner.name}. You just helped feed ${n} people.`));
        break;
      }
      case "unplaced": {
        const before = (await store.list("share", { listingId: l.id })).length;
        await place(l, itemsOf(l, e.share.lines), now, false);
        if ((await store.list("share", { listingId: l.id })).length === before)
          await decide(now, "escalated", l.id, `Every NGO that could safely take ${servingsOf(e.share.lines)} servings of ${foodOf(l, e.share.lines)} has passed or had no partner to collect it.`, l.id, { shareId: e.share.id });
        break;
      }
      case "behind_schedule":
        await decide(now, "delayed", e.share.id, `The partner is behind schedule but the food still reaches ${e.ngo.name} safely (about ${fmtTime(e.arrival)}).`, l.id, { shareId: e.share.id });
        await rt.send(now, e.ngo.phone, `recipient:${e.ngo.id}`, msg.text(`The delivery partner is running a little late. New arrival time: about ${fmtTime(e.arrival)}.`));
        break;
      case "unsafe_delay":
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

  async function tick(now: number) {
    await logistics.tick(now);
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

  return { submitListing, approveListing, onLogistics, feedback, runGaps, gapReply, tick };
}

export type DecisionAgent = ReturnType<typeof createDecisionAgent>;
