/**
 * Split a listing's items across ranked recipients by capacity. Items with the
 * fewest possible recipients are placed first, so flexible recipients don't use
 * up their room on food a stricter recipient could have taken.
 */
import type { Item, OfferLine } from "../types.ts";
import type { Scored } from "./rank.ts";

export interface PlannedOffer {
  recipientId: string;
  lines: OfferLine[];
  /** Best rank position this recipient had for any of its lines (0 = top). */
  rank: number;
  /** Latest projected arrival across its lines. */
  arriveBy: number;
}

export interface Allocation {
  offers: PlannedOffer[];
  unallocated: OfferLine[];
}

export function allocate(items: Item[], ranked: Map<string, Scored[]>, capLeft: Map<string, number>): Allocation {
  const cap = new Map(capLeft);
  const byRecipient = new Map<string, PlannedOffer>();
  const unallocated: OfferLine[] = [];

  const order = [...items].sort(
    (a, b) => (ranked.get(a.id)?.length ?? 0) - (ranked.get(b.id)?.length ?? 0) || b.servings - a.servings,
  );
  for (const item of order) {
    let remaining = item.servings;
    (ranked.get(item.id) ?? []).forEach((s, i) => {
      const room = cap.get(s.recipient.id) ?? 0;
      const give = Math.min(remaining, room);
      if (give <= 0) return;
      remaining -= give;
      cap.set(s.recipient.id, room - give);
      const offer = byRecipient.get(s.recipient.id) ?? { recipientId: s.recipient.id, lines: [], rank: i, arriveBy: 0 };
      offer.lines.push({ itemId: item.id, servings: give });
      offer.rank = Math.min(offer.rank, i);
      offer.arriveBy = Math.max(offer.arriveBy, s.leg.arrival);
      byRecipient.set(s.recipient.id, offer);
    });
    if (remaining > 0) unallocated.push({ itemId: item.id, servings: remaining });
  }
  return { offers: [...byRecipient.values()].sort((a, b) => a.rank - b.rank), unallocated };
}
