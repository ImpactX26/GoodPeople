/**
 * NGO Agent (stand-in). Filters out NGOs that can't safely take the food,
 * ranks the rest and splits the servings into shares, each with a ranked list
 * of NGOs for the Logistics Agent to work down. The real NGO Agent (standing
 * needs, one-off posts, reliability, fair share) can replace this module as
 * long as it returns the same SharePlan.
 */
import { round1 } from "./engine/geo.ts";
import { matchListing, type Origin } from "./engine/match.ts";
import { rankReason, skipReason } from "./engine/reasons.ts";
import { defaultHunger, type HungerProvider } from "./hooks.ts";
import { servingsOf, usable, type Runtime } from "./runtime.ts";
import type { Item, Listing, OfferLine, ShareCandidate } from "./types.ts";

/** Most NGOs listed per share: the planned one plus backups. */
const MAX_CANDIDATES = 6;

export interface SharePlan {
  lines: OfferLine[];
  candidates: ShareCandidate[];
}

export interface PlanResult {
  shares: SharePlan[];
  unallocated: OfferLine[];
}

export function createNgoAgent(rt: Runtime, hunger: HungerProvider = defaultHunger) {
  const { store } = rt;

  /**
   * Split some servings of a listing into shares. `exclude` are NGOs that
   * already passed on this listing; `capUsed` is what's promised to each NGO.
   */
  async function planShares(l: Listing, items: Item[], now: number, opts: { exclude: Set<string>; capUsed: Map<string, number>; logSkips: boolean }): Promise<PlanResult> {
    const pledges = (await store.list("pledge", { donorKey: l.donorPhone, status: "yes" })).filter((p) => p.until > now);
    const credits = await store.list("credit", { status: "open" });
    const recipients = usable(await store.list("recipient"));
    const result = matchListing({
      listing: l,
      items,
      recipients,
      partners: usable(await store.list("partner")),
      now,
      hunger,
      exclude: opts.exclude,
      capUsed: opts.capUsed,
      credits: new Set(credits.map((c) => c.recipientId)),
      pledgedAreas: new Set(pledges.map((p) => p.areaId)),
    });

    for (const s of result.skipped) {
      hunger.onSkipped?.(s.recipient.id, s.code, l.id);
      if (s.code === "EXCLUDED" || (s.code === "INACTIVE" && !opts.logSkips)) continue;
      await rt.decide("ngo", now, "filtered", s.recipient.id, skipReason(s.code, s.detail, s.recipient, s.item), l.id, { code: s.code, itemId: s.item.id });
    }
    for (const item of items) {
      const ranked = result.ranked.get(item.id) ?? [];
      if (ranked.length)
        await rt.decide("ngo", now, "ranked", ranked[0].recipient.id, rankReason(item, ranked), l.id, {
          itemId: item.id,
          top: ranked.slice(0, 5).map((s) => ({ id: s.recipient.id, score: round1(s.score * 100) / 100, factors: s.factors })),
        });
    }
    for (const p of pledges) await store.put("pledge", { ...p, status: "used" });

    // Room each NGO has left after this plan, for picking backups.
    const room = new Map(recipients.map((r) => [r.id, r.capacityPerDelivery - (opts.capUsed.get(r.id) ?? 0)]));
    for (const o of result.offers) room.set(o.recipientId, (room.get(o.recipientId) ?? 0) - servingsOf(o.lines));

    const shares = result.offers.map((o): SharePlan => {
      const need = servingsOf(o.lines);
      // Backups: NGOs that passed Step 1 for every item in the share and have room for all of it.
      const lists = o.lines.map((ln) => result.ranked.get(ln.itemId) ?? []);
      const backups = (lists[0] ?? [])
        .filter((s) => s.recipient.id !== o.recipientId && lists.every((list) => list.some((x) => x.recipient.id === s.recipient.id)))
        .filter((s) => (room.get(s.recipient.id) ?? 0) >= need)
        .map((s) => ({ ngoId: s.recipient.id, arriveBy: s.leg.arrival }));
      return { lines: o.lines, candidates: [{ ngoId: o.recipientId, arriveBy: o.arriveBy }, ...backups].slice(0, MAX_CANDIDATES) };
    });
    return { shares, unallocated: result.unallocated };
  }

  /** The best NGO reachable from where the partner is now, for a mid-trip redirect. */
  async function findRedirect(l: Listing, lines: OfferLine[], origin: Origin, exclude: Set<string>, now: number) {
    const items = lines.map((ln) => ({ ...l.items.find((i) => i.id === ln.itemId)!, servings: ln.servings }));
    const result = matchListing({
      listing: l,
      items,
      recipients: usable(await store.list("recipient")),
      partners: [],
      now,
      hunger,
      exclude,
      credits: new Set(),
      origin,
    });
    const best = result.offers[0];
    return best ? { ngoId: best.recipientId, lines: best.lines, arriveBy: best.arriveBy } : null;
  }

  return { planShares, findRedirect };
}

export type NgoAgent = ReturnType<typeof createNgoAgent>;
