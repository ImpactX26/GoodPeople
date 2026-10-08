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

const isExtra = (i: Item) => i.tags?.includes("extra") ?? false;

/**
 * Spec §11.6: meal food is placed against each NGO's need; extras (sweets, snacks, drinks) never count
 * toward meal need, so they ride with the NGOs already getting meals, in proportion to those meals, and only
 * where the NGO passed Step 1 for that extra (diet, allergens). An extras-only listing is placed by room.
 */
export function allocate(items: Item[], ranked: Map<string, Scored[]>, capLeft: Map<string, number>): Allocation {
  const meals = items.filter((i) => !isExtra(i)), extras = items.filter(isExtra);
  if (!meals.length || !extras.length) return allocateByRoom(items, ranked, capLeft);
  const base = allocateByRoom(meals, ranked, capLeft);
  const byRecipient = new Map(base.offers.map((o) => [o.recipientId, o]));
  const unallocated = [...base.unallocated];
  const mealsOf = (o: PlannedOffer) => o.lines.reduce((n, l) => n + l.servings, 0);
  for (const ex of extras) {
    const eligible = new Map((ranked.get(ex.id) ?? []).map((s, i) => [s.recipient.id, { s, i }]));
    const takers = base.offers.filter((o) => eligible.has(o.recipientId));
    if (!takers.length) {
      // nobody getting meals can take it: place it by room like an extras-only listing
      const alone = allocateByRoom([ex], ranked, capLeft);
      for (const o of alone.offers) {
        const cur = byRecipient.get(o.recipientId);
        if (cur) cur.lines.push(...o.lines); else byRecipient.set(o.recipientId, o);
      }
      unallocated.push(...alone.unallocated);
      continue;
    }
    const total = takers.reduce((n, o) => n + mealsOf(o), 0);
    let left = ex.servings;
    const shares = takers.map((o) => ({ o, give: Math.floor((ex.servings * mealsOf(o)) / total) }));
    for (const sh of shares) left -= sh.give;
    shares.sort((a, b) => mealsOf(b.o) - mealsOf(a.o));
    for (let i = 0; left > 0; i = (i + 1) % shares.length) { shares[i].give++; left--; }   // remainder to the biggest shares
    for (const { o, give } of shares) {
      if (give <= 0) continue;
      o.lines.push({ itemId: ex.id, servings: give });
      o.arriveBy = Math.max(o.arriveBy, eligible.get(o.recipientId)!.s.leg.arrival);
    }
  }
  return { offers: [...byRecipient.values()].sort((a, b) => a.rank - b.rank), unallocated };
}

function allocateByRoom(items: Item[], ranked: Map<string, Scored[]>, capLeft: Map<string, number>): Allocation {
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
