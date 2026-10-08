import { TRIP_CONFIG as C } from "../trips/config.ts";
import { event } from "../trips/engine.ts";
import { trips, type TripRepository } from "../trips/repository.ts";
import type { DeliveryTrip, NgoOfferCandidate } from "../trips/types.ts";

/** Spec §12.2: safety minutes / 6, clamped to two–ten minutes. Absolute server deadline. */
export function offerWindowMs(safeUntil: number, now: number) {
  return Math.max(C.ngoOfferMinMs, Math.min(C.ngoOfferMaxMs, (safeUntil - now) / C.ngoOfferSafetyDivisor));
}
export function startNgoOffer(t: DeliveryTrip, remaining: NgoOfferCandidate[], readyFrom: number, now: number, partnerPhones: string[] = []) {
  if (t.shareAcceptedAt || t.closedAt || t.offer) throw new Error("This leg is not waiting for an NGO offer.");
  t.offer = { sentAt: now, deadline: now + offerWindowMs(t.safeUntil, now), remindedAt: null, readyFrom,
    status: "pending", remaining: structuredClone(remaining), history: [], partnerPhones };
  event(t, "offer.sent", `Food offered to ${t.drop.name}. Reply by ${offerTime(t.offer.deadline)}.`, now);
}
export function assertOfferOpen(t: DeliveryTrip, now: number) {
  if (!t.offer || t.offer.status !== "pending" || now >= t.offer.deadline) throw new Error(`Sorry, this offer ended${t.offer ? ` at ${offerTime(t.offer.deadline)}` : ""} and is being offered to the next eligible NGO.`);
}
/** One persisted CAS transition releases the old reservation and offers the next candidate. */
export function advanceNgoOffer(t: DeliveryTrip, now: number) {
  const o = t.offer;
  if (!o || o.status !== "pending" || t.shareAcceptedAt || t.closedAt) return false;
  if (now < o.deadline) {
    if (!o.remindedAt && now >= o.sentAt + (o.deadline - o.sentAt) / 2) {
      o.remindedAt = now;
      event(t, "offer.reminder", `${t.drop.name}: please reply before ${offerTime(o.deadline)}.`, now);
      return true;
    }
    return false;
  }
  const oldName = t.drop.name;
  o.history.push({ phone: t.ngoPhone, name: oldName, deadline: o.deadline, at: now, reason: "TIMEOUT" });
  event(t, "offer.expired", `${oldName} did not reply before the deadline (TIMEOUT). Its food reservation was released.`, now);
  const candidate = o.remaining.shift();
  if (!candidate || now >= t.collectBy || Math.max(now, o.readyFrom) + 45 * 60_000 > t.safeUntil) {
    o.status = "exhausted"; o.remaining = [];
    event(t, "offer.exhausted", "No remaining NGO offer fits the safety and pickup deadlines. The Decision Agent needs to re-plan this food.", now);
    return true;
  }
  t.ngoPhone = candidate.phone; t.drop = candidate.drop;
  o.partnerPhones = candidate.partnerPhones ?? [];
  t.shareId = `${t.shareId.split("_offer_")[0]}_offer_${o.history.length + 1}`;
  t.routeRevision++; t.routeChangedAt = now;
  o.sentAt = now; o.deadline = now + offerWindowMs(t.safeUntil, now); o.remindedAt = null;
  event(t, "offer.sent", `${oldName} did not reply. Asking ${candidate.drop.name} next; reply by ${offerTime(o.deadline)}.`, now);
  return true;
}
/** Deadlines are stored with the trip, so ticks resume after a database-backed API restart. */
export async function tickNgoOffers(now = Date.now(), repository: TripRepository = trips) {
  for (const snapshot of await repository.list()) {
    if (snapshot.offer?.status !== "pending" || snapshot.shareAcceptedAt) continue;
    for (let attempt = 0; attempt < C.casRetries; attempt++) {
      const t = await repository.get(snapshot.id); if (!t) break;
      const version = t.version;
      if (!advanceNgoOffer(t, now)) break;
      t.version++;
      if (await repository.save(t, version)) break;
    }
  }
}
const offerTime = (at: number) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(at);
