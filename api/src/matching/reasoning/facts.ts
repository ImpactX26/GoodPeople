/**
 * The facts a reasoning call sees, kept small (Groq's free tier counts tokens): times as clock + minutes,
 * names instead of ids in anything the model writes about, and only the fields a decision turns on.
 */
import { distanceKm, round1 } from "../engine/geo.ts";
import { itemName } from "../engine/reasons.ts";
import { effectiveGrade, isUnsure, safeUntil } from "../engine/safety.ts";
import { reliabilityLine } from "../reliability.ts";
import { foodOf, safeUntilOf, servingsOf } from "../runtime.ts";
import { areaById } from "../seed.ts";
import type { MatchingStore } from "../store.ts";
import { fmtTime } from "../time.ts";
import type { Listing, Partner, Recipient, Share } from "../types.ts";

const mins = (ms: number) => Math.round(ms / 60_000);

/** "9:55 pm (in 40 min)" / "8:10 pm (25 min ago)". */
export const when = (t: number, now: number) => (t >= now ? `${fmtTime(t)} (in ${mins(t - now)} min)` : `${fmtTime(t)} (${mins(now - t)} min ago)`);

const STORAGE = { room: "room temperature", fridge: "in a fridge", hot: "kept hot" } as const;

export function foodFacts(l: Listing, now: number) {
  return {
    restaurant: l.donorName,
    area: areaById(l.areaId)?.name ?? l.areaId,
    listed: when(l.createdAt, now),
    cooked: l.cookedAt ? when(l.cookedAt, now) : "not given",
    storage: STORAGE[l.storage],
    collectBy: when(l.collectBy, now),
    notes: l.pickupNotes,
    items: l.items.map((i) => ({
      name: itemName(i),
      servings: i.servings,
      amount: i.quantity ? `${i.quantity.amount} ${i.quantity.unit}` : undefined,
      kind: i.category,
      grade: effectiveGrade(i),
      gradeFromChecker: effectiveGrade(i) !== i.grade ? i.grade : undefined,
      safeUntil: when(safeUntil(i, l.createdAt), now),
      checkerConfidence: `${i.confidence}%`,
      unsure: isUnsure(i) || undefined,
      diet: i.diet,
      halal: i.halal || undefined,
      allergens: i.allergens,
      tags: i.tags,
    })),
  };
}

export async function ngoFacts(store: MatchingStore, r: Recipient, l: Listing, now: number, arriveBy?: number) {
  const past = await store.list("share", { ngoId: r.id });
  const fb = { fewer: 0, right: 0, more: 0 };
  for (const s of past) if (s.feedback) fb[s.feedback]++;
  const fed = fb.fewer + fb.right + fb.more;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind.replace(/_/g, " "),
    area: areaById(r.areaId)?.name ?? r.areaId,
    kmFromPickup: round1(distanceKm(l, r)),
    arrives: arriveBy ? when(arriveBy, now) : undefined,
    serves: r.servingTimes.length ? `at ${r.servingTimes.join(", ")}` : `within ${r.servesWithinMin} min of arrival`,
    receivingHours: r.receivingHours ? `${r.receivingHours.start}–${r.receivingHours.end}` : undefined,
    vulnerableGroup: r.vulnerable || undefined,
    fridge: r.fridge,
    takesPerDelivery: r.capacityPerDelivery,
    diets: r.acceptsDiet.join("/"),
    halalOnly: r.halalOnly || undefined,
    avoids: r.avoidAllergens.length ? r.avoidAllergens : undefined,
    pastFeedback: fed ? `fed fewer ${fb.fewer}×, about right ${fb.right}×, more ${fb.more}×` : "none yet",
    deliveriesLast24h: past.filter((s) => s.status === "delivered" && now - s.createdAt < 24 * 60 * 60_000).length,
  };
}

export function partnerFacts(p: Partner, l: Listing, ngoNames: Map<string, string>) {
  return {
    id: p.id,
    name: p.name,
    travel: p.travel.replace(/_/g, " "),
    kmFromPickup: round1(distanceKm(p, l)),
    ridesFor: p.ngoId ? ngoNames.get(p.ngoId) ?? "an NGO" : "independent",
    reliability: reliabilityLine(p.reliability),
    online: p.online,
  };
}

export function shareFacts(s: Share, l: Listing, names: Map<string, string>, now: number) {
  const untried = s.candidates.filter((c) => c.ngoId !== s.ngoId && !s.triedNgoIds.includes(c.ngoId));
  return {
    id: s.id,
    status: s.status.replace(/_/g, " "),
    food: `${servingsOf(s.lines)} servings of ${foodOf(l, s.lines)}`,
    safeUntil: when(safeUntilOf(l, s.lines), now),
    ngo: s.ngoId ? names.get(s.ngoId) : undefined,
    offerClosesIn: s.status === "offering" && s.offerDeadlineAt ? `${Math.max(0, mins(s.offerDeadlineAt - now))} min` : undefined,
    backupsInOrder: untried.map((c) => ({ id: c.ngoId, name: names.get(c.ngoId), arrives: when(c.arriveBy, now) })),
    alreadyPassed: s.triedNgoIds.map((id) => names.get(id) ?? id),
    partner: s.partnerId ? names.get(s.partnerId) : undefined,
    pickupPromised: s.promisedPickupAt ? when(s.promisedPickupAt, now) : undefined,
    arrivalPromised: s.promisedArrival ? when(s.promisedArrival, now) : undefined,
    lateBy: s.lateNoticeMin ? `${s.lateNoticeMin} min` : undefined,
    pickedUp: s.pickedUpAt ? when(s.pickedUpAt, now) : undefined,
    waitingForPartner: s.waitingForPartnerSince ? `${mins(now - s.waitingForPartnerSince)} min` : undefined,
  };
}

/** The rules' own words for this case, oldest first. NGOs filtered out are summarised, not listed. */
export async function ruleLog(store: MatchingStore, listingId: string, n = 14) {
  const all = (await store.list("decision", { listingId })).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  const filtered = all.filter((d) => d.kind === "filtered");
  const rest = all.filter((d) => d.kind !== "filtered").slice(-n).map((d) => `${d.agent ?? "agent"} · ${d.kind}: ${d.reason}`);
  return { filteredOut: filtered.slice(0, 6).map((d) => d.reason).concat(filtered.length > 6 ? [`…and ${filtered.length - 6} more`] : []), log: rest };
}

/** Names for every NGO and partner, for turning ids into words. */
export async function namesOf(store: MatchingStore) {
  const names = new Map<string, string>();
  for (const r of await store.list("recipient")) names.set(r.id, r.name);
  for (const p of await store.list("partner")) names.set(p.id, p.name);
  return names;
}
