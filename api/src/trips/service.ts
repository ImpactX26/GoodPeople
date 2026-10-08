import { createHash } from "node:crypto";
import type { Session } from "../store.ts";
import { TRIP_CONFIG as C } from "./config.ts";
import { canView, event, locationVisible, pickupStage, present } from "./engine.ts";
import { project } from "./geo.ts";
import { trips, type TripRepository } from "./repository.ts";
import { routeFor } from "./routing.ts";
import type { DeliveryTrip, TripPoint } from "./types.ts";

export class TripError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 503;
  constructor(message: string, status: 400 | 401 | 403 | 404 | 409 | 503 = 409) { super(message); this.status = status; }
}
export async function authorized(id: string, s: Session, repository = trips) {
  const t = await repository.get(id);
  if (!t || !canView(t, s)) throw new TripError("Delivery not found.", 404);
  return t;
}
/** CAS persists the event and idempotency receipt together. Failed code attempts must also commit. */
export async function mutate(id: string, s: Session, key: string, body: unknown,
  action: (t: DeliveryTrip) => { error?: string | null; points?: TripPoint[] } | void, repository: TripRepository = trips) {
  if (!key || key.length > 200) throw new TripError("An Idempotency-Key is required.", 400);
  const receiptKey = createHash("sha256").update(`${s.role}:${s.phone}:${key}`).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  for (let attempt = 0; attempt < C.casRetries; attempt++) {
    const t = await authorized(id, s, repository), old = t.receipts[receiptKey];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new TripError("This action key was already used for a different request.");
      if (old.error) throw new TripError(old.error);
      return t;
    }
    const result = action(t), version = t.version;
    t.version++;
    t.receipts[receiptKey] = { fingerprint, error: result?.error ?? null };
    if (Object.keys(t.receipts).length > C.maxReceipts) delete t.receipts[Object.keys(t.receipts)[0]];
    if (!await repository.save(t, version, result?.points)) continue;
    if (result?.error) throw new TripError(result.error);
    return t;
  }
  throw new TripError("Delivery changed while you were acting. Please try again.");
}
export async function view(t: DeliveryTrip, s: Session, now: number) {
  let v = present(t, s, now);
  if (!v.pickup || !v.drop || t.closedAt) return v;
  const preview = t.requestStatus !== "accepted" || !t.location || ["at_pickup", "picked_up"].includes(t.status);
  if (preview) {
    if (s.role === "donor" && t.pickedUpAt && now > t.pickedUpAt + C.donorTrackAfterPickupMs) return v;
    const entry = await routeFor(t, now, true);
    const fresh = await trips.get(t.id);
    if (!fresh || !canView(fresh, s)) throw new TripError("Delivery not found.", 404);
    v = present(fresh, s, Date.now());
    if (fresh.status === t.status && fresh.routeRevision === t.routeRevision && v.pickup && v.drop && !fresh.closedAt) { v.route = entry.route; v.routeError = entry.error; }
    return v;
  }
  if (!locationVisible(t, s, now) || ["at_drop", "held"].includes(t.status)) return v;
  const entry = await routeFor(t, now);
  now = Date.now();
  // A route computed before a concurrent pickup/drop must never be attached to the new stage.
  const fresh = await trips.get(t.id);
  if (!fresh || !canView(fresh, s)) throw new TripError("Delivery not found.", 404);
  if (!locationVisible(fresh, s, now) || fresh.status !== t.status || (fresh.routeRevision ?? 1) !== (t.routeRevision ?? 1)) return present(fresh, s, now);
  if (entry.route && !entry.error && fresh.status !== "held") {
    const route = entry.route;
    const progress = project(fresh.location!, route.path);
    const remaining = Math.max(0, 1 - progress.progressM / Math.max(1, route.distanceM));
    const eta = now + route.durationS * remaining * 1000;
    const needsEta = !fresh.eta || Math.abs(eta - fresh.eta) >= C.etaChangeMs;
    const kind = pickupStage(fresh) ? "pickup" : "drop";
    const near = eta - now <= (kind === "pickup" ? C.nearPickupMs : C.nearDropMs);
    const offRoute = progress.distanceM > C.offRouteM;
    const unsafe = eta > fresh.safeUntil || !!(fresh.pickedUpAt && fresh.maxTransitMin && eta - fresh.pickedUpAt > fresh.maxTransitMin * 60_000);
    const unseen = (type: string) => !fresh.events.some(e => e.type === type);
    if (needsEta || near && unseen(`partner.near_${kind}`) || offRoute && unseen("partner.off_route") || unsafe && unseen("trip.safety_at_risk")) {
      t = await mutate(fresh.id, s, `route:${route.computedAt}:${fresh.version}`, { kind, eta }, next => {
        if (next.closedAt || next.status !== fresh.status || (next.routeRevision ?? 1) !== (fresh.routeRevision ?? 1)) return;
        if (needsEta) { next.eta = eta; event(next, "trip.eta_changed", route.provider === "google" ? "The arrival estimate has been updated for the current route and traffic." : "The sample arrival estimate has been updated. Live traffic is not included.", now); }
        if (near) event(next, `partner.near_${kind}`, `${next.partnerName} is about ${kind === "pickup" ? 10 : 5} minutes away.`, now, true);
        if (offRoute) event(next, "partner.off_route", "The delivery partner has left the route. Directions are being recalculated.", now, true);
        if (unsafe) {
          event(next, "trip.safety_at_risk", "This route may miss the food's safe-until time. A nearer destination needs to be reviewed.", now, true);
          event(next, "escalation.opened", "Traffic or transit time threatens food safety. Review this delivery now.", now, true);
        }
      });
      v = present(t, s, now);
    } else v = present(fresh, s, now);
  } else v = present(fresh, s, now);
  if (v.locationVisible && v.routeRevision === (fresh.routeRevision ?? 1) && v.status === fresh.status) { v.route = entry.route; v.routeError = entry.error; }
  return v;
}
