/**
 * NGO Agent (stand-in). Filters out NGOs that can't safely take the food,
 * ranks the rest and splits the servings into shares, each with a ranked list
 * of NGOs for the Logistics Agent to work down. The real NGO Agent (standing
 * needs, one-off posts, reliability, fair share) can replace this module as
 * long as it returns the same SharePlan.
 */
import { round1 } from "./engine/geo.ts";
import { matchListing, type Origin, type Skip } from "./engine/match.ts";
import { hhmm, itemName, rankReason, skipReason } from "./engine/reasons.ts";
import { fmtTime } from "./time.ts";
import { defaultHunger, type HungerProvider } from "./hooks.ts";
import { servingsOf, usable, type Runtime } from "./runtime.ts";
import type { Item, Listing, OfferLine, Recipient, ShareCandidate } from "./types.ts";

/** NGOs the agents match food to: biogas plants only get food the restaurant sends them (see biogas.ts). */
const forPeople = (all: Recipient[]) => usable(all).filter((r) => r.kind !== "biogas");

/** Most NGOs listed per share: the planned one plus backups. */
const MAX_CANDIDATES = 6;

export interface SharePlan {
  lines: OfferLine[];
  candidates: ShareCandidate[];
}

export interface PlanResult {
  shares: SharePlan[];
  unallocated: OfferLine[];
  /** Why the unallocated servings have nowhere to go, in plain words ("" when everything was placed). */
  why: string;
}

/**
 * The real reason nothing could take these foods, from the skips: every NGO closed until morning, or each
 * food's own blocker. So people (and the reasoning model) see the cause, not just "no NGO".
 */
export function whyUnplaced(items: Item[], skipped: Skip[]): string {
  const real = skipped.filter((s) => s.code !== "EXCLUDED" && s.code !== "INACTIVE" && items.some((i) => i.id === s.item.id));
  if (!items.length) return "";
  if (!real.length) return "no NGO near you is taking food right now (closed, full, or already passed on it)";
  if (real.every((s) => s.code === "EXPIRES_BEFORE_SERVING" && s.detail.opens)) {
    const names = [...new Set(real.map((s) => s.recipient.name))];
    const opens = real.map((s) => String(s.detail.opens)).sort()[0];
    const safe = Math.max(...real.map((s) => s.detail.safeUntil as number));
    return `${names.length === 1 ? `${names[0]} is` : names.length === 2 ? `${names.join(" and ")} are` : `all ${names.length} NGOs that take this food are`} closed until ${hhmm(opens)}, and the food is only safe until ${fmtTime(safe)}`;
  }
  return items
    .map((i) => {
      const mine = real.filter((s) => s.item.id === i.id);
      const first = mine[0] ? skipReason(mine[0].code, mine[0].detail, mine[0].recipient, mine[0].item).replace(/^Skipped /, "") : "the NGOs that can take it are full";
      return `${itemName(i)}: ${first}${mine.length > 1 ? ` (and ${mine.length - 1} more NGO${mine.length > 2 ? "s" : ""} ruled out)` : ""}`;
    })
    .join("; ");
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
    const recipients = forPeople(await store.list("recipient"));
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
      // Only the first plan logs who was ruled out; the quiet re-checks every few minutes would just repeat it.
      if (s.code === "EXCLUDED" || !opts.logSkips) continue;
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
    const stuck = items.filter((i) => result.unallocated.some((u) => u.itemId === i.id));
    return { shares, unallocated: result.unallocated, why: whyUnplaced(stuck, result.skipped) };
  }

  /** The best NGO reachable from where the partner is now, for a mid-trip redirect. */
  async function findRedirect(l: Listing, lines: OfferLine[], origin: Origin, exclude: Set<string>, now: number) {
    const items = lines.map((ln) => ({ ...l.items.find((i) => i.id === ln.itemId)!, servings: ln.servings }));
    const result = matchListing({
      listing: l,
      items,
      recipients: forPeople(await store.list("recipient")),
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
