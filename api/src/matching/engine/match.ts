/**
 * Steps 1–2 plus splitting, as one pure function: given a listing (or part of
 * one), recipients and delivery partners, decide who should be offered what.
 */
import { config } from "../config.ts";
import type { HungerProvider } from "../hooks.ts";
import type { Item, LatLng, Listing, OfferLine, Partner, ReasonCode, Recipient, Travel } from "../types.ts";
import { allocate, type PlannedOffer } from "./allocate.ts";
import { distanceKm, etaMs } from "./geo.ts";
import { rank, type Scored } from "./rank.ts";
import { checkRecipient, openAt, serveTimeFor, type Leg } from "./rules.ts";
import { nextClockTime } from "../time.ts";

export interface Skip {
  recipient: Recipient;
  item: Item;
  code: ReasonCode;
  detail: Record<string, unknown>;
}

/** Where the food starts its drop leg from. */
export interface Origin {
  pos: LatLng;
  /** When the partner leaves `pos`. */
  startAt: number;
  travel: Travel;
  /** False while the food is still at the restaurant: the partner goes there first. */
  pickedUp: boolean;
}

export interface MatchInput {
  listing: Listing;
  /** Items with the servings still to place (may be a subset of the listing). */
  items: Item[];
  recipients: Recipient[];
  /** Delivery partners, to estimate when food can leave the restaurant. */
  partners: Partner[];
  now: number;
  hunger: HungerProvider;
  exclude?: ReadonlySet<string>;
  /** Servings already promised to each recipient for this listing. */
  capUsed?: ReadonlyMap<string, number>;
  credits?: ReadonlySet<string>;
  pledgedAreas?: ReadonlySet<string>;
  /** Set for redirects: plan from the partner's position instead of a fresh pickup. */
  origin?: Origin;
}

export interface MatchResult {
  skipped: Skip[];
  ranked: Map<string, Scored[]>;
  offers: PlannedOffer[];
  unallocated: OfferLine[];
}

/** The nearest free, online partner decides when food can leave the restaurant. */
export function pickupEstimate(listing: Listing, partners: Partner[], now: number): { at: number; travel: Travel } {
  let best: { at: number; travel: Travel } | null = null;
  for (const v of partners) {
    if (!v.online || v.activeShareId) continue;
    const at = now + etaMs(distanceKm(v, listing), v.travel);
    if (!best || at < best.at) best = { at, travel: v.travel };
  }
  const est = best ?? { at: now + config.fallbackPickupLegMs, travel: "two_wheeler" as Travel };
  return { at: Math.max(est.at, listing.readyFrom), travel: est.travel };
}

/** `canWait`: the food hasn't left yet, so the drop can be planned for when a closed NGO opens (not for redirects). */
export function legFor(r: Recipient, listing: Listing, start: Origin, canWait = !start.pickedUp): Leg {
  let from: LatLng = start.pos;
  let at = start.startAt;
  if (!start.pickedUp) {
    at = Math.max(at + etaMs(distanceKm(start.pos, listing), start.travel), listing.readyFrom);
    from = listing;
  }
  const dropKm = distanceKm(from, r);
  let arrival = at + etaMs(dropKm, start.travel);
  // Not yet collected and the NGO is closed then: plan the drop for when it opens, not for a locked gate.
  const closed = canWait && !!r.receivingHours && !openAt(r.receivingHours, arrival);
  if (closed) arrival = nextClockTime(arrival, [r.receivingHours!.start]);
  return { arrival, serveTime: serveTimeFor(r, arrival), dropKm, ...(closed ? { waitsForOpening: true } : {}) };
}

export function matchListing(input: MatchInput): MatchResult {
  const { listing, now, hunger } = input;
  const exclude = input.exclude ?? new Set<string>();
  const capUsed = input.capUsed ?? new Map<string, number>();

  // Fair Share may widen preferences (radius, amount); safety fields are never touched.
  const recipients = input.recipients.map((r) => ({ ...r, ...(hunger.relaxedPreferences?.(r, now) ?? {}) }));

  let origin = input.origin;
  if (!origin) {
    const p = pickupEstimate(listing, input.partners, now);
    origin = { pos: listing, startAt: p.at, travel: p.travel, pickedUp: true };
  }
  const fresh = !input.origin;   // a new plan, not a mid-trip redirect
  const legs = new Map(recipients.map((r) => [r.id, legFor(r, listing, origin, fresh)]));

  const capLeft = new Map(recipients.map((r) => [r.id, Math.max(0, r.capacityPerDelivery - (capUsed.get(r.id) ?? 0))]));
  const skipped: Skip[] = [];
  const ranked = new Map<string, Scored[]>();

  for (const item of input.items) {
    const feasible: { recipient: Recipient; leg: Leg }[] = [];
    for (const r of recipients) {
      const leg = legs.get(r.id)!;
      const res = checkRecipient(item, listing, r, leg, exclude);
      if (res.ok) feasible.push({ recipient: r, leg });
      else skipped.push({ recipient: r, item, code: res.code, detail: res.detail });
    }
    ranked.set(
      item.id,
      rank(item, listing, feasible, {
        now,
        hunger,
        credits: input.credits ?? new Set(),
        pledgedAreas: input.pledgedAreas ?? new Set(),
        capLeft: (r) => capLeft.get(r.id) ?? 0,
      }),
    );
  }

  const { offers, unallocated } = allocate(input.items, ranked, capLeft);
  return { skipped, ranked, offers, unallocated };
}
